import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { AGENT_TOKEN_PREFIX, hashToken } from "./auth";
import type { Db } from "./db";
import type { Live } from "./live";
import { uuidv7 } from "./uuid";

/**
 * In process demo driver.
 *
 * It talks to the real HTTP surface through `app.request`, so a demo exercises the same
 * validation, presence, room reducer, and event store as a real agent. It never writes presence
 * directly, because a demo that bypasses the pipeline proves nothing.
 *
 * Agents it creates carry simulator = 1 and the panel labels them.
 */

interface Persona {
  name: string;
  kind: string;
  host: string;
  project: string;
  tasks: string[];
  cycle: { type: string; data: Record<string, unknown>; task?: string }[];
}

const BASE_PERSONAS: Persona[] = [
  {
    name: "Pi Agent",
    kind: "pi",
    host: "macbook",
    project: "dashboard",
    tasks: ["build the room grid", "wire the detail panel", "polish the interface"],
    cycle: [
      { type: "plan.end", data: {} },
      {
        type: "tool.call",
        data: { tool: "export", action: "print" },
        task: "export dashboard summary",
      },
      { type: "plan.start", data: { kind: "design", topic: "panel layout" } },
      { type: "plan.end", data: {} },
      {
        type: "tool.call",
        data: { tool: "bash", action: "use_tools", duration_ms: 1200, ok: true },
        task: "check dashboard build",
      },
    ],
  },
  {
    name: "Hermes",
    kind: "hermes",
    host: "homelab",
    project: "ops",
    tasks: ["rotate homelab backups", "check disk pressure", "read incident notes"],
    cycle: [
      { type: "plan.end", data: {} },
      { type: "plan.start", data: { kind: "research", topic: "backup retention" } },
      { type: "tool.call", data: { tool: "bash", action: "use_tools", duration_ms: 2400, ok: true } },
      { type: "tool.call", data: { tool: "read", action: "read" } },
    ],
  },
  {
    name: "Codex",
    kind: "codex",
    host: "macbook",
    project: "billing",
    tasks: ["read billing schema", "draft migration", "ask about rounding rule"],
    cycle: [
      { type: "plan.end", data: {} },
      { type: "plan.start", data: { kind: "read", topic: "schema.sql" } },
      { type: "tool.call", data: { tool: "grep", action: "search_content" } },
      { type: "human.waiting", data: { kind: "select", options: ["select"] } },
      { type: "human.resumed", data: {} },
    ],
  },
];

const [pi, hermes, codex] = BASE_PERSONAS;
const PERSONAS: Persona[] = [
  { ...codex!, name: 'Claude', kind: 'claude' },
  codex!,
  { ...pi!, name: 'Antigravity', kind: 'antigravity' },
  pi!,
  hermes!,
  { ...pi!, name: 'Mercury', kind: 'mercury' },
  { ...hermes!, name: 'OpenClaw', kind: 'openclaw' },
  { ...hermes!, name: 'Gemini', kind: 'gemini' },
];
const DAEMON_PERSONAS = new Set(['Hermes', 'OpenClaw', 'Mercury', 'Gemini']);
// Old collector versions used the simulator name as a token label. Only these
// historical names may prove demo ownership that way; today's harness names cannot.
const LEGACY_DEMO_NAMES = ['demo-pi-dashboard','demo-hermes-backup','demo-codex-billing',
  'demo-openclaw-ops','demo-mercury-dashboard','demo-claude-billing','demo-openbot-ops',
  'demo-opencode-dashboard'].flatMap(name => [name, `${name} (Panel)`]);
for (const persona of PERSONAS)
  if (DAEMON_PERSONAS.has(persona.name)) {
    persona.cycle = [
      persona.cycle[0]!,
      { type: "note", data: { kind: "idle" } },
      ...persona.cycle.slice(1),
    ];
  }

interface Session {
  agentId: string;
  token: string;
  runId: string;
  runOpen: boolean;
  seq: number;
  phase: number;
  remainingTicks: number;
  randomState: number;
  persona: Persona;
  claimedTaskId: string | null;
  claimedAt: number;
}

const TICK_MS = 1500;
// Per-persona seeded timing is reproducible, but each phase gets a fresh duration.
function timingSeed(name: string): number {
  let seed = 2166136261;
  for (const char of name) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0 || 1;
}

function randomTicks(session: Session, min: number, max: number): number {
  let state = session.randomState;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  session.randomState = state >>> 0;
  return min + (session.randomState % (max - min + 1));
}

export class DemoDriver {
  readonly #db: Db;
  readonly #sessions = new Map<string, Session[]>();
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  #app: Hono | null = null;
  readonly #ready = new Map<string, Promise<void>>();
  readonly #ticks = new Map<string, Promise<void>>();
  constructor(
    db: Db,
    private readonly live: Live,
  ) {
    this.#db = db;
  }

  // A simulator flag alone is not ownership: the standalone CLI uses it too.
  // Historical dashboard tokens were labelled with the persona's exact name.
  cleanupLeftovers(orgId?: string): number {
    const names = [...PERSONAS.map(p => p.name), ...LEGACY_DEMO_NAMES];
    const db = this.#db;
    const removed: {id:string;org_id:string}[]=[];
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db
        .prepare(`SELECT a.id,a.org_id FROM agents a WHERE a.simulator=1
        AND (? IS NULL OR a.org_id=?) AND a.name IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM agent_tokens t WHERE t.agent_id=a.id AND t.org_id=a.org_id AND t.label IN ('panel-demo',a.name))
        AND NOT EXISTS (SELECT 1 FROM agent_tokens t WHERE t.agent_id=a.id AND
          (t.label IS NULL OR (t.label<>'panel-demo' AND NOT (t.label=a.name AND a.name IN (SELECT value FROM json_each(?))))))`)
        .all<{ id: string; org_id: string }>(orgId ?? null, orgId ?? null, JSON.stringify(names), JSON.stringify(LEGACY_DEMO_NAMES));
      for (const row of rows) {
        // Deleting a parent run cascades to its children. Never remove another worker's history.
        if (
          db
            .prepare(
              `SELECT 1 FROM runs p JOIN runs c ON c.parent_run_id=p.id WHERE p.agent_id=? AND c.agent_id<>p.agent_id LIMIT 1`,
            )
            .get(row.id)
        ) {
          console.warn("[demo] Retained a simulator with a run linked to another worker.");
          continue;
        }
        db.prepare("DELETE FROM agents WHERE id=? AND org_id=? AND simulator=1").run(
          row.id,
          row.org_id,
        );
        removed.push(row);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const r of removed) this.live.store.forget(r.id);
    for (const id of new Set(removed.map((r) => r.org_id))) {
      this.live.countersFor(id);
      this.live.bus.publish({ event: "roster", data: { org_id: id } });
    }
    return removed.length;
  }

  attach(app: Hono): void {
    this.#app = app;
  }

  isRunning(orgId: string): boolean {
    return this.#timers.has(orgId);
  }

  /** Create the simulated agents if needed, then start driving them. */
  start(orgId: string, count = 6): { agents: number; alreadyRunning: boolean } {
    if (this.isRunning(orgId)) {
      return { agents: this.#sessions.get(orgId)?.length ?? 0, alreadyRunning: true };
    }

    const sessions: Session[] = [];
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const persona of PERSONAS.slice(0, Math.max(1, Math.min(count, PERSONAS.length)))) {
        const agentId = this.#ensureAgent(orgId, persona);
        const token = this.#issueToken(orgId, agentId, "panel-demo");
        const session: Session = {
          agentId,
          token,
          runId: uuidv7(),
          runOpen: true,
          seq: 0,
          phase: -1,
          remainingTicks: sessions.length,
          randomState: timingSeed(persona.name),
          persona,
          claimedTaskId: null,
          claimedAt: 0,
        };
        session.remainingTicks += randomTicks(session, 0, 1);
        sessions.push(session);
      }

      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#sessions.set(orgId, sessions);

    const timer = setInterval(() => {
      void this.tick(orgId).catch((error) => console.warn("demo tick failed", error));
    }, TICK_MS);
    timer.unref?.();
    this.#timers.set(orgId, timer);

    // Open the run before the first event. An event carrying an unknown run_id violates a
    // foreign key and is rejected, which is how the first version of this driver ended up
    // sending heartbeats and nothing else.
    this.#ready.set(orgId, this.#openRuns(sessions));
    void this.tick(orgId).catch((error) => console.warn("demo startup failed", error));

    return { agents: sessions.length, alreadyRunning: false };
  }

  stop(orgId: string): boolean {
    const timer = this.#timers.get(orgId);
    if (timer) clearInterval(timer);
    this.#timers.delete(orgId);
    this.#sessions.delete(orgId);
    this.#ready.delete(orgId);
    this.#ticks.delete(orgId);
    return this.cleanupLeftovers(orgId) > 0 || !!timer;
  }

  stopAll(): void {
    for (const orgId of [...this.#timers.keys()]) this.stop(orgId);
  }

  /** One round of heartbeats and events. Public so tests do not have to wait on the timer. */
  tick(orgId: string): Promise<void> {
    const current = this.#ticks.get(orgId);
    if (current) return current;
    const sessions = this.#sessions.get(orgId);
    const work = this.#tick(orgId).catch((error) => {
      if (this.#sessions.get(orgId) !== sessions) return;
      this.stop(orgId);
      throw error;
    });
    this.#ticks.set(orgId, work);
    void work
      .finally(() => {
        if (this.#ticks.get(orgId) === work) this.#ticks.delete(orgId);
      })
      .catch(() => {});
    return work;
  }

  async #tick(orgId: string): Promise<void> {
    const app = this.#app;
    const sessions = this.#sessions.get(orgId);
    if (!app || !sessions) return;
    await this.#ready.get(orgId);
    if (this.#sessions.get(orgId) !== sessions) return;

    await Promise.all(
      sessions.map(async (session) => {
        if (session.phase < 0 && session.remainingTicks > 0) {
          session.remainingTicks -= 1;
          return;
        }
        const changed = session.remainingTicks === 0;
        if (changed) session.phase += 1;
        const step = session.persona.cycle[session.phase % session.persona.cycle.length];
        if (!step) return;
        const idle = step.data.kind === "idle" && !session.claimedTaskId;
        // Leave time for collision-safe travel and visible interaction after arrival.
        if (changed)
          session.remainingTicks = idle
            ? randomTicks(session, 12, 24)
            : randomTicks(session, 14, 26);
        if (idle && session.runOpen) {
          await this.#emit(session, "run.finished", {});
          session.runOpen = false;
        } else if (!idle && !session.runOpen) {
          session.runId = uuidv7();
          await this.#emit(session, "run.started", { title: "demo work session" });
          session.runOpen = true;
        }
        const task = idle
          ? "Standby"
          : (step.task ??
            session.persona.tasks[session.phase % session.persona.tasks.length] ??
            "demo work");
        if (this.#sessions.get(orgId) !== sessions) return;
        this.#nextSeq(session);
        const heartbeat = await app.request(`/api/v1/agents/${session.agentId}/heartbeat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ seq: session.seq, state: idle ? "idle" : "working", task }),
        });
        if (!heartbeat.ok) throw new Error(`demo heartbeat rejected (${heartbeat.status})`);

        if (this.#sessions.get(orgId) !== sessions) return;
        session.remainingTicks -= 1;
        if (!changed) return;

        if (!idle) {
          await this.#emit(session, step.type, step.data);
          if (this.#sessions.get(orgId) !== sessions) return;
          await this.#workInbox(session);
        }
      }),
    );
  }

  async #emit(session: Session, type: string, data: Record<string, unknown>): Promise<void> {
    if (!this.#app) return;
    const response = await this.#app.request(`/api/v1/agents/${session.agentId}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { event_id: uuidv7(), seq: this.#nextSeq(session), type, run_id: session.runId, data },
        ],
      }),
    });
    const result = (await response.json()) as { accepted?: number; rejected?: unknown[] };
    if (!response.ok || result.accepted !== 1 || result.rejected?.length)
      throw new Error(`demo ${type} rejected (${response.status})`);
  }

  /**
   * Claim and finish work from the inbox, so the board shows the real lease cycle instead of a
   * column that never moves.
   */
  async #workInbox(session: Session): Promise<void> {
    const app = this.#app;
    if (!app) return;

    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };

    if (session.claimedTaskId && Date.now() - session.claimedAt > 5000) {
      const done = await app.request(
        `/api/v1/agents/${session.agentId}/inbox/${session.claimedTaskId}/ack`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ run_id: session.runId, result: "demo: finished" }),
        },
      );
      if (done.ok) session.claimedTaskId = null;
      return;
    }

    if (session.claimedTaskId) return;

    const inbox = await app.request(`/api/v1/agents/${session.agentId}/inbox`, { headers });
    if (!inbox.ok) return;

    const payload = (await inbox.json().catch(() => null)) as { tasks?: { id: string }[] } | null;
    const next = payload?.tasks?.[0];
    if (!next) return;

    const claimed = await app.request(`/api/v1/agents/${session.agentId}/inbox/${next.id}/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ run_id: session.runId }),
    });
    if (claimed.ok) {
      session.claimedTaskId = next.id;
      session.claimedAt = Date.now();
    }
  }

  #nextSeq(session: Session): number {
    return ++session.seq;
  }

  async #openRuns(sessions: Session[]): Promise<void> {
    await Promise.all(
      sessions.map((session) =>
        this.#emit(session, "run.started", { title: "demo run", kind: "demo" }),
      ),
    );
  }

  #ensureAgent(orgId: string, persona: Persona): string {
    const name = persona.name;
    const existing = this.#db
      .prepare("SELECT id FROM agents WHERE org_id=? AND name=?")
      .get(orgId, name);

    if (existing)
      throw new Error(`Demo name "${name}" is already registered; no existing worker was changed.`);

    const agentId = uuidv7();
    this.#db
      .prepare(
        `INSERT INTO agents (id, org_id, name, kind, host, project, simulator, capabilities, created_at)
         VALUES (?,?,?,?,?,?,1,?,?)`,
      )
      .run(
        agentId,
        orgId,
        name,
        persona.kind,
        persona.host,
        persona.project,
        JSON.stringify([`lifecycle:${DAEMON_PERSONAS.has(persona.name) ? "daemon" : "session"}`]),
        new Date().toISOString(),
      );
    return agentId;
  }

  #issueToken(orgId: string, agentId: string, label: string): string {
    const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.#db
      .prepare(
        `INSERT INTO agent_tokens (id, agent_id, org_id, token_hash, prefix, label, scopes, created_at)
         VALUES (?,?,?,?,?,?,'["ingest","inbox"]',?)`,
      )
      .run(
        uuidv7(),
        agentId,
        orgId,
        hashToken(token),
        token.slice(0, 8),
        label,
        new Date().toISOString(),
      );
    return token;
  }
}
