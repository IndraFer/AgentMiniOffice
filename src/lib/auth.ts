import { createHash } from "node:crypto";
import type { Db } from "./db";

export const AGENT_TOKEN_PREFIX = "amo_agent_";
export const WRITER_PREFIX = "amo_writer_";
export const SHARE_TOKEN_PREFIX = "amo_share_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
  return value.trim() || null;
}

export interface AgentAuth {
  agentId: string;
  orgId: string;
  name: string;
  scopes: string[];
  machineSeq: number | null;
  dormantSeq: number | null;
}

/**
 * An agent token is scoped to exactly one agent id. It can never read another agent and it
 * can never open the panel.
 */
export function verifyAgentToken(db: Db, agentId: string, token: string, heartbeat = false): AgentAuth | null {
  const machine = token.startsWith(WRITER_PREFIX);
  if (!machine && !token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const hash = hashToken(token);
  const row = db
    .prepare(
      `SELECT a.org_id, a.name, t.scopes, s.last_seq, d.last_seq AS dormant_seq
         FROM agent_tokens t JOIN agents a ON a.id=t.agent_id AND t.org_id=a.org_id
         JOIN organizations o ON o.id=a.org_id AND o.archived_at IS NULL
         LEFT JOIN dormant_dedicated d ON d.agent_id=a.id
         LEFT JOIN machine_sessions s ON s.agent_id=a.id
         LEFT JOIN machine_producers p ON p.id=s.producer_id AND p.org_id=a.org_id
        WHERE t.agent_id=? AND t.token_hash=? AND t.revoked_at IS NULL AND (a.archived_at IS NULL OR (?=1 AND d.agent_id IS NOT NULL))
          AND ((?=0 AND s.agent_id IS NULL) OR (?=1 AND t.id=s.writer_id AND s.expires_ms>?
               AND p.id IS NOT NULL AND p.revoked_at IS NULL))`,
    )
    .get<{ org_id: string; name: string; scopes: string; last_seq: number | null; dormant_seq:number|null }>(
      agentId,
      hash,
      Number(heartbeat && !machine),
      Number(machine),
      Number(machine),
      Date.now(),
    );
  if (!row) return null;

  db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE agent_id = ? AND token_hash = ?").run(
    new Date().toISOString(),
    agentId,
    hash,
  );

  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
    return null;
  }
  if (!Array.isArray(scopes)) return null;
  return { agentId, orgId: row.org_id, name: row.name, scopes, machineSeq: row.last_seq, dormantSeq: row.dormant_seq };
}

export interface ShareAuth {
  orgId: string;
  scope: Record<string, unknown>;
}

/** Read only, scoped to one organization, expiring, revocable. Never writes anything. */
export function verifyShareToken(db: Db, token: string): ShareAuth | null {
  if (!token.startsWith(SHARE_TOKEN_PREFIX)) return null;
  const row = db
    .prepare(
      `SELECT org_id, scope FROM share_links
        WHERE token_hash = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get<{ org_id: string; scope: string }>(hashToken(token), new Date().toISOString());
  if (!row) return null;

  let scope: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.scope);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      scope = parsed as Record<string, unknown>;
    }
  } catch {
    scope = {};
  }

  return { orgId: row.org_id, scope };
}
