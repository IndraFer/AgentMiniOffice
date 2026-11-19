// Read-only projections of existing snapshot fields. Never infer child identities or task completion.
import actionSchema from './schemas/action-v1.json' with {type:'json'};
const actions = actionSchema['x-actions'];
export function writingSignal(s) {
  return s?.action === 'write';
}
const STATIONS = {
  lobby: ["waiting", "Waiting in Lobby"],
  barber: ["onboarding", "Onboarding"],
  desk: ["typing", "Desk Work"],
  whiteboard: ["planning", "Planning"],
  library: ["reading", "Reading / Research"],
  workshop: ["tools", "Using Tools"],
  "print-room": ["output", "Preparing Output"],
  "phone-booth": ["communication", "Communication"],
  meeting: ["meeting", "Coordination"],
  pantry: ["break", "Taking a Break"],
  "intern-desk": ["typing", "Intern Desk Work"],
  away: ["away", "Away"],
};

const failureSignal = signal => signal?.type === 'error' || signal?.type === 'run.failed';

export function explicitlyIdle(agent) {
  if (agent.presence?.heartbeat_state !== 'idle') return false;
  // An unsequenced failure cannot be ordered against the idle heartbeat.
  if (agent.signal?.seq == null) return !failureSignal(agent.signal);
  return agent.presence.last_seq > agent.signal.seq;
}

export function standbyEligible(agent) {
  return (
    agent.presence?.state === "online" &&
    explicitlyIdle(agent) &&
    !(agent.runs ?? []).some((run) => run.state === "active") &&
    !(agent.tasks ?? []).some((task) => task.status === "claimed") &&
    agent.signal?.type !== 'human.waiting'
  );
}

export function stationActivity(agent) {
  const presence = agent.presence ?? {};
  if (presence.state !== "online") {
    const labels = { stale: "No Signal", offline: "Offline", lobby: "Not Yet Reporting" };
    return { action: "inactive", label: labels[presence.state] ?? "Not Yet Reporting" };
  }
  if (presence.heartbeat_state==='waiting_for_human' || agent.signal?.type==='human.waiting') {
    const options = agent.signal?.type==='human.waiting' ? agent.signal.options : null;
    const labels = {yes:'Yes', no:'No', select:'Select an option', input:'Enter text'};
    const display = Array.isArray(options) ? options.filter(v=>Object.hasOwn(labels,v)).map(v=>labels[v]).join(' / ') : '';
    return {action:'human-waiting',label:display ? `Waiting for Human · ${display}` : 'Waiting for Human'};
  }
  if (standbyEligible(agent)) return { action: "standby", label: "Standby · Ambient" };
  if (explicitlyIdle(agent)) return { action: "waiting", label: "Idle · Awaiting Work" };
  if (agent.lifecycle === "session" && !agent.signal && presence.heartbeat_state!=='working' && !(agent.runs ?? []).some((run) => run.state === "active"))
    return { action: "waiting", label: "No Active Session" };
  const signal = agent.signal;
  if (signal?.action && Object.hasOwn(actions,signal.action)) {
    const {room,pose:action,label} = actions[signal.action];
    // An earlier presence room can still be visible during hysteresis or child projection.
    return {action:room && room !== presence.room ? 'none' : action,label};
  }
  if (presence.room === "phone-booth" && signal?.type === "spawn.started")
    return { action: "communication", label: "Calling Subagent" };
  const [action, label] = STATIONS[presence.room] ?? STATIONS.lobby;
  return { action, label };
}

export const BOARD_STATIONS = [
  ["lobby", "Lobby"],
  ["standby", "Standby"],
  ["desk", "Desk Work"],
  ["whiteboard", "Planning"],
  ["library", "Research"],
  ["workshop", "Tool Work"],
  ["print-room", "Output & Export"],
  ["phone-booth", "Calls & Notifications"],
  ["meeting", "Meeting Room"],
  ["pantry", "Break Area"],
  ["intern-desk", "Subagent Desk"],
  ["away", "Inactive / Away"],
].map(([room, label]) => ({ room, label }));
const boardRooms = new Set(BOARD_STATIONS.map((station) => station.room));
export function boardStation(agent) {
  const presence = agent.presence ?? {};
  if (["stale", "offline"].includes(presence.state)) return "away";
  if (presence.state !== "online") return "lobby";
  if (standbyEligible(agent)) return "standby";
  if(stationActivity(agent).action==='human-waiting') return 'meeting';
  if(agent.lifecycle==='session' && stationActivity(agent).action==='waiting' && !(agent.runs??[]).some(r=>r.state==='active')) return 'lobby';
  // Legacy onboarding and unknown locations must not invent a desk-work action.
  return boardRooms.has(presence.room) && presence.room !== "standby" ? presence.room : "lobby";
}

const timestamp = (value) => Date.parse(value ?? "") || 0;

/** Cues describe received events, never a guessed success, compaction or recovery. */
export function eventCue(agent, now = Date.now()) {
  if (agent.presence?.state !== "online") return null;
  const signal = agent.signal;
  if (!signal) return null;
  if (explicitlyIdle(agent)) return null;
  if (failureSignal(signal)) return { kind: 'error', label: 'Error Reported' };
  const activity = stationActivity(agent);
  if (activity.action === "human-waiting") return { kind: "human-waiting", label: activity.label };
  if (signal.type === "plan.start" && !["read", "research"].includes(signal.detail))
    return { kind: "planning", label: "Planning" };
  const age = now - timestamp(signal.at);
  if (signal.type === "spawn.started" && age >= 0 && age < 8000)
    return { kind: "calling", label: "Calling Subagent" };
  return null;
}

/** A temporary avatar represents an actual active child RUN, not an invented registered agent. */
export function sceneEntities(agents) {
  const owners = new Map(agents.map((agent) => [agent.id, agent]));
  const entities = agents.map((agent) => ({
    ...agent,
    sourceAgentId: agent.id,
    actorKind: "agent",
  }));
  const runEntities = new Map();
  const children = [];
  for (const [index, agent] of agents.entries()) {
    const runs = (agent.runs ?? []).filter((run) => run.state === "active");
    const linked = runs.filter((run) => run.parent_run_id && owners.has(run.parent_agent_id));
    // A separately registered child-only agent already has an avatar: reuse it for its first run.
    const reuse =
      runs.length === 1 && linked.length === 1 && linked[0].parent_agent_id !== agent.id;
    for (const run of runs) {
      if (!linked.includes(run) || reuse) runEntities.set(run.id, agent.id);
      else runEntities.set(run.id, `run:${run.id}`);
    }
    for (const run of linked) {
      const parent = owners.get(run.parent_agent_id);
      let entity = entities[index];
      if (!reuse) {
        entity = {
          ...agent,
          id: `run:${run.id}`,
          avatar_variation: null, // A temporary child run is not the registered agent.
          sourceAgentId: agent.id,
          tasks: [],
          runs: [run],
          lifecycle: "session",
          presence: {
            ...agent.presence,
            room: parent.presence?.room === "meeting" ? "meeting" : "intern-desk",
            task: run.title || "Active Subagent Run",
          },
        };
        entities.push(entity);
      }
      entity.name = `Sub · ${agent.kind === 'pi' || reuse ? agent.name : run.avatar_label || agent.name}`;
      entity.actorKind = "subagent";
      entity.runId = run.id;
      entity.parentRunId = run.parent_run_id;
      entity.parentAgentId = run.parent_agent_id;
      children.push(entity);
    }
  }
  for (const entity of entities) {
    const signalTarget = runEntities.get(entity.signal?.run_id);
    if (signalTarget && signalTarget !== entity.id) entity.signal = null;
    // Agent-level signals belong to the registered agent, not every temporary child.
    if (entity.id !== entity.sourceAgentId && !entity.signal?.run_id) entity.signal = null;
  }
  for (const child of children)
    child.parentId = runEntities.get(child.parentRunId) ?? child.parentAgentId;
  const registered = entities.filter((entity) => entity.id === entity.sourceAgentId);
  const temporary = entities
    .filter((entity) => entity.id !== entity.sourceAgentId)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const hidden of temporary.slice(6)) {
    const owner = registered.find((entity) => entity.id === hidden.sourceAgentId);
    if (owner) owner.hiddenChildRuns = (owner.hiddenChildRuns ?? 0) + 1;
  }
  return [...registered, ...temporary.slice(0, 6)];
}
const openTasks = (agent) =>
  (agent.tasks ?? []).filter((task) => task.status === "pending" || task.status === "claimed");
const priorityOf = (tasks) =>
  tasks.reduce(
    (best, task) => Math.max(best, Number.isFinite(task.priority) ? task.priority : 0),
    -Infinity,
  );
const updatedAt = (agent) =>
  Math.max(
    timestamp(agent.presence?.last_seen_at),
    timestamp(agent.signal?.at),
    ...(agent.tasks ?? []).map((task) => timestamp(task.created_at)),
  );
const compare = (a, b) =>
  b.priority - a.priority || b.updated - a.updated || a.agent.id.localeCompare(b.agent.id);

export function agentActivityOrder(agents) {
  const rank = { online: 0, stale: 1, offline: 2, lobby: 3 };
  return agents
    .map((agent) => ({ agent, priority: priorityOf(openTasks(agent)), updated: updatedAt(agent) }))
    .sort(
      (a, b) =>
        (rank[a.agent.presence?.state] ?? 4) - (rank[b.agent.presence?.state] ?? 4) ||
        compare(a, b),
    )
    .map((row) => row.agent);
}

/** Sort the visible snapshot window, not an invented project priority or a complete task backlog. */
export function projectActivity(agents) {
  const groups = new Map();
  for (const agent of agents) {
    const project =
      typeof agent.project === "string" && agent.project.trim() ? agent.project.trim() : null;
    const key = JSON.stringify(project);
    const tasks = openTasks(agent);
    // Heartbeats describe liveness, not a new event or task. Keep project ordering independent.
    const activityAt = Math.max(
      timestamp(agent.signal?.at),
      ...(agent.tasks ?? []).map((task) => timestamp(task.created_at)),
      ...(agent.runs ?? []).map((run) => timestamp(run.started_at)),
    );
    const row = { agent, tasks, priority: priorityOf(tasks), updated: activityAt };
    if (!groups.has(key)) groups.set(key, { key, name: project ?? "Unassigned", rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()]
    .map((group) => {
      group.rows.sort(compare);
      const primary = group.rows[0];
      const newest = Math.max(...group.rows.map((row) => row.updated));
      const latest = group.rows
        .map((row) => row.agent)
        .filter((agent) => timestamp(agent.signal?.at) > 0)
        .sort(
          (a, b) => timestamp(b.signal.at) - timestamp(a.signal.at) || a.id.localeCompare(b.id),
        )[0];
      return {
        key: group.key,
        name: group.name,
        agentId: primary.agent.id,
        agents: group.rows.length,
        priority: Number.isFinite(primary.priority) ? primary.priority : null,
        updated: newest,
        reporters: group.rows.slice(0, 3).map(({ agent }) => ({
          id: agent.id,
          name: agent.name,
          activity: eventCue(agent)?.label ?? stationActivity(agent).label,
        })),
        latestEvent: latest
          ? {
              id: latest.signal.id,
              type: latest.signal.type,
              detail: latest.signal.detail,
              at: latest.signal.at,
              agentId: latest.id,
              agentName: latest.name,
            }
          : null,
        openTasks: group.rows.reduce((count, row) => count + row.tasks.length, 0),
        attention: group.rows.some((row) =>
          ["error", "run.failed"].includes(row.agent.signal?.type),
        ),
        summary:
          primary.agent.presence?.task ||
          primary.agent.presence?.activity ||
          primary.tasks[0]?.title ||
          stationActivity(primary.agent).label,
      };
    })
    .sort(
      (a, b) =>
        (b.priority ?? -Infinity) - (a.priority ?? -Infinity) ||
        b.updated - a.updated ||
        a.key.localeCompare(b.key),
    );
}
