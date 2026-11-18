import path from "node:path";
import { createApp } from "../src/app";
import { AGENT_TOKEN_PREFIX, hashToken, SHARE_TOKEN_PREFIX } from "../src/lib/auth";
import { type Db, openDb } from "../src/lib/db";
import { Live } from "../src/lib/live";
import { applySchema } from "../src/lib/schema";
import { DemoDriver } from "../src/lib/simulator";
import { PresenceStore } from "../src/lib/state";
import { createTask } from "../src/lib/tasks";
import { uuidv7 } from "../src/lib/uuid";

export interface TestOffice {
  db: Db;
  demo: DemoDriver;
  store: PresenceStore;
  live: Live;
  app: ReturnType<typeof createApp>;
  orgId: string;
  agentId: string;
  agentToken: string;
  shareToken: string;
  heartbeat: (body: Record<string, unknown>) => Promise<Response>;
  events: (events: unknown[]) => Promise<Response>;
  snapshot: (query?: string) => Promise<Response>;
  inbox: () => Promise<Response>;
  claim: (taskId: string, runId: string) => Promise<Response>;
  ack: (taskId: string, runId: string, result?: string) => Promise<Response>;
  fail: (taskId: string, runId: string, reason?: string) => Promise<Response>;
  addTask: (title: string, priority?: number) => string;
  startRun: (seq: number) => Promise<string>;
}

export async function createOffice(
  options: {
    roomHysteresisMs?: number;
    leaseSeconds?: number;
    retentionMinutes?: number;
    dedicatedRetentionMinutes?: number;
    publicSlugs?: string[];
    allowRegistration?: boolean;
  } = {},
): Promise<TestOffice> {
  const db = await openDb(":memory:");
  applySchema(db, path.resolve("docs/SCHEMA.sql"));

  const store = new PresenceStore({
    onlineMs: 30_000,
    staleMs: 90_000,
    roomHysteresisMs: options.roomHysteresisMs ?? 0,
  });

  const orgId = uuidv7();
  const agentId = uuidv7();
  const agentToken = `${AGENT_TOKEN_PREFIX}test-agent-token`;
  const shareToken = `${SHARE_TOKEN_PREFIX}test-share-token`;
  const now = new Date().toISOString();

  db.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)").run(
    orgId,
    "Test Office",
    "test-office",
    now,
  );
  db.prepare("INSERT INTO agents (id, org_id, name, kind, created_at) VALUES (?,?,?,?,?)").run(
    agentId,
    orgId,
    "pi-test",
    "pi",
    now,
  );
  db.prepare(
    `INSERT INTO agent_tokens (id, agent_id, org_id, token_hash, prefix, scopes, created_at)
     VALUES (?,?,?,?,?,'["ingest","inbox"]',?)`,
  ).run(uuidv7(), agentId, orgId, hashToken(agentToken), agentToken.slice(0, 8), now);
  db.prepare(
    `INSERT INTO share_links (id, org_id, label, token_hash, created_at) VALUES (?,?,?,?,?)`,
  ).run(uuidv7(), orgId, "test", hashToken(shareToken), now);

  const live = new Live(db, store);
  const demo = new DemoDriver(db, live);
  const app = createApp({
    db,
    store,
    leaseSeconds: options.leaseSeconds ?? 60,
    retentionMinutes: options.retentionMinutes,
    dedicatedRetentionMinutes: options.dedicatedRetentionMinutes,
    live,
    publicSlugs: options.publicSlugs ?? [],
    allowRegistration: options.allowRegistration ?? false,
    sessionTtlMs: 30 * 86_400_000,
    demo,
  });
  demo.attach(app);

  const headers = {
    authorization: `Bearer ${agentToken}`,
    "content-type": "application/json",
  };

  return {
    db,
    store,
    live,
    demo,
    app,
    orgId,
    agentId,
    agentToken,
    shareToken,
    heartbeat: (body) =>
      Promise.resolve(
        app.request(`/api/v1/agents/${agentId}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      ),
    events: (events) =>
      Promise.resolve(
        app.request(`/api/v1/agents/${agentId}/events`, {
          method: "POST",
          headers,
          body: JSON.stringify({ events }),
        }),
      ),
    snapshot: (query = "") =>
      Promise.resolve(app.request(`/api/v1/snapshot?share=${shareToken}${query}`)),
    inbox: () => Promise.resolve(app.request(`/api/v1/agents/${agentId}/inbox`, { headers })),
    claim: (taskId, runId) =>
      Promise.resolve(
        app.request(`/api/v1/agents/${agentId}/inbox/${taskId}/claim`, {
          method: "POST",
          headers,
          body: JSON.stringify({ run_id: runId }),
        }),
      ),
    ack: (taskId, runId, result = "done") =>
      Promise.resolve(
        app.request(`/api/v1/agents/${agentId}/inbox/${taskId}/ack`, {
          method: "POST",
          headers,
          body: JSON.stringify({ run_id: runId, result }),
        }),
      ),
    fail: (taskId, runId, reason = "could not finish") =>
      Promise.resolve(
        app.request(`/api/v1/agents/${agentId}/inbox/${taskId}/fail`, {
          method: "POST",
          headers,
          body: JSON.stringify({ run_id: runId, reason }),
        }),
      ),
    addTask: (title, priority = 0) => {
      const outcome = createTask(db, orgId, agentId, title, null, priority);
      if (outcome.failure) throw new Error(outcome.failure.message);
      return outcome.task.id;
    },
    startRun: async (seq) => {
      const runId = uuidv7();
      const response = await Promise.resolve(
        app.request(`/api/v1/agents/${agentId}/events`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            events: [
              {
                event_id: uuidv7(),
                seq,
                type: "run.started",
                run_id: runId,
                data: { title: "test run" },
              },
            ],
          }),
        }),
      );
      if (response.status !== 200) {
        throw new Error(`run.started failed with ${response.status}`);
      }
      return runId;
    },
  };
}

/** A valid event with a fresh uuidv7 and a caller chosen sequence. */
export function event(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { event_id: uuidv7(), seq, type, data, ...extra };
}
