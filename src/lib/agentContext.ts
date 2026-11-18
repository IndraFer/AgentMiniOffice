import type { Context } from "hono";
import { type AgentAuth, bearerToken, verifyAgentToken } from "./auth";
import type { Db } from "./db";
import { fail } from "./http";

export type AgentContextResult = { agent: AgentAuth } | { response: Response };

/**
 * Every agent facing route goes through this. A token is valid for exactly one agent id, so
 * it can never read or write another agent's inbox.
 */
export function authenticateAgent(
  c: Context,
  db: Db,
  agentId: string,
  scope: "inbox" | "ingest",
  heartbeat = false,
): AgentContextResult {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return { response: fail(c, 401, "unauthorized", "missing bearer token") };

  const auth = verifyAgentToken(db, agentId, token, heartbeat);
  if (!auth) {
    return { response: fail(c, 401, "unauthorized", "token is not valid for this agent") };
  }
  if (!auth.scopes.includes(scope))
    return { response: fail(c, 403, "forbidden", "credential lacks the required permission") };
  return { agent: auth };
}
