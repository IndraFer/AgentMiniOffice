import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticateAgent } from "../lib/agentContext";
import { bearerToken, hashToken, WRITER_PREFIX } from "../lib/auth";
import type { Db } from "../lib/db";
import { fail, isPlainObject } from "../lib/http";
import type { Live } from "../lib/live";
import { officeJoinKey } from "../lib/officeJoinKey";
import { uuidv7 } from "../lib/uuid";
import { revokeIfLastSession, revokeProducer } from '../lib/visits';
import { requireOffice } from "./offices";

const TTL = 15 * 60_000;
const token = (prefix: string) => prefix + randomBytes(32).toString("base64url");
const bearer = (c: Context) => bearerToken(c.req.header("authorization")) ?? "";
const denied = (c: Context) =>
  fail(c, 401, "unauthorized", "credential is not valid for this operation");
const invalid = (c: Context) => fail(c, 400, "validation_failed", "invalid machine request");
const conflict = (c: Context) =>
  fail(c, 409, "conflict", "session or credential is already in use");
const full = (c: Context) => fail(c, 409, "conflict", "workspace admission limit reached");
const validWriter = (v: unknown): v is string =>
  typeof v === "string" && /^amo_writer_[A-Za-z0-9_-]{43}$/.test(v);
const validText = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  v.trim() === v &&
  !Array.from(v).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
async function json(c: Context) {
  const body: unknown = await c.req.json().catch(() => null);
  return isPlainObject(body) ? body : null;
}
function atomic(db: Db, fn: () => Response) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const response = fn();
    db.exec("COMMIT");
    return response;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
interface Producer {
  id: string;
  org_id: string;
  inbox: number;
}
function principal(db: Db, c: Context) {
  const raw = bearer(c);
  if (!raw.startsWith("amo_producer_")) return null;
  return db
    .prepare(
      `SELECT p.id,p.org_id,(p.kind='trusted' AND p.inbox=1) AS inbox FROM machine_producers p JOIN organizations o ON o.id=p.org_id AND o.archived_at IS NULL WHERE p.token_hash=? AND p.revoked_at IS NULL`,
    )
    .get<Producer>(hashToken(raw));
}
function createProducer(
  db: Db,
  c: Context,
  org: string,
  kind: "trusted" | "general",
  raw: string,
  inbox: boolean,
) {
  if (
    (db
      .prepare("SELECT COUNT(*) AS n FROM machine_producers WHERE org_id=? AND revoked_at IS NULL")
      .get<{ n: number }>(org)?.n ?? 0) >= 256
  )
    return full(c);
  const id = uuidv7();
  db.prepare(
    "INSERT INTO machine_producers(id,org_id,kind,token_hash,inbox) VALUES(?,?,?,?,?)",
  ).run(id, org, kind, hashToken(raw), Number(inbox));
  return c.json({ producer_id: id, ...(kind === "trusted" ? { token: raw } : {}) }, 201);
}
interface Session {
  agent_id: string;
  writer_id: string;
  generation: number;
  expires_ms: number;
  last_seq: number;
  token_hash: string;
  revoked_at: string | null;
  archived_at: string | null;
}
const sessionQuery = `SELECT s.*,t.token_hash,t.revoked_at,a.archived_at FROM machine_sessions s JOIN agent_tokens t ON t.id=s.writer_id JOIN agents a ON a.id=s.agent_id`;
function result(
  c: Context,
  s: Pick<Session, "agent_id" | "generation" | "expires_ms" | "last_seq">,
  inbox: number,
  status: 200 | 201 = 200,
) {
  return c.json(
    {
      agent_id: s.agent_id,
      generation: s.generation,
      expires_at: new Date(s.expires_ms).toISOString(),
      last_seq: s.last_seq,
      inbox: inbox === 1,
    },
    status,
  );
}
function owner(c: Context, db: Db) {
  const guard = requireOffice(c, db, c.req.param("slug") ?? "", true);
  if ("response" in guard) return guard.response;
  if (guard.session.role !== "owner")
    return fail(c, 403, "forbidden", "workspace credentials require an Owner");
  return guard.office.id;
}

export function machineRoutes(db: Db, live: Live) {
  const app = new Hono();
  const admin = new Hono();
  const sessions = new Hono();
  const enrollment = new Hono();
  for (const router of [admin, sessions, enrollment]) {
    router.use(
      "*",
      bodyLimit({
        maxSize: 4096,
        onError: (c) => fail(c, 413, "payload_too_large", "machine request exceeds 4 KB"),
      }),
    );
    router.use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });
  }
  admin.get("/admission", (c) => {
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    const policy = db
      .prepare("SELECT mode, join_hash IS NOT NULL AS issued FROM machine_admission WHERE org_id=?")
      .get<{ mode: string; issued: number }>(org);
    return c.json({ mode: policy?.mode ?? "closed", has_join_key: Boolean(policy?.issued) });
  });
  admin.put("/admission", async (c) => {
    const b = await json(c);
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    const mode = b?.mode;
    if (mode !== "open" && mode !== "closed") return invalid(c);
    db.prepare(
      `INSERT INTO machine_admission(org_id,mode) VALUES(?,?) ON CONFLICT(org_id) DO UPDATE SET mode=excluded.mode`,
    ).run(org, mode);
    return c.json({ mode });
  });
  admin.get("/join-key", (c) => {
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    const row = db
      .prepare(
        `SELECT m.join_hash, n.nonce FROM machine_admission m LEFT JOIN machine_join_nonces n ON n.org_id=m.org_id WHERE m.org_id=?`,
      )
      .get<{ join_hash: string | null; nonce: string | null }>(org);
    if (!row?.join_hash) return fail(c, 404, "not_found", "No office key yet. Choose Issue Key.");
    if (!row.nonce)
      return fail(
        c,
        409,
        "conflict",
        "This older key was stored only as a hash. Rotate it once to enable viewing.",
      );
    try {
      const key = officeJoinKey(db, org, row.nonce, false);
      if (hashToken(key) === row.join_hash) return c.json({ token: key });
    } catch {
      /* A missing or unreadable installation secret must never rotate a key on read. */
    }
    return fail(
      c,
      409,
      "conflict",
      "Restore the server join-secret file to view this key, or explicitly rotate it.",
    );
  });
  admin.post("/join-key", (c) => {
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    const nonce = randomBytes(32).toString("hex");
    const raw = officeJoinKey(db, org, nonce, true);
    return atomic(db, () => {
      db.prepare(
        `INSERT INTO machine_admission(org_id,mode,join_hash) VALUES(?,'closed',?) ON CONFLICT(org_id) DO UPDATE SET join_hash=excluded.join_hash`,
      ).run(org, hashToken(raw));
      db.prepare(
        `INSERT INTO machine_join_nonces(org_id,nonce) VALUES(?,?) ON CONFLICT(org_id) DO UPDATE SET nonce=excluded.nonce`,
      ).run(org, nonce);
      return c.json({ token: raw }, 201);
    });
  });
  admin.post("/trusted", async (c) => {
    const b = await json(c);
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    if (!b || (b.inbox !== undefined && typeof b.inbox !== "boolean")) return invalid(c);
    return atomic(db, () =>
      createProducer(db, c, org, "trusted", token("amo_producer_"), b.inbox === true),
    );
  });
  admin.get("/producers", (c) => {
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    return c.json({
      producers: db
        .prepare(
          "SELECT id,kind,inbox FROM machine_producers WHERE org_id=? AND revoked_at IS NULL ORDER BY id",
        )
        .all(org),
    });
  });
  admin.delete("/producers/:id", (c) => {
    const org = owner(c, db);
    if (typeof org !== "string") return org;
    return revokeProducer(db,live,org,c.req.param('id'))
      ? c.body(null, 204)
      : fail(c, 404, "not_found", "no active producer with that id");
  });
  const joinOffice = (c: Context) => {
    const key = bearer(c);
    if (!key.startsWith("amo_join_")) return null;
    const slug = c.req.param("slug") ?? null;
    return db
      .prepare(
        `SELECT o.id FROM organizations o JOIN machine_admission m ON m.org_id=o.id WHERE (? IS NULL OR o.slug=?) AND o.archived_at IS NULL AND m.mode='open' AND m.join_hash=?`,
      )
      .get<{ id: string }>(slug, slug, hashToken(key));
  };
  enrollment.get("/", (c) => {
    const office = joinOffice(c);
    return office ? c.json({ office_id: office.id }) : denied(c);
  });
  const enroll = async (c: Context) => {
    const b = await json(c);
    const raw = b?.producer_token;
    const key = bearer(c);
    if (!key.startsWith("amo_join_")) return denied(c);
    if (typeof raw !== "string" || !/^amo_producer_[A-Za-z0-9_-]{43}$/.test(raw)) return invalid(c);
    return atomic(db, () => {
      const office = joinOffice(c);
      if (!office) return denied(c);
      const prev = db
        .prepare("SELECT id,org_id,kind,revoked_at FROM machine_producers WHERE token_hash=?")
        .get<{ id: string; org_id: string; kind: string; revoked_at: string | null }>(
          hashToken(raw),
        );
      if (prev)
        return prev.org_id === office.id && prev.kind === "general" && !prev.revoked_at
          ? c.json({ producer_id: prev.id })
          : denied(c);
      const response=createProducer(db, c, office.id, "general", raw, false);
      if(response.status===201 && b?.visit===true) db.prepare('INSERT INTO visit_enrollments SELECT id,? FROM machine_producers WHERE token_hash=?').run(Date.now(),hashToken(raw));
      return response;
    });
  };
  admin.post("/enroll", enroll);
  enrollment.post("/", enroll);
  app.route("/machine/enroll", enrollment);
  sessions.patch("/:id/project", async (c) => {
    const body = await json(c),
      id = c.req.param("id");
    const auth = authenticateAgent(c, db, id, "ingest");
    if ("response" in auth) return auth.response;
    if (auth.agent.machineSeq === null) return denied(c);
    const project = body?.project;
    if (!validText(project, 60)) return invalid(c);
    const org_id = auth.agent.orgId;
    if (
      db
        .prepare("UPDATE agents SET project=? WHERE id=? AND org_id=? AND project IS NOT ?")
        .run(project, id, org_id, project).changes
    )
      live?.bus.publish({ event: "project", data: { org_id, agent_id: id, project } });
    return c.json({ project });
  });
  sessions.post("/", async (c) => {
    const b = await json(c);
    if (
      !b ||
      !validWriter(b.writer_token) ||
      !validText(b.harness, 40) ||
      !validText(b.external_session_id, 128) ||
      !validText(b.name, 60) ||
      (b.project !== undefined && !validText(b.project, 60)) ||
      (b.lifecycle !== undefined && b.lifecycle !== "daemon" && b.lifecycle !== "session")
    )
      return invalid(c);
    const { writer_token: raw, harness, external_session_id: external, name } = b;
    const project = typeof b.project === "string" ? b.project : null;
    const lifecycle = b.lifecycle === "daemon" ? "daemon" : "session";
    let renamedVisit: { org_id: string; agent_id: string } | undefined;
    const response = atomic(db, () => {
      const p = principal(db, c);
      if (!p) return denied(c);
      const digest = hashToken(raw);
      const prev = db
        .prepare(`${sessionQuery} WHERE s.producer_id=? AND s.harness=? AND s.external_id=?`)
        .get<Session>(p.id, harness, external);
      if(prev && b.visit===true && !prev.revoked_at && !prev.archived_at && prev.token_hash===digest && db.prepare('SELECT 1 FROM visit_labels WHERE agent_id=?').get(prev.agent_id)) {
        prev.expires_ms=Date.now()+TTL;
        db.prepare('UPDATE machine_sessions SET expires_ms=? WHERE agent_id=?').run(prev.expires_ms,prev.agent_id);
        // Refresh only the public visit label. Keep the unique storage name, ID and project intact.
        const changed = db.prepare('UPDATE visit_labels SET name=? WHERE agent_id=? AND name<>?').run(name,prev.agent_id,name);
        if (changed.changes) renamedVisit = {org_id:p.org_id, agent_id:prev.agent_id};
        return result(c,prev,p.inbox);
      }
      if (prev)
        return !prev.revoked_at &&
          !prev.archived_at &&
          prev.token_hash === digest &&
          prev.expires_ms > Date.now()
          ? result(c, prev, p.inbox)
          : conflict(c);
      if (db.prepare("SELECT 1 FROM agent_tokens WHERE token_hash=?").get(digest))
        return conflict(c);
      if (
        (db
          .prepare("SELECT count(*) AS n FROM machine_sessions WHERE producer_id=?")
          .get<{ n: number }>(p.id)?.n ?? 0) >= 128
      )
        return full(c);
      const id = uuidv7(),
        wid = uuidv7(),
        now = new Date().toISOString(),
        expires = Date.now() + TTL;
      const display = db
        .prepare("SELECT id FROM agents WHERE org_id=? AND name=?")
        .get(p.org_id, name)
        ? `${name.slice(0, 21)} · ${id}`
        : name;
      db.prepare(
        "INSERT INTO agents(id,org_id,name,kind,project,capabilities,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        p.org_id,
        display,
        harness,
        project,
        JSON.stringify([`lifecycle:${lifecycle}`]),
        now,
      );
      db.prepare(
        "INSERT INTO agent_tokens(id,agent_id,org_id,token_hash,prefix,scopes,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        wid,
        id,
        p.org_id,
        digest,
        WRITER_PREFIX,
        JSON.stringify(p.inbox ? ["ingest", "inbox"] : ["ingest"]),
        now,
      );
      db.prepare(
        "INSERT INTO machine_sessions(agent_id,producer_id,harness,external_id,writer_id,expires_ms) VALUES(?,?,?,?,?,?)",
      ).run(id, p.id, harness, external, wid, expires);
      if(b.visit===true) db.prepare('INSERT INTO visit_labels(agent_id,name) VALUES(?,?)').run(id,name);
      return result(c, { agent_id: id, generation: 1, last_seq: 0, expires_ms: expires }, p.inbox, 201);
    });
    if (renamedVisit) live?.bus.publish({event:'roster', data:renamedVisit});
    return response;
  });
  sessions.post("/:id/resume", async (c) => {
    const b = await json(c);
    if (
      !b ||
      !validWriter(b.writer_token) ||
      !validWriter(b.next_writer_token) ||
      b.writer_token === b.next_writer_token
    )
      return invalid(c);
    const old = hashToken(b.writer_token),
      next = hashToken(b.next_writer_token);
    return atomic(db, () => {
      const p = principal(db, c);
      if (!p) return denied(c);
      const s = db
        .prepare(`${sessionQuery} WHERE s.agent_id=? AND s.producer_id=?`)
        .get<Session>(c.req.param("id"), p.id);
      if (!s || s.revoked_at || s.archived_at || s.token_hash !== old) return denied(c);
      if (db.prepare("SELECT 1 FROM agent_tokens WHERE token_hash=?").get(next)) return conflict(c);
      const expires = Date.now() + TTL;
      // Retire the old verifier. The unique hash index prevents reusing a fenced credential.
      const wid = uuidv7(),
        now = new Date().toISOString();
      db.prepare("UPDATE agent_tokens SET revoked_at=? WHERE id=?").run(now, s.writer_id);
      db.prepare(`INSERT INTO agent_tokens(id,agent_id,org_id,token_hash,prefix,scopes,created_at)
                  SELECT ?,agent_id,org_id,?,prefix,scopes,? FROM agent_tokens WHERE id=?`).run(
        wid,
        next,
        now,
        s.writer_id,
      );
      db.prepare(
        "UPDATE machine_sessions SET writer_id=?,generation=generation+1,expires_ms=? WHERE agent_id=?",
      ).run(wid, expires, s.agent_id);
      return result(c, { ...s, generation: s.generation + 1, expires_ms: expires }, p.inbox);
    });
  });
  sessions.delete("/:id", (c) =>
    atomic(db, () => {
      const p = principal(db, c);
      if (!p) return denied(c);
      const proof = c.req.header("X-Writer-Token");
      if (!validWriter(proof)) return denied(c);
      const s = db
        .prepare(
          `${sessionQuery} WHERE s.producer_id=? AND s.agent_id=? AND t.token_hash=? AND a.archived_at IS NULL`,
        )
        .get<Session>(p.id, c.req.param("id"), hashToken(proof));
      if (!s) return denied(c);
      const now = new Date().toISOString();
      db.prepare("UPDATE agents SET archived_at=? WHERE id=?").run(now, s.agent_id);
      db.prepare("UPDATE agent_tokens SET revoked_at=? WHERE id=?").run(now, s.writer_id);
      revokeIfLastSession(db,p.org_id,p.id);
      return c.body(null, 204);
    }),
  );
  app.route("/offices/:slug/machine", admin);
  app.route("/machine/sessions", sessions);
  return app;
}
