import { describe, expect, test } from "bun:test";
import { PresenceStore } from "../src/lib/state";

function store(roomHysteresisMs = 2_000): PresenceStore {
  return new PresenceStore({ onlineMs: 30_000, staleMs: 90_000, roomHysteresisMs });
}

describe("presence store", () => {
  test("a first heartbeat brings the agent from lobby to desk", () => {
    const presence = store();
    const entry = presence.heartbeat("agent-1", "org-1", { seq: 1, task: "refactor auth" }, 1_000);
    expect(entry.state).toBe("online");
    expect(entry.room).toBe("desk");
    expect(entry.task).toBe("refactor auth");
  });

  test("stale then offline, and offline is shown as away", () => {
    const presence = store();
    presence.heartbeat("agent-1", "org-1", { seq: 1 }, 0);

    presence.sweep(60_000);
    expect(presence.view("agent-1")?.state).toBe("stale");
    // Stale still sits at its desk. Only offline empties the room.
    expect(presence.view("agent-1")?.room).toBe("desk");

    presence.sweep(120_000);
    expect(presence.view("agent-1")?.state).toBe("offline");
    expect(presence.view("agent-1")?.room).toBe("away");
  });

  test("the stored room survives going offline and coming back", () => {
    const presence = store();
    presence.heartbeat("agent-1", "org-1", { seq: 1 }, 0);
    presence.applyRoom("agent-1", "org-1", "workshop", 1_000);
    presence.applyRoom("agent-1", "org-1", "workshop", 2_100);
    expect(presence.view("agent-1")?.room).toBe("workshop");

    presence.sweep(200_000);
    expect(presence.view("agent-1")?.room).toBe("away");

    presence.heartbeat("agent-1", "org-1", { seq: 2 }, 200_100);
    expect(presence.view("agent-1")?.room).toBe("workshop");
  });

  test("a room may not change faster than the window", () => {
    const presence = store(2_000);
    presence.heartbeat("agent-1", "org-1", { seq: 1 }, 0);

    presence.applyRoom("agent-1", "org-1", "workshop", 1_000);
    expect(presence.view("agent-1")?.room).toBe("desk");

    presence.applyRoom("agent-1", "org-1", "workshop", 2_000);
    expect(presence.view("agent-1")?.room).toBe("workshop");
  });

  test("the avatar tracks the latest intent, not the proposal that arrived first", () => {
    const presence = store(2_000);
    presence.heartbeat("agent-1", "org-1", { seq: 1 }, 0);

    presence.applyRoom("agent-1", "org-1", "workshop", 500);
    presence.applyRoom("agent-1", "org-1", "library", 1_200);
    expect(presence.view("agent-1")?.room).toBe("desk");

    // Window since the last change has passed, so the newest proposal wins.
    presence.applyRoom("agent-1", "org-1", "pantry", 2_100);
    expect(presence.view("agent-1")?.room).toBe("pantry");

    // And the window restarts from that change.
    presence.applyRoom("agent-1", "org-1", "meeting", 3_000);
    expect(presence.view("agent-1")?.room).toBe("pantry");

    presence.applyRoom("agent-1", "org-1", "meeting", 4_200);
    expect(presence.view("agent-1")?.room).toBe("meeting");
  });

  test("zero hysteresis applies a room immediately", () => {
    const presence = store(0);
    presence.heartbeat("agent-1", "org-1", { seq: 1 }, 0);
    presence.applyRoom("agent-1", "org-1", "workshop", 10);
    expect(presence.view("agent-1")?.room).toBe("workshop");
  });

  test("the sweeper resolves a proposed room without waiting for another event", () => {
    const presence = store(2_000);
    presence.heartbeat("agent-1", "org-1", { seq: 1 }, 0);

    presence.applyRoom("agent-1", "org-1", "workshop", 1_000);
    expect(presence.view("agent-1")?.room).toBe("desk");

    presence.sweep(2_000);
    expect(presence.view("agent-1")?.room).toBe("workshop");
  });

  test("sequence never goes backwards in the store", () => {
    const presence = store();
    presence.heartbeat("agent-1", "org-1", { seq: 5 }, 0);
    presence.heartbeat("agent-1", "org-1", { seq: 3 }, 10);
    expect(presence.lastSeq("agent-1")).toBe(5);
  });
});
