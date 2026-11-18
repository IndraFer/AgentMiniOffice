import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hashToken } from "./auth";
import type { Db } from "./db";
import { uuidv7 } from "./uuid";

/**
 * Server side sessions. The cookie holds an opaque random token, the database holds its hash, so
 * a leaked database does not hand out live sessions.
 */

export const SESSION_COOKIE = "amo_session";

export interface MemberSession {
  sessionId: string;
  memberId: string;
  orgId: string;
  email: string;
  displayName: string;
  role: string;
}

interface SessionRow {
  id: string;
  member_id: string;
  org_id: string;
  email: string;
  display_name: string;
  role: string;
}

export function createSession(db: Db, memberId: string, orgId: string, ttlMs: number): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, member_id, org_id, token_hash, created_at, last_used_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    uuidv7(),
    memberId,
    orgId,
    hashToken(token),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    new Date(now + ttlMs).toISOString(),
  );
  return token;
}

export function readSession(db: Db, token: string | undefined): MemberSession | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id AS id, s.member_id AS member_id, s.org_id AS org_id,
              m.email AS email, m.display_name AS display_name, m.role AS role
         FROM sessions s JOIN members m ON m.id = s.member_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get<SessionRow>(hashToken(token), new Date().toISOString());

  if (!row) return null;

  db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id,
  );
  db.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.member_id,
  );

  return {
    sessionId: row.id,
    memberId: row.member_id,
    orgId: row.org_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

export function revokeSession(db: Db, sessionId: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    sessionId,
  );
}

export function sessionFromRequest(c: Context, db: Db): MemberSession | null {
  return readSession(db, getCookie(c, SESSION_COOKIE));
}

export function setSessionCookie(c: Context, token: string, ttlMs: number, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
}

export function canWrite(role: string): boolean {
  return role === "owner" || role === "admin";
}
