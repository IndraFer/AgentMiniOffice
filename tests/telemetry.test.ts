import { describe, expect, test } from "bun:test";
import { createAgent } from "../src/lib/agents";
import type { LiveEvent } from "../src/lib/live";
import { uuidv7 } from "../src/lib/uuid";
import { createOffice, event } from "./helpers";

type TestSnapshot = {
  agents: {
    runs: { id: string; parent_run_id?: string | null; parent_agent_id?: string | null }[];
  }[];
};

describe("explicit lifecycle", () => {
  test("registration persists lifecycle in existing capabilities, independent of harness kind", async () => {
    const office = await createOffice();
    try {
      for (const lifecycle of ["daemon", "session"] as const) {
        const result = createAgent(office.db, office.orgId, {
          name: lifecycle,
          kind: "pi",
          lifecycle,
        });
        expect("agent" in result).toBe(true);
      }
      const result = (await (await office.snapshot()).json()) as {
        agents: { name: string; lifecycle: string }[];
      };
      expect(result.agents.find((agent) => agent.name === "daemon")?.lifecycle).toBe("daemon");
      expect(result.agents.find((agent) => agent.name === "session")?.lifecycle).toBe("session");
      expect(result.agents.find((agent) => agent.name === "pi-test")?.lifecycle).toBe(
        "unspecified",
      );
    } finally {
      office.db.close();
    }
  });
});

describe("committed event telemetry", () => {
  test("snapshot preserves accepted batch order when UUID order disagrees", async () => {
    const office = await createOffice();
    try {
      const first = { ...event(1, "note"), event_id: uuidv7(2000) };
      const last = { ...event(2, "human.waiting"), event_id: uuidv7(1000) };
      expect((await office.events([first, last])).status).toBe(200);
      const snapshot = (await (await office.snapshot()).json()) as {
        agents: { signal: { id: string; type: string } }[];
      };
      expect(snapshot.agents[0]?.signal).toMatchObject({
        id: last.event_id,
        type: "human.waiting",
      });
    } finally {
      office.db.close();
    }
  });
  test("accepted events publish minimal signal metadata; rejected and duplicate events do not", async () => {
    const office = await createOffice();
    const seen: LiveEvent[] = [];
    const off = office.live.bus.subscribe((e) => seen.push(e));
    try {
      const report = event(1, "error", { code: "E_BUILD", nested: { private: "never broadcast" } });
      expect((await office.events([report])).status).toBe(200);
      const signals = seen.filter((e) => String(e.event) === "signal");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.data).toMatchObject({
        org_id: office.orgId,
        agent_id: office.agentId,
        signal: { id: report.event_id, type: "error", detail: "E_BUILD", seq: 1 },
      });
      expect(JSON.stringify(signals)).not.toContain("never broadcast");
      expect(
        (await office.events([{ ...report, seq: 2 }, event(3, "error", { prompt: "rejected" })]))
          .status,
      ).toBe(200);
      expect(seen.filter((e) => String(e.event) === "signal")).toHaveLength(1);
      expect(office.store.lastSeq(office.agentId)).toBe(1);
    } finally {
      off();
      office.db.close();
    }
  });

  test("a failed transaction publishes nothing and does not advance in-memory presence or sequence", async () => {
    const office = await createOffice();
    const seen: LiveEvent[] = [];
    const off = office.live.bus.subscribe((e) => seen.push(e));
    office.db.exec(
      "CREATE TRIGGER test_reject_error BEFORE INSERT ON events WHEN NEW.type = 'error' BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
    );
    try {
      const response = await office.events([event(1, "run.started"), event(2, "error")]);
      expect(response.status).toBe(500);
      expect(office.db.prepare("SELECT count(*) AS n FROM runs").get<{ n: number }>()?.n).toBe(0);
      expect(seen).toHaveLength(0);
      expect(office.store.lastSeq(office.agentId)).toBe(0);
      expect(office.store.list(office.orgId)).toHaveLength(0);
    } finally {
      off();
      office.db.close();
    }
  });
});

describe("real parent-run relationships", () => {
  test("child batches preserve the main station and reject excess beyond 32", async () => {
    const office = await createOffice();
    try {
      await office.heartbeat({ seq: 1 });
      const parent = await office.startRun(2);
      await office.events([event(3, "spawn.started", {}, { run_id: parent })]);
      const batch = Array.from({ length: 33 }, (_, index) =>
        event(index + 4, "run.started", { parent_run_id: parent }, { run_id: uuidv7() }),
      );
      const result = (await (await office.events(batch)).json()) as {
        accepted: number;
        rejected: { code: string }[];
      };
      expect(result.accepted).toBe(32);
      expect(result.rejected.map((row) => row.code)).toEqual(["capacity"]);
      expect(office.store.list(office.orgId)[0]?.room).toBe("phone-booth");
    } finally {
      office.db.close();
    }
  });
  test("same-office cross-agent parent links are exposed without changing the parent", async () => {
    const office = await createOffice();
    try {
      const parent = await office.startRun(1);
      const created = createAgent(office.db, office.orgId, {
        name: "Registered child",
        kind: "test",
      });
      if ("failure" in created) throw new Error(created.failure);
      const child = created.agent;
      await office.app.request(`/api/v1/agents/${child.agentId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${child.token}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [event(1, "run.started", { parent_run_id: parent })] }),
      });
      const snapshot = (await (await office.snapshot()).json()) as {
        agents: { id: string; runs: { parent_agent_id: string | null }[] }[];
      };
      expect(
        snapshot.agents.find((agent) => agent.id === child.agentId)?.runs[0]?.parent_agent_id,
      ).toBe(office.agentId);
      expect(
        office.db.prepare("SELECT state FROM runs WHERE id = ?").get<{ state: string }>(parent)
          ?.state,
      ).toBe("active");
    } finally {
      office.db.close();
    }
  });

  test("a same-agent child keeps its main run active; replay cannot abandon runs", async () => {
    const office = await createOffice();
    try {
      const parent = await office.startRun(1);
      const childId = uuidv7();
      const orphan = await (await office.events([event(2,'run.started',{parent_run_id:uuidv7(),avatar_label:'Scout'},{run_id:childId})])).json();
      expect(orphan).toMatchObject({rejected:[{code:'invalid_run'}]});
      const child = event(
        2,
        "run.started",
        { parent_run_id: parent, title: "Research child" },
        { run_id: childId },
      );
      await office.events([child]);
      const snapshot = (await (await office.snapshot()).json()) as TestSnapshot;
      const runs = snapshot.agents[0]?.runs ?? [];
      expect(runs).toHaveLength(2);
      expect(runs.find((run: { id: string }) => run.id === childId)).toMatchObject({
        parent_run_id: parent,
        parent_agent_id: office.agentId,
        kind: "subagent",
      });
      await office.events([{ ...child, seq: 3 }]);
      expect(
        office.db
          .prepare("SELECT count(*) AS n FROM runs WHERE state = 'active'")
          .get<{ n: number }>()?.n,
      ).toBe(2);
      expect(office.store.lastSeq(office.agentId)).toBe(2);
    } finally {
      office.db.close();
    }
  });

  test("run ID collisions and another agent's run cannot mutate lifecycle or publish signals", async () => {
    const office = await createOffice();
    const seen: LiveEvent[] = [];
    try {
      const ownRun = await office.startRun(1);
      const created = createAgent(office.db, office.orgId, { name: "Other agent", kind: "test" });
      if ("failure" in created) throw new Error(created.failure);
      const foreignRun = uuidv7();
      office.db
        .prepare(
          "INSERT INTO runs (id,org_id,agent_id,state,kind,started_at) VALUES (?,?,?,'active','main',?)",
        )
        .run(foreignRun, office.orgId, created.agent.agentId, new Date().toISOString());
      const off = office.live.bus.subscribe((e) => seen.push(e));
      const response = await office.events([
        event(2, "run.started", {}, { run_id: ownRun }),
        event(3, "run.finished", {}, { run_id: foreignRun }),
      ]);
      const result = (await response.json()) as { rejected: { code: string }[] };
      expect(result.rejected.map((row) => row.code)).toEqual(["invalid_run", "invalid_run"]);
      expect(
        office.db
          .prepare("SELECT count(*) AS n FROM runs WHERE state = 'active'")
          .get<{ n: number }>()?.n,
      ).toBe(2);
      expect(seen).toHaveLength(0);
      expect(office.store.lastSeq(office.agentId)).toBe(1);
      off();
    } finally {
      office.db.close();
    }
  });

  test("foreign parents are not linked or exposed, including legacy rows", async () => {
    const office = await createOffice();
    try {
      const foreignOrg = uuidv7(),
        foreignRun = uuidv7();
      office.db
        .prepare("INSERT INTO organizations (id,name,slug,created_at) VALUES (?,?,?,?)")
        .run(foreignOrg, "Other", "other", new Date().toISOString());
      const created = createAgent(office.db, foreignOrg, { name: "Other agent", kind: "test" });
      if ("failure" in created) throw new Error(created.failure);
      const other = created.agent;
      office.db
        .prepare(
          "INSERT INTO runs (id,org_id,agent_id,state,kind,started_at) VALUES (?,?,?,'active','main',?)",
        )
        .run(foreignRun, foreignOrg, other.agentId, new Date().toISOString());
      const childId = uuidv7();
      await office.events([
        event(1, "run.started", { parent_run_id: foreignRun }, { run_id: childId }),
      ]);
      expect(
        office.db
          .prepare("SELECT parent_run_id FROM runs WHERE id = ?")
          .get<{ parent_run_id: string | null }>(childId)?.parent_run_id,
      ).toBeNull();
      // Historical bad links must not be exposed by the new read projection either.
      office.db
        .prepare("UPDATE runs SET parent_run_id = ?, kind = 'subagent' WHERE id = ?")
        .run(foreignRun, childId);
      const snapshot = (await (await office.snapshot()).json()) as TestSnapshot;
      expect(snapshot.agents[0]?.runs[0]).toMatchObject({
        parent_run_id: null,
        parent_agent_id: null,
      });
      expect(JSON.stringify(snapshot)).not.toContain(foreignRun);
      expect(JSON.stringify(snapshot)).not.toContain(other.agentId);
    } finally {
      office.db.close();
    }
  });
});
