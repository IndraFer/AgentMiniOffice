/**
 * Synthetic agents, for looking at the panel before a real agent is wired up.
 *
 * Important: this goes through the real HTTP API with real agent tokens. It does not write
 * presence into the database directly, so it exercises ingest, the room reducer, the
 * hysteresis, the task inbox with its lease, and the sweeper exactly like a real agent.
 *
 * The agents it creates have simulator = 1 and the panel labels them "demo".
 *
 *   bun run demo
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { AGENT_TOKEN_PREFIX, hashToken, SHARE_TOKEN_PREFIX } from "../src/lib/auth";
import { config } from "../src/lib/config";
import { openDb } from "../src/lib/db";
import { applySchema } from "../src/lib/schema";
import { createTask, pendingCount } from "../src/lib/tasks";
import { uuidv7 } from "../src/lib/uuid";

const BASE = (process.env.MINIOFFICE_URL ?? `http://${config.host}:${config.port}`).replace(
  /\/$/,
  "",
);
const TICK_MS = 1500;
const HOLD_TASK_MS = 5000;

interface Step {
  type: string;
  data: Record<string, unknown>;
}

interface Persona {
  name: string;
  kind: string;
  host: string;
  project: string;
  tasks: string[];
  cycle: Step[];
}

const PERSONAS: Persona[] = [
  {
    name: "demo-pi-dashboard",
    kind: "pi",
    host: "macbook",
    project: "dashboard",
    tasks: ["build the room grid", "wire the detail panel", "fix chip truncation"],
    cycle: [
      { type: "tool.call", data: { tool: "bash", action: "use_tools", duration_ms: 1200, ok: true } },
      { type: "plan.start", data: { kind: "design", topic: "panel layout" } },
      { type: "plan.end", data: {} },
      { type: "tool.call", data: { tool: "write", action: "write" } },
    ],
  },
  {
    name: "demo-hermes-backup",
    kind: "hermes",
    host: "homelab",
    project: "ops",
    tasks: ["rotate homelab backups", "check disk pressure", "read incident notes"],
    cycle: [
      { type: "plan.start", data: { kind: "research", topic: "backup retention" } },
      { type: "tool.call", data: { tool: "bash", action: "use_tools", duration_ms: 2400, ok: true } },
      { type: "tool.call", data: { tool: "read", action: "read" } },
    ],
  },
  {
    name: "demo-codex-billing",
    kind: "codex",
    host: "macbook",
    project: "billing",
    tasks: ["read billing schema", "draft migration", "ask about rounding rule"],
    cycle: [
      { type: "plan.start", data: { kind: "read", topic: "schema.sql" } },
      { type: "tool.call", data: { tool: "grep", action: "search_content" } },
      { type: "human.waiting", data: { kind: "select", options: ["select"] } },
      { type: "human.resumed", data: {} },
    ],
  },
];

fs.mkdirSync(config.dataDir, { recursive: true });
const db = await openDb(config.dbFile);
applySchema(db, config.schemaFile);

interface OrgRow {
  id: string;
  name: string;
}

let org = db
  .prepare("SELECT id, name FROM organizations ORDER BY created_at LIMIT 1")
  .get<OrgRow>();

if (!org) {
  const id = uuidv7();
  db.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)").run(
    id,
    "Demo Office",
    "demo-office",
    new Date().toISOString(),
  );
  org = { id, name: "Demo Office" };
  console.log('no office existed, created "Demo Office"');
}

const orgId = org.id;

function ensureAgent(persona: Persona): { agentId: string; token: string } {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id,simulator FROM agents WHERE org_id = ? AND name = ?")
    .get<{ id: string; simulator: number }>(orgId, persona.name);
  if (existing && !existing.simulator)
    throw new Error("A demo name belongs to a registered worker");
  let agentId = existing?.id;
  if (!agentId) {
    agentId = uuidv7();
    db.prepare(
      `INSERT INTO agents (id, org_id, name, kind, host, project, simulator, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(agentId, orgId, persona.name, persona.kind, persona.host, persona.project, 1, now);
  }

  // A fresh token each run. Tokens are hashed at rest, so the previous one is unrecoverable.
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO agent_tokens (id, agent_id, org_id, token_hash, prefix, label, scopes, created_at)
     VALUES (?,?,?,?,?,?,'["ingest","inbox"]',?)`,
  ).run(uuidv7(), agentId, orgId, hashToken(token), token.slice(0, 8), "demo", now);

  return { agentId, token };
}

/** Per agent cursor, so refilling does not create the same title over and over. */
const taskCursor = new Map<string, number>();

/** Keep a small backlog so the inbox is never empty and the lease flow stays visible. */
function refillTasks(agentId: string, persona: Persona): void {
  let guard = 0;
  while (pendingCount(db, agentId) < 2 && guard < 5) {
    const cursor = taskCursor.get(agentId) ?? 0;
    const title = persona.tasks[cursor % persona.tasks.length] ?? "demo task";
    taskCursor.set(agentId, cursor + 1);

    const outcome = createTask(db, orgId, agentId, title, "seeded by the demo driver", 0);
    if (outcome.failure) break;
    guard += 1;
  }
}

const sessions = PERSONAS.map((persona) => {
  const { agentId, token } = ensureAgent(persona);
  refillTasks(agentId, persona);
  return {
    persona,
    agentId,
    token,
    runId: uuidv7(),
    seq: 0,
    tick: 0,
    warned: false,
    activeTaskId: null as string | null,
    activeSince: 0,
  };
});

const shareToken = `${SHARE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
db.prepare(
  `INSERT INTO share_links (id, org_id, label, token_hash, created_at, expires_at)
   VALUES (?,?,?,?,?,?)`,
).run(
  uuidv7(),
  orgId,
  "demo",
  hashToken(shareToken),
  new Date().toISOString(),
  new Date(Date.now() + 86_400_000).toISOString(),
);

type Session = (typeof sessions)[number];

async function call(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.ok ? await response.json().catch(() => undefined) : undefined;
    return { ok: response.ok, data };
  } catch {
    return { ok: false };
  }
}

function warnOnce(session: Session): void {
  if (session.warned) return;
  session.warned = true;
  console.log(`cannot reach ${BASE}. Is "bun run dev" running? Retrying quietly.`);
}

async function openRun(session: Session): Promise<void> {
  session.seq += 1;
  const result = await call("POST", `/api/v1/agents/${session.agentId}/events`, session.token, {
    events: [
      {
        event_id: uuidv7(),
        seq: session.seq,
        type: "run.started",
        run_id: session.runId,
        data: { title: "demo run", kind: "demo" },
      },
    ],
  });
  if (!result.ok) warnOnce(session);
}

async function beat(session: Session): Promise<void> {
  const task = session.persona.tasks[session.tick % session.persona.tasks.length] ?? "demo work";

  session.seq += 1;
  const alive = await call("POST", `/api/v1/agents/${session.agentId}/heartbeat`, session.token, {
    seq: session.seq,
    state: "working",
    task,
  });

  if (!alive.ok) {
    warnOnce(session);
    return;
  }
  session.warned = false;

  const step = session.persona.cycle[session.tick % session.persona.cycle.length];
  if (step) {
    session.seq += 1;
    await call("POST", `/api/v1/agents/${session.agentId}/events`, session.token, {
      events: [
        {
          event_id: uuidv7(),
          seq: session.seq,
          type: step.type,
          run_id: session.runId,
          data: step.data,
          room: null,
        },
      ],
    });
  }

  // Finish what we claimed a moment ago, otherwise claim the next thing.
  if (session.activeTaskId && Date.now() - session.activeSince > HOLD_TASK_MS) {
    const done = await call(
      "POST",
      `/api/v1/agents/${session.agentId}/inbox/${session.activeTaskId}/ack`,
      session.token,
      { run_id: session.runId, result: `demo: finished "${task}"` },
    );
    if (done.ok) {
      session.activeTaskId = null;
      refillTasks(session.agentId, session.persona);
    }
  } else if (!session.activeTaskId) {
    const inbox = await call("GET", `/api/v1/agents/${session.agentId}/inbox`, session.token);
    const next = (inbox.data as { tasks?: { id: string }[] } | undefined)?.tasks?.[0];
    if (next) {
      const claimed = await call(
        "POST",
        `/api/v1/agents/${session.agentId}/inbox/${next.id}/claim`,
        session.token,
        { run_id: session.runId },
      );
      if (claimed.ok) {
        session.activeTaskId = next.id;
        session.activeSince = Date.now();
      }
    }
  }

  session.tick += 1;
}

let running = true;
let inFlight = false;

for (const session of sessions) await openRun(session);

const timer = setInterval(() => {
  if (inFlight || !running) return;
  inFlight = true;
  void Promise.all(sessions.map((session) => beat(session))).finally(() => {
    inFlight = false;
  });
}, TICK_MS);

console.log(`demo drive: ${sessions.length} simulated agents against ${BASE}`);
console.log("");
console.log(`  panel    ${BASE}/?share=${shareToken}`);
console.log(`  snapshot ${BASE}/api/v1/snapshot?share=${shareToken}`);
console.log("");
console.log(
  "each agent holds a task for about 5 seconds, so you will see pending, claimed, then acked.",
);
console.log('agents are labelled "demo" in the panel. press ctrl+c to stop.');

process.on("SIGINT", async () => {
  running = false;
  clearInterval(timer);

  // A shim should close its run on the way out. Leaving a run active is how ghost work happens.
  await Promise.all(
    sessions.map((session) =>
      call("POST", `/api/v1/agents/${session.agentId}/events`, session.token, {
        events: [
          {
            event_id: uuidv7(),
            seq: session.seq + 1,
            type: "run.failed",
            run_id: session.runId,
            data: { error_code: "interrupted", message: "demo driver stopped" },
          },
        ],
      }),
    ),
  );

  db.close();
  console.log(
    "\ndemo stopped. agents go stale in ~30s and offline in ~90s. that is the TTL working.",
  );
  process.exit(0);
});
