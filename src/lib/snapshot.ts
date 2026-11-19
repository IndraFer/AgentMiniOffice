import { eventAction, standardAction, validVariant, waitOptions } from './vocab';
import { lifecycleOf } from "./agents";
import type { Db } from "./db";
import type { PresenceStore } from "./state";

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  host: string | null;
  project: string | null;
  simulator: number;
  capabilities: string;
  avatar_variation: number | null;
  created_at: string;
}

interface RunRow {
  id: string;
  agent_id: string;
  title: string | null;
  state: string;
  started_at: string;
  parent_run_id: string | null;
  parent_agent_id: string | null;
  avatar_label: string | null;
  kind: string;
}

interface SignalRow {
  room: string | null;
  id: string;
  seq: number | null;
  run_id: string | null;
  agent_id: string;
  type: string;
  received_at: string;
  data: string;
}

interface TaskRowRead {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  priority: number;
  lease_expires_at: string | null;
  created_at: string;
}

/** A short, human readable reason for the current room. Mostly metadata, never content. */
export function signalOf(row: SignalRow | undefined) {
  if (!row) return null;

  let detail = "";
  let defaulted = false;
  let variant: string | undefined;
  let options: string[] | undefined;
  let toolSource: string | undefined;
  let action: ReturnType<typeof standardAction>;
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed && typeof parsed === "object") {
      const data = parsed as Record<string, unknown>;
      action = eventAction(row.type, data, row.room);
      if (action && validVariant(data.action,data.variant)) variant=data.variant;
      defaulted = !!action && data.action === undefined;
      if(row.type === 'human.waiting' && waitOptions(data.options)) options = data.options;
      const candidate = data.tool ?? data.kind ?? data.title ?? data.code;
      if (typeof candidate === "string") detail = candidate.slice(0, 48);
      if (row.type.startsWith('tool.') && typeof data.tool_source === 'string' &&
          ['builtin','builtin-extension','extension','sdk','unknown'].includes(data.tool_source)) toolSource = data.tool_source;
    }
  } catch {
    detail = "";
  }

  return {
    id: row.id,
    seq: row.seq,
    run_id: row.run_id,
    type: row.type,
    at: row.received_at,
    detail,
    ...(options ? {options} : {}),
    ...(action ? {action} : {}),
    ...(variant ? {variant} : {}),
    ...(defaulted ? {action_origin:'default'} : {}),
    ...(toolSource ? { tool_source: toolSource } : {}),
  };
}

export interface Snapshot {
  server_time: string;
  org: { id: string; name: string };
  agents: unknown[];
  counters: { agents_online: number; runs_active: number; tasks_pending: number };
}

/**
 * One place builds the snapshot, so `/snapshot` and the SSE resync can never disagree.
 */
export function buildSnapshot(db: Db, store: PresenceStore, orgId: string): Snapshot {
  const org = db
    .prepare("SELECT name FROM organizations WHERE id = ?")
    .get<{ name: string }>(orgId);

  const agents = db
    .prepare(
      `SELECT a.id, coalesce(v.name,a.name) AS name, kind, host, project, simulator, capabilities, a.avatar_variation, a.created_at
         FROM agents a LEFT JOIN visit_labels v ON v.agent_id=a.id WHERE org_id = ? AND archived_at IS NULL ORDER BY name,a.id`,
    )
    .all<AgentRow>(orgId);

  const runs = db
    .prepare(
      `SELECT r.id, r.agent_id, r.title, r.state, r.started_at, r.kind,
              p.id AS parent_run_id, p.agent_id AS parent_agent_id,
              (SELECT json_extract(e.data,'$.avatar_label') FROM events e WHERE e.run_id=r.id AND e.org_id=r.org_id AND e.agent_id=r.agent_id AND e.type='run.started' LIMIT 1) AS avatar_label
         FROM runs r LEFT JOIN runs p ON p.id = r.parent_run_id AND p.org_id = r.org_id
         WHERE r.org_id = ? AND r.state = 'active'
         ORDER BY r.started_at, r.id`,
    )
    .all<RunRow>(orgId);

  const taskRows = db
    .prepare(
      `SELECT id, agent_id, title, status, priority, lease_expires_at, created_at
         FROM tasks WHERE org_id = ? AND status != 'cancelled'
         ORDER BY created_at DESC LIMIT 400`,
    )
    .all<TaskRowRead>(orgId);

  // Batch receive times can tie; SQLite insertion order breaks ties, not random UUID tails.
  // Internal rowid is not an API identifier or an autoincrement schema column.
  const signals = new Map<string, SignalRow>();
  for (const row of db
    .prepare(
      `SELECT e.agent_id, e.id, e.seq, e.room, r.id AS run_id, e.type, e.received_at, e.data FROM (
         SELECT *, row_number() OVER (PARTITION BY agent_id ORDER BY received_at DESC, rowid DESC) AS rn
           FROM events WHERE org_id = ?
       ) e LEFT JOIN runs r ON r.id = e.run_id AND r.org_id = e.org_id AND r.agent_id = e.agent_id
       WHERE e.rn = 1`,
    )
    .all<SignalRow>(orgId)) {
    signals.set(row.agent_id, row);
  }

  const presence = new Map(store.list(orgId).map((entry) => [entry.agent_id, entry]));

  const runsByAgent = new Map<string, RunRow[]>();
  for (const run of runs) {
    const list = runsByAgent.get(run.agent_id) ?? [];
    list.push(run);
    runsByAgent.set(run.agent_id, list);
  }

  const tasksByAgent = new Map<string, TaskRowRead[]>();
  for (const task of taskRows) {
    const list = tasksByAgent.get(task.agent_id) ?? [];
    if (list.length < 8) list.push(task);
    tasksByAgent.set(task.agent_id, list);
  }

  let agentsOnline = 0;
  const payload = agents.map((agent) => {
    const current = presence.get(agent.id);
    const state = store.rosterState(agent.id, agent.created_at);
    if (state === "online") agentsOnline++;

    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      host: agent.host,
      project: agent.project,
      avatar_variation: agent.avatar_variation,
      simulator: Number(agent.simulator) === 1,
      lifecycle: lifecycleOf(agent.capabilities),
      presence: current
        ? {
            state,
            room: state === 'offline' ? 'away' : current.room,
            task: current.task,
            activity: current.activity,
            last_seen_at: current.last_seen_at,
            online_since: current.online_since,
            heartbeat_state: current.heartbeat_state,
            last_seq: current.last_seq,
          }
        : { state, room: state === 'offline' ? 'away' : 'lobby', task: null, activity: null, last_seen_at: null },
      signal: signalOf(signals.get(agent.id)),
      runs: (runsByAgent.get(agent.id) ?? []).map((run) => ({
        id: run.id,
        title: run.title,
        state: run.state,
        started_at: run.started_at,
        parent_run_id: run.parent_run_id,
        parent_agent_id: run.parent_agent_id,
        ...(typeof run.avatar_label === 'string' ? {avatar_label:run.avatar_label} : {}),
        kind: run.kind,
      })),
      tasks: (tasksByAgent.get(agent.id) ?? []).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: Number(task.priority),
        lease_expires_at: task.lease_expires_at,
        created_at: task.created_at,
      })),
    };
  });

  // Counted in SQL. The task list above is capped at 400 rows, so counting it would be wrong.
  const pending = db
    .prepare("SELECT count(*) AS n FROM tasks WHERE org_id = ? AND status = 'pending'")
    .get<{ n: number }>(orgId);

  return {
    server_time: new Date().toISOString(),
    org: { id: orgId, name: org?.name ?? "" },
    agents: payload,
    counters: {
      agents_online: agentsOnline,
      runs_active: runs.length,
      tasks_pending: Number(pending?.n ?? 0),
    },
  };
}
