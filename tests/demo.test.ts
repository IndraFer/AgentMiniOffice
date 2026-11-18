import { describe, expect, test } from "bun:test";
import { hashPassword } from "../src/lib/passwords";
import { createTask } from "../src/lib/tasks";
import { uuidv7 } from "../src/lib/uuid";
import { createOffice } from "./helpers";

const PASSWORD = "correct-horse-battery";

function addMember(
  office: Awaited<ReturnType<typeof createOffice>>,
  email: string,
  role: "owner" | "viewer",
): void {
  office.db
    .prepare(
      `INSERT INTO members (id, org_id, email, display_name, role, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      uuidv7(),
      office.orgId,
      email,
      role,
      role,
      hashPassword(PASSWORD),
      new Date().toISOString(),
    );
}

async function signIn(
  office: Awaited<ReturnType<typeof createOffice>>,
  email: string,
): Promise<string> {
  const res = await office.app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function withOwner() {
  const office = await createOffice();
  addMember(office, "owner@example.com", "owner");
  const cookie = await signIn(office, "owner@example.com");
  return { office, cookie };
}

describe("demo", () => {
  test("requires a member session", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/offices/test-office/demo", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("starts simulated agents, drives them, and stops", async () => {
    const { office, cookie } = await withOwner();

    const start = await office.app.request("/api/v1/offices/test-office/demo", {
      method: "POST",
      headers: { cookie },
    });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { agents: number }).agents).toBeGreaterThan(0);

    const simulated = office.db
      .prepare("SELECT count(*) AS n FROM agents WHERE simulator = 1")
      .get<{ n: number }>();
    expect(Number(simulated?.n)).toBeGreaterThan(0);

    // Let staggered starts happen without waiting on the real interval.
    for (let tick = 0; tick < 9; tick++) await office.demo.tick(office.orgId);

    const presence = office.store.list(office.orgId);
    expect(presence.length).toBeGreaterThan(0);
    expect(presence.every((entry) => entry.state === "online")).toBe(true);

    const running = await office.app.request("/api/v1/offices", { headers: { cookie } });
    const runningBody = (await running.json()) as { offices: { demo_running: boolean }[] };
    expect(runningBody.offices[0]?.demo_running).toBe(true);

    const demoId = presence[0]!.agent_id;
    expect(createTask(office.db, office.orgId, demoId, "Demo only", null, 0).task).toBeDefined();
    const realTask = office.addTask("Keep offline worker task");
    const stop = await office.app.request("/api/v1/offices/test-office/demo", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(stop.status).toBe(200);

    const after = await office.app.request("/api/v1/offices", { headers: { cookie } });
    const afterBody = (await after.json()) as { offices: { demo_running: boolean }[] };
    expect(afterBody.offices[0]?.demo_running).toBe(false);
    expect(office.db.prepare("SELECT id FROM agents WHERE simulator=1").all()).toHaveLength(0);
    expect(office.store.list(office.orgId)).toHaveLength(0);
    office.store.flush(office.db);
    expect(office.db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: realTask }]);
    expect(office.db.prepare(`SELECT agent_id FROM (SELECT agent_id FROM agent_tokens UNION ALL SELECT agent_id FROM agent_presence UNION ALL SELECT agent_id FROM runs UNION ALL SELECT agent_id FROM events) WHERE agent_id=?`).get(demoId)).toBeNull();
    const snap = await (await office.snapshot()).json() as {agents:{id:string}[]};
    expect(snap.agents.map((a: { id: string }) => a.id)).toEqual([office.agentId]);
  });

  test("real demo API staggers starts and varies each agent's work and idle durations", async () => {
    const { office, cookie } = await withOwner();
    try {
      await office.app.request("/api/v1/offices/test-office/demo", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ count: 8 }),
      });
      const starts = new Map<string, number>();
      const transitions = new Map<string, { tick: number; type: string }[]>();
      let cursor = 0;
      let overlappingWorkAndIdle = false;
      let largestCohort = 0;
      let firstOutput = Infinity;
      for (let tick = 0; tick < 220; tick++) {
        await office.demo.tick(office.orgId);
        const presence = office.store.list(office.orgId);
        if (
          presence.some(
            (entry) => entry.room === "print-room" && entry.task === "export dashboard summary",
          )
        )
          firstOutput = Math.min(firstOutput, tick);
        for (const entry of presence)
          if (entry.state === "online" && !starts.has(entry.agent_id))
            starts.set(entry.agent_id, tick);
        const idle = presence.filter((entry) => entry.heartbeat_state === "idle").length;
        if (idle > 0 && idle < 4 && presence.some((entry) => entry.heartbeat_state === "working"))
          overlappingWorkAndIdle = true;
        const rows = office.db
          .prepare(
            "SELECT rowid AS position, agent_id, type FROM events WHERE rowid > ? ORDER BY rowid",
          )
          .all<{ position: number; agent_id: string; type: string }>(cursor);
        const changed = new Set<string>();
        for (const row of rows) {
          cursor = row.position;
          if (row.type === "run.started") continue;
          const history = transitions.get(row.agent_id) ?? [];
          history.push({ tick, type: row.type });
          transitions.set(row.agent_id, history);
          changed.add(row.agent_id);
        }
        largestCohort = Math.max(largestCohort, changed.size);
      }
      expect(starts.size).toBe(8);
      expect(new Set(starts.values()).size).toBeGreaterThan(3);
      expect(transitions.size).toBe(8);
      expect(largestCohort).toBeLessThan(8);
      expect(overlappingWorkAndIdle).toBe(true);
      expect(firstOutput).toBeLessThan(40);
      const idleDurations = new Set<number>();
      for (const history of transitions.values()) {
        expect(history[0]?.type).toBe("plan.end");
        expect(history.length).toBeGreaterThanOrEqual(6);
        const durations = history.slice(1).map((entry, index) => {
          const previous = history[index]!;
          const duration = entry.tick - previous.tick;
          expect(duration).toBeGreaterThanOrEqual(previous.type === "run.finished" ? 12 : 14);
          expect(duration).toBeLessThanOrEqual(previous.type === "run.finished" ? 24 : 26);
          if (previous.type === "run.finished") idleDurations.add(duration);
          return duration;
        });
        expect(new Set(durations).size).toBeGreaterThan(1);
      }
      expect(idleDurations.size).toBeGreaterThan(1);
    } finally {
      office.demo.stop(office.orgId);
    }
  });

  test("supports eight demo agents, rejects invalid counts, and declares mixed lifecycle", async () => {
    const { office, cookie } = await withOwner();
    const start = (count: number) =>
      office.app.request("/api/v1/offices/test-office/demo", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ count }),
      });
    try {
      expect((await start(99)).status).toBe(422);
      const response = await start(8);
      expect(((await response.json()) as { agents: number }).agents).toBe(8);
      await office.demo.tick(office.orgId);
      const snapshot = (await (await office.snapshot()).json()) as {
        agents: { name: string; simulator: boolean; lifecycle: string }[];
      };
      const simulated = snapshot.agents.filter((agent) => agent.simulator);
      expect(simulated.map(a => a.name).sort()).toEqual([
        'Antigravity', 'Claude', 'Codex', 'Gemini', 'Hermes', 'Mercury', 'OpenClaw', 'Pi Agent',
      ]);
      expect(new Set(simulated.map((agent) => agent.lifecycle))).toEqual(
        new Set(["daemon", "session"]),
      );
    } finally {
      office.demo.stop(office.orgId);
    }
  });

  test("immediate stop/start creates fresh identities without unflushed presence from an earlier run", async () => {
    const { office, cookie } = await withOwner();
    const start = (count: number) =>
      office.app.request("/api/v1/offices/test-office/demo", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ count }),
      });
    try {
      await start(6);
      await office.demo.tick(office.orgId);
      for (let index = 0; index < 5; index++) await office.demo.tick(office.orgId);
      const before = new Map(
        office.store.list(office.orgId).map((entry) => [entry.agent_id, entry.last_seq]),
      );
      office.demo.stop(office.orgId);
      await start(8);
      await office.demo.tick(office.orgId);
      expect(office.demo.isRunning(office.orgId)).toBe(true);
      expect(office.store.list(office.orgId).some((entry) => before.has(entry.agent_id))).toBe(
        false,
      );
    } finally {
      office.demo.stop(office.orgId);
    }
  });

  test("is idempotent while running", async () => {
    const { office, cookie } = await withOwner();
    const start = () =>
      office.app.request("/api/v1/offices/test-office/demo", {
        method: "POST",
        headers: { cookie },
      });

    expect(((await (await start()).json()) as { already_running: boolean }).already_running).toBe(
      false,
    );
    expect(((await (await start()).json()) as { already_running: boolean }).already_running).toBe(
      true,
    );
    office.demo.stop(office.orgId);
  });

  test("a viewer cannot start a demo", async () => {
    const office = await createOffice();
    addMember(office, "viewer@example.com", "viewer");
    const cookie = await signIn(office, "viewer@example.com");

    const res = await office.app.request("/api/v1/offices/test-office/demo", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });
});
