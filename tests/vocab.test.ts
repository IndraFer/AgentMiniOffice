import { describe, expect, test } from "bun:test";
import {
  isClientEventType,
  isEventType,
  isRoom,
  presenceState,
  roomForEvent,
  eventAction,
} from "../src/lib/vocab";

describe("room vocabulary", () => {
  test("accepts only the closed set", () => {
    expect(isRoom("workshop")).toBe(true);
    expect(isRoom("thinking-hard")).toBe(false);
    expect(isRoom("")).toBe(false);
    expect(isRoom(null)).toBe(false);
  });

  test("event types have a closed set too", () => {
    expect(isEventType("tool.call")).toBe(true);
    expect(isEventType("vibe.check")).toBe(false);
  });

  test("clients may not send server owned task events", () => {
    expect(isClientEventType("task.acked")).toBe(false);
    expect(isClientEventType("run.started")).toBe(true);
  });
});

describe("tool to room", () => {
  test.each(['tool.start','tool.call'])('%s uses only common standalone names', type => {
    for(const [tool,action] of Object.entries({BASH:'use_tools',grep:'search_content',rg:'search_content',ls:'lookup_file',write:'write',edit:'write',ffgrep:'other',subagent:'other',webhook:'other',export:'other'} as const)) {
      expect(eventAction(type,{tool},null)).toBe(action);
      expect(eventAction(type,{tool},'desk')).toBeUndefined();
    }
  });
});

describe("event to room", () => {
  test("plan.start splits by kind", () => {
    expect(roomForEvent("plan.start", { kind: "brainstorm" })).toBe("whiteboard");
    expect(roomForEvent("plan.start", { kind: "design" })).toBe("whiteboard");
    expect(roomForEvent("plan.start", { kind: "read" })).toBe("library");
    expect(roomForEvent("plan.start", { kind: "research" })).toBe("library");
  });

  test("error never moves the avatar", () => {
    expect(roomForEvent("error", { code: "boom" })).toBeNull();
  });

  test("tool end does not bounce the avatar back", () => {
    expect(roomForEvent("tool.end", { tool: "bash" })).toBeNull();
  });

  test("subagent calls use the phone booth and finish back at the desk", () => {
    expect(roomForEvent("spawn.started", { child_label: "intern" })).toBe("phone-booth");
    expect(roomForEvent("spawn.finished", {})).toBe("desk");
  });

  test("waiting on a human uses the meeting room and resumes at the desk", () => {
    expect(roomForEvent("human.waiting", {})).toBe("meeting");
    expect(roomForEvent("human.resumed", {})).toBe("desk");
  });
});

describe("presence thresholds", () => {
  const online = 30_000;
  const stale = 90_000;

  test("no heartbeat yet is lobby", () => {
    expect(presenceState(null, 1_000, online, stale)).toBe("lobby");
  });

  test("below the online threshold is online", () => {
    expect(presenceState(0, 0, online, stale)).toBe("online");
    expect(presenceState(0, 29_999, online, stale)).toBe("online");
  });

  test("between thresholds is stale, not offline", () => {
    expect(presenceState(0, 30_000, online, stale)).toBe("stale");
    expect(presenceState(0, 89_999, online, stale)).toBe("stale");
  });

  test("past the stale threshold is offline", () => {
    expect(presenceState(0, 90_000, online, stale)).toBe("offline");
    expect(presenceState(0, 10_000_000, online, stale)).toBe("offline");
  });
});
