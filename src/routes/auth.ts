import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../lib/db";
import { fail, isPlainObject, text } from "../lib/http";
import { officeDisplayName, officeNameError } from "../lib/officeName";
import { hashPassword, verifyPassword } from "../lib/passwords";
import {
  clearSessionCookie,
  createSession,
  revokeSession,
  sessionFromRequest,
  setSessionCookie,
} from "../lib/sessions";
import { uuidv7 } from "../lib/uuid";

/**
 * Login throttle, adapted from the pattern in the reference project: after a few failures each
 * further attempt from the same address waits longer. In memory is enough for one process, and a
 * restart clearing it is acceptable.
 */
interface Attempt {
  failures: number;
  nextAt: number;
}

const attempts = new Map<string, Attempt>();
const FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60_000;

function throttleKey(c: Context, email: string): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || c.req.header("cf-connecting-ip") || "local";
  return `${address}:${email}`;
}

function waitFor(key: string): number {
  const attempt = attempts.get(key);
  if (!attempt) return 0;
  return Math.max(0, attempt.nextAt - Date.now());
}

function recordFailure(key: string): void {
  const attempt = attempts.get(key) ?? { failures: 0, nextAt: 0 };
  attempt.failures += 1;

  // The fifth failure arms a wait, so the sixth attempt is the first one refused.
  if (attempt.failures >= FREE_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt.failures - FREE_ATTEMPTS), MAX_DELAY_MS);
    attempt.nextAt = Date.now() + delay;
  }
  attempts.set(key, attempt);
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

export interface AuthContext {
  db: Db;
  sessionTtlMs: number;
  secureCookies: boolean;
  allowRegistration: boolean;
}

interface MemberRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  role: string;
  password_hash: string | null;
}

interface NewAccount {
  email: string;
  password: string;
  displayName: string;
  officeName: unknown;
  slug?: string;
  role?: string;
}

type AccountResult =
  | {
      ok: true;
      orgId: string;
      memberId: string;
      slug: string;
      displayName: string;
      officeName: string;
    }
  | { ok: false; status: 400 | 409; message: string };

function orgOf(db: Db, orgId: string): { slug: string; name: string } | null {
  return (
    db
      .prepare("SELECT slug, name FROM organizations WHERE id = ?")
      .get<{ slug: string; name: string }>(orgId) ?? null
  );
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "office"
  );
}

export function memberCount(db: Db): number {
  const row = db.prepare("SELECT count(*) AS n FROM members").get<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Create an office together with its first member. Used by setup and by self registration. */
function createAccount(db: Db, input: NewAccount): AccountResult {
  if (!input.email.includes("@")) {
    return { ok: false, status: 400, message: "a valid email is required" };
  }
  if (input.password.length < 10) {
    return { ok: false, status: 400, message: "password must be at least 10 characters" };
  }
  const officeName = officeDisplayName(input.officeName);
  if (!officeName) return { ok: false, status: 400, message: officeNameError };
  if (!input.displayName) {
    return { ok: false, status: 400, message: "name and office are required" };
  }

  // One email, one account. A users table split is a later migration.
  if (db.prepare("SELECT id FROM members WHERE email = ?").get(input.email)) {
    return { ok: false, status: 409, message: "that email already has an account" };
  }

  const now = new Date().toISOString();
  const orgId = uuidv7();
  const memberId = uuidv7();

  let slug = input.slug ? slugify(input.slug) : slugify(officeName);
  if (db.prepare("SELECT id FROM organizations WHERE slug = ?").get(slug)) {
    slug = `${slug}-${slugify(input.email.split("@")[0] ?? "office")}`.slice(0, 60);
  }
  if (db.prepare("SELECT id FROM organizations WHERE slug = ?").get(slug)) {
    return { ok: false, status: 409, message: "that office name is taken, try another" };
  }

  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)").run(
      orgId,
      officeName,
      slug,
      now,
    );
    db.prepare(
      `INSERT INTO members (id, org_id, email, display_name, role, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      memberId,
      orgId,
      input.email,
      input.displayName,
      input.role ?? "owner",
      hashPassword(input.password),
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("could not create the account", error);
    return { ok: false, status: 409, message: "could not create the account" };
  }

  return { ok: true, orgId, memberId, slug, displayName: input.displayName, officeName };
}

export function authRoutes({
  db,
  sessionTtlMs,
  secureCookies,
  allowRegistration,
}: AuthContext): Hono {
  const app = new Hono();

  const signIn = (c: Context, member: MemberRow) => {
    const token = createSession(db, member.id, member.org_id, sessionTtlMs);
    setSessionCookie(c, token, sessionTtlMs, secureCookies);
    return c.json({
      member: {
        email: member.email,
        display_name: member.display_name,
        role: member.role,
      },
      office: orgOf(db, member.org_id),
    });
  };

  app.post(
    "/auth/login",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => fail(c, 413, "payload_too_large", "login body exceeds 4 KB"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      if (!isPlainObject(body)) return fail(c, 400, "validation_failed", "body must be JSON");

      const email = text(body.email, 200)?.toLowerCase();
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || password.length === 0) {
        return fail(c, 400, "validation_failed", "email and password are required");
      }

      const member = db
        .prepare(
          `SELECT id, org_id, email, display_name, role, password_hash
             FROM members WHERE email = ? ORDER BY created_at LIMIT 1`,
        )
        .get<MemberRow>(email);

      const key = throttleKey(c, email);
      const wait = waitFor(key);
      if (wait > 0) {
        c.header("retry-after", String(Math.ceil(wait / 1000)));
        return fail(
          c,
          429,
          "rate_limited",
          `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`,
        );
      }

      // Same answer for unknown email and wrong password, so the endpoint cannot be used to
      // enumerate accounts.
      if (!member || !verifyPassword(password, member.password_hash)) {
        recordFailure(key);
        return fail(c, 401, "unauthorized", "email or password is wrong");
      }

      clearFailures(key);
      return signIn(c, member);
    },
  );

  app.post("/auth/logout", (c) => {
    const session = sessionFromRequest(c, db);
    if (session) revokeSession(db, session.sessionId);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => {
    const session = sessionFromRequest(c, db);
    if (!session) return fail(c, 401, "unauthorized", "not signed in");
    return c.json({
      member: {
        email: session.email,
        display_name: session.displayName,
        role: session.role,
      },
      office: orgOf(db, session.orgId),
    });
  });

  /**
   * First run bootstrap. Allowed only while the instance has no members at all, which makes it a
   * one shot: after the first admin exists this endpoint is permanently closed.
   */
  app.post("/setup", async (c) => {
    if (memberCount(db) > 0) {
      return fail(c, 403, "forbidden", "this instance already has an account. sign in instead.");
    }

    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body)) return fail(c, 400, "validation_failed", "body must be JSON");

    const created = createAccount(db, {
      email: text(body.email, 200)?.toLowerCase() ?? "",
      password: typeof body.password === "string" ? body.password : "",
      displayName: text(body.name, 80) ?? "",
      officeName: body.office,
      role: "owner",
    });

    if (!created.ok) {
      return fail(
        c,
        created.status,
        created.status === 409 ? "conflict" : "validation_failed",
        created.message,
      );
    }

    const token = createSession(db, created.memberId, created.orgId, sessionTtlMs);
    setSessionCookie(c, token, sessionTtlMs, secureCookies);

    return c.json(
      {
        member: {
          email: text(body.email, 200)?.toLowerCase(),
          display_name: created.displayName,
          role: "owner",
        },
        office: { slug: created.slug, name: created.officeName },
      },
      201,
    );
  });

  /** Registration is off by default. Setup above is the only always available way in. */
  app.post("/auth/register", async (c) => {
    if (!allowRegistration) {
      return fail(c, 403, "forbidden", "registration is disabled on this instance");
    }

    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body)) return fail(c, 400, "validation_failed", "body must be JSON");

    const created = createAccount(db, {
      email: text(body.email, 200)?.toLowerCase() ?? "",
      password: typeof body.password === "string" ? body.password : "",
      displayName: text(body.name, 80) ?? "",
      officeName: body.office,
      role: "owner",
    });

    if (!created.ok) {
      return fail(
        c,
        created.status,
        created.status === 409 ? "conflict" : "validation_failed",
        created.message,
      );
    }

    const token = createSession(db, created.memberId, created.orgId, sessionTtlMs);
    setSessionCookie(c, token, sessionTtlMs, secureCookies);

    return c.json(
      {
        member: {
          email: text(body.email, 200)?.toLowerCase(),
          display_name: created.displayName,
          role: "owner",
        },
        office: { slug: created.slug, name: created.officeName },
      },
      201,
    );
  });

  return app;
}
