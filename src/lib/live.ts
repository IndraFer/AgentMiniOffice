import type { Db } from "./db";
import type { signalOf } from "./snapshot";
import type { PresenceStore, PresenceView } from "./state";

/**
 * Live feed over SSE.
 *
 * The panel used to poll the snapshot every two seconds. That works, and it is why polling was
 * the first version, but it scales with the number of open tabs and adds up to two seconds of
 * lag. This publishes only what changed.
 *
 * Deliberately not an EventEmitter: one Set of callbacks is enough, and it stays identical on
 * both runtimes.
 */

export type LiveChannel =
  | "presence"
  | "run"
  | "task"
  | "counters"
  | "snapshot"
  | "signal"
  | "project"
  | "roster"
  | "public-view-off";

export interface LiveEvent {
  event: LiveChannel;
  data: unknown;
}

type Listener = (event: LiveEvent) => void;

export class Broadcaster {
  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get size(): number {
    return this.#listeners.size;
  }

  publish(event: LiveEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // One broken client must not stop the others.
      }
    }
  }
}

interface Counters {
  agents_online: number;
  runs_active: number;
  tasks_pending: number;
}

export class Live {
  readonly bus = new Broadcaster();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #lastCounters = new Map<string, string>();

  constructor(
    readonly db: Db,
    readonly store: PresenceStore,
  ) {
    this.store.observe((view) => this.presence(view));
  }

  presence(view: PresenceView): void {
    this.bus.publish({
      event: "presence",
      data: {
        agent_id: view.agent_id,
        org_id: view.org_id,
        state: view.state,
        room: view.room,
        task: view.task,
        activity: view.activity,
        last_seen_at: view.last_seen_at,
        heartbeat_state: view.heartbeat_state,
        last_seq: view.last_seq,
      },
    });
    this.countersFor(view.org_id);
  }

  run(orgId: string, agentId: string, runId: string, state: string, title: string | null): void {
    this.bus.publish({
      event: "run",
      data: { org_id: orgId, agent_id: agentId, run_id: runId, state, title },
    });
    this.countersFor(orgId);
  }

  task(orgId: string, agentId: string, taskId: string, status: string): void {
    this.bus.publish({
      event: "task",
      data: { org_id: orgId, agent_id: agentId, task_id: taskId, status },
    });
    this.countersFor(orgId);
  }

  /** Only call after an ingest transaction commits; metadata matches snapshot.signal. */
  signal(orgId: string, agentId: string, signal: NonNullable<ReturnType<typeof signalOf>>): void {
    this.bus.publish({ event: "signal", data: { org_id: orgId, agent_id: agentId, signal } });
  }

  countersFor(orgId: string): void {
    const online = this.db
      .prepare("SELECT count(*) AS n FROM agent_presence WHERE org_id = ? AND state = 'online'")
      .get<{ n: number }>(orgId);
    const runs = this.db
      .prepare("SELECT count(*) AS n FROM runs WHERE org_id = ? AND state = 'active'")
      .get<{ n: number }>(orgId);
    const tasks = this.db
      .prepare("SELECT count(*) AS n FROM tasks WHERE org_id = ? AND status = 'pending'")
      .get<{ n: number }>(orgId);

    const counters: Counters = {
      agents_online: Number(online?.n ?? 0),
      runs_active: Number(runs?.n ?? 0),
      tasks_pending: Number(tasks?.n ?? 0),
    };

    const serialized = JSON.stringify(counters);
    if (this.#lastCounters.get(orgId) === serialized) return;
    this.#lastCounters.set(orgId, serialized);
    this.bus.publish({ event: "counters", data: { org_id: orgId, ...counters } });
  }

  /** Presence is flushed every few seconds, so counters need their own cadence. */
  start(intervalMs = 2000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      for (const row of this.db.prepare("SELECT id FROM organizations").all<{ id: string }>()) {
        this.countersFor(row.id);
      }
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
