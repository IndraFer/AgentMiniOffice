import type { Db } from "./db";
import { type PresenceState, presenceState, type Room } from "./vocab";

export interface PresenceView {
  agent_id: string;
  org_id: string;
  state: PresenceState;
  room: Room;
  task: string | null;
  activity: string | null;
  last_seq: number;
  last_seen_at: string | null;
  online_since: string | null;
  offline_since: string | null;
  heartbeat_state: string | null;
}

interface Entry extends PresenceView {
  /** Latest room the reducer asked for. Not yet visible until the window opens. */
  proposed: Room | null;
  /** When the visible room last changed, in ms. */
  changedAt: number;
  lastSeenMs: number | null;
  dirty: boolean;
}

export interface PresenceOptions {
  onlineMs: number;
  staleMs: number;
  roomHysteresisMs: number;
}

export interface HeartbeatInput {
  seq?: number;
  state?: string;
  task?: string;
  activity?: string;
}

interface PresenceRow {
  agent_id: string;
  org_id: string;
  state: string;
  room: string;
  room_pending: string | null;
  room_pending_since: string | null;
  task_label: string | null;
  activity: string | null;
  last_seq: number;
  last_seen_at: string | null;
  online_since: string | null;
  offline_since: string | null;
  heartbeat_state: string | null;
}

const toIso = (value: number): string => new Date(value).toISOString();
const toMs = (value: string | null): number | null => (value ? Date.parse(value) : null);

/**
 * Presence is derived here, never taken from what an agent claims.
 *
 * The store is the hot copy: heartbeats update it in memory and a periodic flush writes it
 * to SQLite. A heartbeat never causes a disk write of its own, otherwise fifty agents
 * saturate the VPS disk.
 */
export class PresenceStore {
  readonly #entries = new Map<string, Entry>();
  readonly #opts: PresenceOptions;
  #observer: ((view: PresenceView) => void) | null = null;

  /** Called whenever a visible state or room changes. The live feed subscribes here. */
  observe(observer: ((view: PresenceView) => void) | null): void {
    this.#observer = observer;
  }

  #notify(entry: Entry): void {
    if (!this.#observer) return;
    try {
      this.#observer({ ...entry, room: this.effectiveRoom(entry) });
    } catch {
      // A failing observer must never break presence tracking.
    }
  }

  constructor(opts: PresenceOptions) {
    this.#opts = opts;
  }

  /** Never-seen sessions get one stale window after creation to send their first heartbeat. */
  offlineAt(agentId: string, createdAt: string): number {
    return (this.#entries.get(agentId)?.lastSeenMs ?? Date.parse(createdAt)) + this.#opts.staleMs;
  }

  rosterState(agentId: string, createdAt: string, now = Date.now()): PresenceState {
    if (this.offlineAt(agentId, createdAt) <= now) return 'offline';
    return presenceState(this.#entries.get(agentId)?.lastSeenMs ?? null, now, this.#opts.onlineMs, this.#opts.staleMs);
  }

  load(db: Db): void {
    this.#entries.clear();
    const rows = db
      .prepare(
        `SELECT agent_id, org_id, state, room, room_pending, room_pending_since,
                task_label, activity, last_seq, last_seen_at, online_since,
                offline_since, heartbeat_state
           FROM agent_presence`,
      )
      .all<PresenceRow>();

    for (const row of rows) {
      this.#entries.set(row.agent_id, {
        agent_id: row.agent_id,
        org_id: row.org_id,
        state: (row.state as PresenceState) ?? "lobby",
        room: (row.room as Room) ?? "lobby",
        task: row.task_label,
        activity: row.activity,
        last_seq: Number(row.last_seq ?? 0),
        last_seen_at: row.last_seen_at,
        online_since: row.online_since,
        offline_since: row.offline_since,
        heartbeat_state: row.heartbeat_state,
        proposed: (row.room_pending as Room | null) ?? null,
        changedAt: toMs(row.room_pending_since) ?? Date.now(),
        lastSeenMs: toMs(row.last_seen_at),
        dirty: false,
      });
    }
  }

  #ensure(agentId: string, orgId: string, now = Date.now()): Entry {
    const existing = this.#entries.get(agentId);
    if (existing) return existing;
    const entry: Entry = {
      agent_id: agentId,
      org_id: orgId,
      state: "lobby",
      room: "lobby",
      task: null,
      activity: null,
      last_seq: 0,
      last_seen_at: null,
      online_since: null,
      offline_since: null,
      heartbeat_state: null,
      proposed: null,
      changedAt: now,
      lastSeenMs: null,
      dirty: true,
    };
    this.#entries.set(agentId, entry);
    return entry;
  }

  #stateOf(entry: Entry, now: number): PresenceState {
    return presenceState(entry.lastSeenMs, now, this.#opts.onlineMs, this.#opts.staleMs);
  }

  heartbeat(agentId: string, orgId: string, input: HeartbeatInput, now = Date.now()): Entry {
    const entry = this.#ensure(agentId, orgId, now);

    const previousHeartbeatState = entry.heartbeat_state;
    const previousTask = entry.task;
    const previousActivity = entry.activity;
    const previousRoom = entry.room;
    entry.lastSeenMs = now;
    entry.last_seen_at = toIso(now);

    if (
      typeof input.seq === "number" &&
      Number.isInteger(input.seq) &&
      input.seq > entry.last_seq
    ) {
      entry.last_seq = input.seq;
    }
    if (typeof input.task === "string") entry.task = input.task.slice(0, 200);
    if (typeof input.activity === "string") entry.activity = input.activity.slice(0, 200);
    if (typeof input.state === "string") entry.heartbeat_state = input.state.slice(0, 40);

    // An agent that came back should not be standing in the lobby.
    if (entry.room === "lobby") entry.room = "desk";

    const state = this.#stateOf(entry, now);
    const changed =
      state !== entry.state ||
      entry.room !== previousRoom ||
      entry.task !== previousTask ||
      entry.activity !== previousActivity ||
      entry.heartbeat_state !== previousHeartbeatState ||
      // Explicit idle renewals can supersede a newer work event even if the idle string is unchanged.
      entry.heartbeat_state === "idle";
    if (state === "online" && entry.online_since === null) entry.online_since = toIso(now);
    if (state === "offline") entry.offline_since = toIso(now);
    entry.state = state;
    entry.dirty = true;
    if (changed) this.#notify(entry);
    return entry;
  }

  /**
   * Minimum display time for a room, not a stability requirement on the proposal.
   *
   * Rapid activity changes must not make the avatar flicker, but the avatar should still
   * track the latest intent. So: record the newest proposal always, and only move the avatar
   * once the window since the last actual change has passed.
   */
  applyRoom(agentId: string, orgId: string, proposed: Room, now = Date.now()): void {
    const entry = this.#ensure(agentId, orgId, now);

    if (this.#opts.roomHysteresisMs <= 0) {
      if (entry.room !== proposed) {
        entry.room = proposed;
        entry.changedAt = now;
        entry.dirty = true;
        this.#notify(entry);
      }
      entry.proposed = null;
      return;
    }

    if (proposed === entry.room) {
      entry.proposed = null;
      return;
    }

    entry.proposed = proposed;
    entry.dirty = true;

    if (now - entry.changedAt >= this.#opts.roomHysteresisMs) {
      entry.room = proposed;
      entry.changedAt = now;
      entry.proposed = null;
      this.#notify(entry);
    }
  }

  /**
   * Recompute presence and resolve pending room changes.
   *
   * Hysteresis is time based, so the sweeper has to finish what applyRoom started.
   * Otherwise a single event would set a pending room that only lands when the next event
   * happens to arrive, which could be minutes later.
   */
  sweep(now = Date.now()): void {
    for (const entry of this.#entries.values()) {
      if (
        entry.proposed !== null &&
        entry.proposed !== entry.room &&
        now - entry.changedAt >= this.#opts.roomHysteresisMs
      ) {
        entry.room = entry.proposed;
        entry.changedAt = now;
        entry.proposed = null;
        entry.dirty = true;
        this.#notify(entry);
      }

      const state = this.#stateOf(entry, now);
      if (state === entry.state) continue;
      if (state === "online" && entry.online_since === null) entry.online_since = toIso(now);
      if (state === "offline") entry.offline_since = toIso(now);
      entry.state = state;
      entry.dirty = true;
      this.#notify(entry);
    }
  }

  flush(db: Db): number {
    let written = 0;
    const statement = db.prepare(
      `INSERT INTO agent_presence (
         agent_id, org_id, state, room, room_pending, room_pending_since,
         task_label, activity, last_seq, last_seen_at, online_since, offline_since,
         heartbeat_state, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         state = excluded.state,
         room = excluded.room,
         room_pending = excluded.room_pending,
         room_pending_since = excluded.room_pending_since,
         task_label = excluded.task_label,
         activity = excluded.activity,
         last_seq = excluded.last_seq,
         last_seen_at = excluded.last_seen_at,
         online_since = excluded.online_since,
         offline_since = excluded.offline_since,
         heartbeat_state = excluded.heartbeat_state,
         updated_at = excluded.updated_at`,
    );

    const nowIso = toIso(Date.now());
    for (const entry of this.#entries.values()) {
      if (!entry.dirty) continue;
      statement.run(
        entry.agent_id,
        entry.org_id,
        entry.state,
        entry.room,
        entry.proposed,
        entry.proposed === null ? null : toIso(entry.changedAt),
        entry.task,
        entry.activity,
        entry.last_seq,
        entry.last_seen_at,
        entry.online_since,
        entry.offline_since,
        entry.heartbeat_state,
        nowIso,
      );
      entry.dirty = false;
      written++;
    }
    return written;
  }

  setLastSeq(agentId: string, orgId: string, seq: number): void {
    const entry = this.#ensure(agentId, orgId);
    if (seq > entry.last_seq) {
      entry.last_seq = seq;
      entry.dirty = true;
    }
  }

  lastSeq(agentId: string): number {
    return this.#entries.get(agentId)?.last_seq ?? 0;
  }

  /** Offline agents are shown as away. The stored room is kept so they return to it. */
  effectiveRoom(entry: Entry): Room {
    return entry.state === "offline" ? "away" : entry.room;
  }

  view(agentId: string): PresenceView | null {
    const entry = this.#entries.get(agentId);
    if (!entry) return null;
    return { ...entry, room: this.effectiveRoom(entry) };
  }

  /** Drop a deleted demo identity before the periodic flush can write it back. */
  forget(agentId: string): void {
    this.#entries.delete(agentId);
  }

  list(orgId: string): PresenceView[] {
    const out: PresenceView[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.org_id !== orgId) continue;
      out.push({ ...entry, room: this.effectiveRoom(entry) });
    }
    return out;
  }
}
