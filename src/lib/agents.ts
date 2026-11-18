import { randomBytes } from "node:crypto";
import { AGENT_TOKEN_PREFIX, hashToken } from "./auth";
import type { Db } from "./db";
import { uuidv7 } from "./uuid";

export type AgentLifecycle = "daemon" | "session" | "unspecified";

export function isLifecycle(value: unknown): value is AgentLifecycle {
  return value === "daemon" || value === "session" || value === "unspecified";
}

/** Existing capabilities storage keeps this addition compatible with installed databases. */
export function lifecycleOf(capabilities: string): AgentLifecycle {
  try {
    const values: unknown = JSON.parse(capabilities);
    if (!Array.isArray(values)) return "unspecified";
    const modes = ["daemon", "session"].filter((mode) => values.includes(`lifecycle:${mode}`));
    return modes.length === 1 ? (modes[0] as AgentLifecycle) : "unspecified";
  } catch {
    return "unspecified";
  }
}

export interface CreatedAgent {
  agentId: string;
  token: string;
}

export type CreateAgentResult = { agent: CreatedAgent } | { failure: string };

/**
 * Agent registration is a human action. It lives here so the CLI and the dashboard cannot drift
 * apart: same checks, same token format, same "shown exactly once" rule.
 */
export function createAgent(
  db: Db,
  orgId: string,
  input: {
    name: string;
    kind?: string;
    host?: string | null;
    project?: string | null;
    simulator?: boolean;
    lifecycle?: AgentLifecycle;
    inbox?: boolean;
  },
): CreateAgentResult {
  if (input.lifecycle !== undefined && !isLifecycle(input.lifecycle))
    return { failure: "invalid lifecycle" };
  const name = input.name.trim();
  if (name.length === 0) return { failure: "agent name is required" };
  if (name.length > 60) return { failure: "agent name is longer than 60 characters" };

  const exists = db.prepare("SELECT id FROM agents WHERE org_id = ? AND name = ?").get(orgId, name);
  if (exists) return { failure: `agent "${name}" already exists` };

  const now = new Date().toISOString();
  const agentId = uuidv7();

  db.prepare(
    `INSERT INTO agents (id, org_id, name, kind, host, project, simulator, capabilities, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    agentId,
    orgId,
    name,
    input.kind?.slice(0, 40) || "other",
    input.host ?? null,
    input.project ?? null,
    input.simulator ? 1 : 0,
    JSON.stringify(
      input.lifecycle && input.lifecycle !== "unspecified" ? [`lifecycle:${input.lifecycle}`] : [],
    ),
    now,
  );

  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO agent_tokens (id, agent_id, org_id, token_hash, prefix, label, scopes, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    uuidv7(),
    agentId,
    orgId,
    hashToken(token),
    token.slice(0, 8),
    name,
    JSON.stringify(input.inbox ? ["ingest", "inbox"] : ["ingest"]),
    now,
  );

  return { agent: { agentId, token } };
}
