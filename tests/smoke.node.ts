/**
 * Node smoke test. Run with `bun run test:node` (which uses tsx).
 *
 * `bun test` proves nothing about Node, because it never loads node:sqlite. This script is
 * the actual evidence that the dual runtime target holds.
 */
import path from "node:path";
import { createApp } from "../src/app";
import { AGENT_TOKEN_PREFIX, hashToken, SHARE_TOKEN_PREFIX } from "../src/lib/auth";
import { openDb } from "../src/lib/db";
import { applySchema } from "../src/lib/schema";
import { PresenceStore } from "../src/lib/state";
import { uuidv7 } from "../src/lib/uuid";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const db = await openDb(":memory:");
check(db.driver === "node:sqlite", `expected node:sqlite under Node, got ${db.driver}`);
applySchema(db, path.resolve("docs/SCHEMA.sql"));

const orgId = uuidv7();
const agentId = uuidv7();
const agentToken = `${AGENT_TOKEN_PREFIX}node-smoke-token`;
const shareToken = `${SHARE_TOKEN_PREFIX}node-smoke-share`;
const now = new Date().toISOString();

db.prepare("INSERT INTO organizations (id,name,slug,created_at) VALUES (?,?,?,?)").run(
  orgId,
  "Node Smoke",
  "node-smoke",
  now,
);
db.prepare("INSERT INTO agents (id,org_id,name,kind,created_at) VALUES (?,?,?,?,?)").run(
  agentId,
  orgId,
  "pi-node",
  "pi",
  now,
);
db.prepare(
  "INSERT INTO agent_tokens (id,agent_id,org_id,token_hash,prefix,created_at) VALUES (?,?,?,?,?,?)",
).run(uuidv7(), agentId, orgId, hashToken(agentToken), agentToken.slice(0, 8), now);
db.prepare(
  "INSERT INTO share_links (id,org_id,label,token_hash,created_at) VALUES (?,?,?,?,?)",
).run(uuidv7(), orgId, "smoke", hashToken(shareToken), now);

const store = new PresenceStore({ onlineMs: 30_000, staleMs: 90_000, roomHysteresisMs: 0 });
const app = createApp({ db, store });

const heartbeat = await app.request(`/api/v1/agents/${agentId}/heartbeat`, {
  method: "POST",
  headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
  body: JSON.stringify({ seq: 1, state: "working", task: "node smoke" }),
});
check(heartbeat.status === 200, `heartbeat failed with ${heartbeat.status}`);

const events = await app.request(`/api/v1/agents/${agentId}/events`, {
  method: "POST",
  headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
  body: JSON.stringify({
    events: [
      {
        event_id: uuidv7(),
        seq: 2,
        type: "tool.call",
        data: { tool: "bash", duration_ms: 900, ok: true },
      },
    ],
  }),
});
check(events.status === 200, `events failed with ${events.status}`);

const snapshot = await app.request(`/api/v1/snapshot?share=${shareToken}`);
check(snapshot.status === 200, `snapshot failed with ${snapshot.status}`);
const body = (await snapshot.json()) as {
  agents: { presence: { state: string; room: string } }[];
  counters: { agents_online: number };
};
check(body.agents[0]?.presence.state === "online", "presence should be online");
check(body.agents[0]?.presence.room === "workshop", "bash should land in the workshop");
check(body.counters.agents_online === 1, "counter should show one agent online");

store.flush(db);
const persisted = db
  .prepare("SELECT state, room FROM agent_presence WHERE agent_id = ?")
  .get<{ state: string; room: string }>(agentId);
check(persisted?.state === "online", "flush did not persist presence");
check(persisted?.room === "workshop", "flush did not persist the room");

const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
check(foreignKeys.length === 0, "foreign key violations after smoke run");

db.close();
console.log("node smoke ok: node:sqlite, schema, heartbeat, events, snapshot, flush");
