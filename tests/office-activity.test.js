import { describe, expect, test } from "bun:test";
import {
  BOARD_STATIONS,
  boardStation,
  eventCue,
  projectActivity,
  sceneEntities,
  stationActivity,
} from "../public/office-activity.js";

const agent = (id, project, priority, at) => ({
  id,
  name: id,
  project,
  presence: { state: "online", room: "desk", task: `${id} current work`, last_seen_at: at },
  tasks: [{ id: `${id}-task`, title: id, status: "pending", priority, created_at: at }],
});

describe("Board 2D projection", () => {
  test("keeps twelve truthful Title Case cards without Barber", () => {
    expect(BOARD_STATIONS).toHaveLength(12);
    expect(BOARD_STATIONS.some((s) => /barber/i.test(s.label + s.room))).toBe(false);
    expect(BOARD_STATIONS.find((s) => s.room === "standby").label).toBe("Standby");
    for (const station of BOARD_STATIONS)
      for (const word of station.label.split(/\s+/))
        if (/^[a-z]/i.test(word)) expect(word[0]).toBe(word[0].toUpperCase());
  });
  test("uses lifecycle/presence truth and preserves actual event stations", () => {
    const online = (room, extra = {}) => ({ presence: { state: "online", room }, ...extra });
    expect(boardStation(online("barber"))).toBe("lobby");
    expect(boardStation(online("unknown"))).toBe("lobby");
    expect(boardStation({ presence: { state: "stale", room: "meeting" } })).toBe("away");
    expect(boardStation({ presence: { state: "offline", room: "desk" } })).toBe("away");
    expect(boardStation(online("desk", { lifecycle: "session", runs: [] }))).toBe("lobby");
    const idle = {
      lifecycle: "daemon",
      runs: [],
      presence: { state: "online", room: "desk", heartbeat_state: "idle", last_seq: 2 },
    };
    expect(boardStation(idle)).toBe("standby");
    expect(boardStation({ ...idle, runs: [{ state: "active" }] })).toBe("desk");
    for (const [room, type] of [
      ["meeting", "human.waiting"],
      ["phone-booth", "spawn.started"],
      ["desk", "tool.call"],
      ["print-room", "tool.call"],
    ])
      expect(boardStation(online(room, { signal: { type } }))).toBe(room);
  });
});

describe("project activity", () => {
  test("heartbeat refreshes do not masquerade as recorded project activity", () => {
    const a = agent("a", "One", 2, "2026-01-01T10:00:00Z");
    a.signal = { id: "event-a", type: "human.waiting", at: "2026-01-01T11:00:00Z" };
    a.presence.room = "meeting";
    const before = projectActivity([a])[0];
    a.presence.last_seen_at = "2026-01-01T12:00:00Z";
    const after = projectActivity([a])[0];
    expect(after.updated).toBe(before.updated);
    expect(after.latestEvent).toMatchObject({
      id: "event-a",
      agentName: "a",
      type: "human.waiting",
    });
    expect(after.reporters).toEqual([{ id: "a", name: "a", activity: "Waiting for Human" }]);
  });
  test("latest event is not hidden behind a higher-priority representative; reporter summaries are bounded", () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      agent(`agent-${i}`, "Live Project", i === 0 ? 5 : 1, "2026-01-01T10:00:00Z"),
    );
    agents[4].signal = {
      id: "newest",
      type: "tool.call",
      detail: "fetch",
      at: "2026-01-01T12:00:00Z",
    };
    const row = projectActivity(agents)[0];
    expect(row.agentId).toBe("agent-0");
    expect(row.latestEvent).toMatchObject({ id: "newest", agentName: "agent-4", detail: "fetch" });
    expect(row.reporters).toHaveLength(3);
    expect(row.agents).toBe(5);
    expect(
      projectActivity([...agents, { id: "new", name: "New", project: "Fourth Project" }]).some(
        (p) => p.name === "Fourth Project",
      ),
    ).toBe(true);
  });
  test("all projects appear, sorted by highest open-task priority then latest signal", () => {
    const rows = projectActivity([
      agent("billing", "Billing", 1, "2026-01-01T10:00:00Z"),
      agent("ops", "Ops", 5, "2026-01-01T09:00:00Z"),
      agent("dashboard", "Dashboard", 5, "2026-01-01T11:00:00Z"),
      agent("ops-two", "Ops", 2, "2026-01-01T08:00:00Z"),
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Dashboard", "Ops", "Billing"]);
    expect(rows[1]).toMatchObject({ agentId: "ops", agents: 2, priority: 5, openTasks: 2 });
    expect(rows[0].summary).toBe("dashboard current work");
  });
  test("completed work cannot outrank open work; missing projects do not merge with a named Unassigned project", () => {
    const done = agent("done", "Done", 999, "2026-01-01T12:00:00Z");
    done.tasks[0].status = "acked";
    const rows = projectActivity([
      done,
      agent("open", "Open", -1, "2026-01-01T09:00:00Z"),
      { id: "missing", name: "No project" },
      { id: "named", name: "Named", project: "Unassigned" },
    ]);
    expect(rows[0].name).toBe("Open");
    expect(rows.find((row) => row.name === "Done").priority).toBeNull();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  });
  test("ties are stable under reordered snapshots; newer activity updates the representative", () => {
    const a = agent("a", "One", 2, "2026-01-01T10:00:00Z");
    const b = agent("b", "One", 2, "2026-01-01T10:00:00Z");
    expect(projectActivity([a, b])).toEqual(projectActivity([b, a]));
    b.signal = { type: "error", at: "2026-01-01T11:00:00Z" };
    expect(projectActivity([a, b])[0]).toMatchObject({ agentId: "b", attention: true });
    expect(projectActivity([])).toEqual([]);
  });
});

describe("real child entities and event cues", () => {
  const parent = () => ({
    id: "owner",
    name: "Owner",
    presence: { state: "online", room: "meeting" },
    runs: [
      { id: "main", state: "active", parent_run_id: null },
      {
        id: "child",
        title: "Research",
        state: "active",
        parent_run_id: "main",
        parent_agent_id: "owner",
      },
    ],
  });
  test("spawn alone cannot create children; actual active runs can, and finish removes them", () => {
    const owner = parent();
    expect(sceneEntities([{ ...owner, runs: [], signal: { type: "spawn.started" } }])).toHaveLength(
      1,
    );
    const entities = sceneEntities([owner]);
    expect(entities).toHaveLength(2);
    expect(entities[1]).toMatchObject({
      id: "run:child",
      sourceAgentId: "owner",
      parentId: "owner",
      actorKind: "subagent",
      presence: { state: "online", room: "meeting" },
    });
    owner.runs[1].state = "finished";
    expect(sceneEntities([owner])).toHaveLength(1);
  });
  test("a separately registered child is not duplicated; missing parents cannot create relationships", () => {
    const owner = parent();
    owner.runs.pop();
    const child = {
      id: "separate",
      name: "Separate",
      presence: { state: "online", room: "library" },
      runs: [{ id: "sub", state: "active", parent_run_id: "main", parent_agent_id: "owner" }],
    };
    expect(sceneEntities([owner, child])).toHaveLength(2);
    expect(sceneEntities([owner, child])[1]).toMatchObject({
      id: "separate",
      parentId: "owner",
      presence: { room: "library" },
    });
    expect(sceneEntities([child])[0].parentId).toBeUndefined();
  });
  test("run-specific errors stay on the child; no live action when its owner is offline", () => {
    const owner = parent();
    owner.signal = { type: "error", run_id: "child" };
    const entities = sceneEntities([owner]);
    expect(eventCue(entities[0])).toBeNull();
    expect(eventCue(entities[1])?.kind).toBe("error");
    owner.presence.state = "offline";
    expect(eventCue(sceneEntities([owner])[1])).toBeNull();
  });
  test("reported errors are not inferred from silence; calling gesture expires and planning is not a solution", () => {
    const owner = parent();
    expect(eventCue(owner)).toBeNull();
    owner.signal = { type: "spawn.started", at: new Date(1000).toISOString() };
    expect(eventCue(owner, 2000)?.kind).toBe("calling");
    expect(eventCue(owner, 10000)).toBeNull();
    owner.signal = { type: "plan.start", detail: "design" };
    expect(eventCue(owner)?.label).toBe("Planning");
    owner.signal = { type: "note", detail: "compaction" };
    expect(eventCue(owner)).toBeNull();
  });
});

describe("explicit idle presentation", () => {
  test("explicit idle visitors get standby without pretending to work", () => {
    const idle = {
      lifecycle: "daemon",
      presence: { state: "online", room: "desk", heartbeat_state: "idle", last_seq: 8 },
      signal: { type: "plan.end", seq: 7 },
      runs: [],
      tasks: [],
    };
    expect(stationActivity(idle).action).toBe("standby");
    expect(stationActivity({ ...idle, lifecycle: "session" }).action).toBe("standby");
    expect(stationActivity({ ...idle, lifecycle: "unspecified" }).action).toBe("standby");
    expect(stationActivity({ ...idle, runs: [{ state: "active" }] }).action).not.toBe("standby");
    expect(stationActivity({ ...idle, tasks: [{ status: "claimed" }] }).action).not.toBe("standby");
    expect(stationActivity({ ...idle, signal: { type: "tool.start", seq: 9 } }).action).not.toBe(
      "standby",
    );
    expect(
      stationActivity({ ...idle, presence: { ...idle.presence, state: "offline" } }).action,
    ).toBe("inactive");
  });
});

describe("reported station actions", () => {
  test("human attention is reported, ends on resume or inactivity, and is not generic collaboration", () => {
    const agent = {
      presence: { state: "online", room: "meeting" },
      signal: { type: "human.waiting" },
    };
    expect(stationActivity(agent)).toEqual({ action: "human-waiting", label: "Waiting for Human" });
    expect(eventCue(agent)?.kind).toBe("human-waiting");
    expect(eventCue({ ...agent, signal: { type: "human.resumed" } })).toBeNull();
    for (const state of ["stale", "offline"])
      expect(eventCue({ ...agent, presence: { ...agent.presence, state } })).toBeNull();
    expect(stationActivity({ ...agent, lifecycle: "session", runs: [] }).action).toBe("human-waiting");
    expect(stationActivity({ ...agent, signal: null }).action).toBe("meeting");
  });
  test("webhooks retain communication while fetch is a desk web request", () => {
    expect(
      stationActivity({
        presence: { state: "online", room: "phone-booth" },
        signal: { type: "tool.call", action: "call", detail: "webhook" },
      }).label,
    ).toBe("Communication");
    expect(
      stationActivity({
        presence: { state: "online", room: "desk" },
        signal: { type: "tool.call", action: "web_request", detail: "fetch" },
      }),
    ).toEqual({ action: "typing", label: "Web Request" });
  });
  test("every Board 2D room has a non-invented interpretation", () => {
    const expected = {
      lobby: "waiting",
      barber: "onboarding",
      desk: "typing",
      whiteboard: "planning",
      library: "reading",
      workshop: "tools",
      "print-room": "output",
      "phone-booth": "communication",
      meeting: "meeting",
      pantry: "break",
      "intern-desk": "typing",
      away: "away",
    };
    for (const [room, action] of Object.entries(expected)) {
      expect(stationActivity({ presence: { state: "online", room } }).action).toBe(action);
    }
  });
  test("offline and stale agents never work; labels do not infer a skill, success, compaction or child", () => {
    for (const state of ["stale", "offline", "lobby"])
      expect(stationActivity({ presence: { state, room: "desk" } }).action).toBe("inactive");
    expect(stationActivity({ presence: { state: "online", room: "library" } }).label).toBe(
      "Reading / Research",
    );
    expect(stationActivity({ presence: { state: "online", room: "unknown" } }).action).toBe(
      "waiting",
    );
  });
});
