import { describe, expect, test } from "bun:test";
import { uuidv7 } from "../src/lib/uuid";
import { createOffice, event } from "./helpers";

interface ErrorBody {
  error: { code: string };
}
interface AcceptedBody {
  accepted: number;
  duplicate: number;
  rejected: { code: string }[];
}

describe("heartbeat", () => {
  test("rejects a missing token", async () => {
    const office = await createOffice();
    const res = await office.app.request(`/api/v1/agents/${office.agentId}/heartbeat`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("rejects a token issued for another agent", async () => {
    const office = await createOffice();
    const res = await office.app.request(`/api/v1/agents/${crypto.randomUUID()}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${office.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ seq: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts a heartbeat and derives presence and room", async () => {
    const office = await createOffice();
    const res = await office.heartbeat({ seq: 1, state: "working", task: "refactor auth" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { presence: { state: string; room: string } };
    expect(body.presence.state).toBe("online");
    expect(body.presence.room).toBe("desk");
    expect(office.store.view(office.agentId)?.task).toBe("refactor auth");
  });

  test("rejects a sequence that goes backwards", async () => {
    const office = await createOffice();
    await office.heartbeat({ seq: 5 });
    const res = await office.heartbeat({ seq: 4 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("invalid_seq");
  });

  test("a heartbeat does not write to disk by itself", async () => {
    const office = await createOffice();
    await office.heartbeat({ seq: 1 });
    const row = office.db.prepare("SELECT count(*) AS n FROM agent_presence").get<{ n: number }>();
    expect(Number(row?.n)).toBe(0);
  });
});

describe("events", () => {
  test("stores an event and moves the avatar by tool", async () => {
    const office = await createOffice({ roomHysteresisMs: 0 });
    await office.heartbeat({ seq: 1 });
    const res = await office.events([
      event(2, "tool.call", { tool: "bash", duration_ms: 1200, ok: true }),
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AcceptedBody).accepted).toBe(1);
    expect(office.store.view(office.agentId)?.room).toBe("workshop");
  });

  test("is idempotent on event_id", async () => {
    const office = await createOffice();
    const single = event(2, "note", { text: "hello" });

    const first = await office.events([single]);
    expect(((await first.json()) as AcceptedBody).accepted).toBe(1);

    const second = await office.events([single]);
    const body = (await second.json()) as AcceptedBody;
    expect(body.accepted).toBe(0);
    expect(body.duplicate).toBe(1);
  });

  test("rejects prompt content", async () => {
    const office = await createOffice();
    const res = await office.events([event(1, "note", { prompt: "system: you are helpful" })]);
    const body = (await res.json()) as AcceptedBody;
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]?.code).toBe("content_rejected");
  });

  test("rejects a room outside the vocabulary", async () => {
    const office = await createOffice();
    const res = await office.events([event(1, "note", {}, { room: "thinking-hard" })]);
    const body = (await res.json()) as AcceptedBody;
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]?.code).toBe("unknown_room");
  });

  test("rejects server owned event types", async () => {
    const office = await createOffice();
    const res = await office.events([event(1, "task.acked", {})]);
    const body = (await res.json()) as AcceptedBody;
    expect(body.accepted).toBe(0);
    expect(body.rejected[0]?.code).toBe("unsupported_type");
  });

  test("a second run.started abandons the first", async () => {
    const office = await createOffice();
    await office.events([event(1, "run.started", { title: "first" })]);
    await office.events([event(2, "run.started", { title: "second" })]);

    const runs = office.db.prepare("SELECT state FROM runs").all<{ state: string }>();
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.state === "abandoned")).toHaveLength(1);
    expect(runs.filter((run) => run.state === "active")).toHaveLength(1);
  });

  test("run.finished closes the active run", async () => {
    const office = await createOffice();
    const runId = uuidv7();
    const started = event(1, "run.started", { title: "work" }, { run_id: runId });
    await office.events([started]);

    await office.events([event(2, "run.finished", { summary: "done" }, { run_id: runId })]);
    const row = office.db
      .prepare("SELECT state, finished_at FROM runs")
      .get<{ state: string; finished_at: string | null }>();
    expect(row?.state).toBe("finished");
    expect(row?.finished_at).not.toBeNull();
  });
});

describe("snapshot", () => {
  test("requires a share token", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/snapshot");
    expect(res.status).toBe(401);
  });

  test("an agent token cannot open the panel", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/snapshot", {
      headers: { authorization: `Bearer ${office.agentToken}` },
    });
    expect(res.status).toBe(401);
  });

  test("carries the latest signal, so the panel can explain the room", async () => {
    const office = await createOffice({ roomHysteresisMs: 0 });
    await office.heartbeat({ seq: 1 });
    await office.events([event(2, "tool.call", { tool: "bash", duration_ms: 10 })]);

    const res = await office.snapshot();
    const body = (await res.json()) as {
      agents: { signal: { type: string; detail: string; at: string } | null }[];
    };

    expect(body.agents[0]?.signal?.type).toBe("tool.call");
    expect(body.agents[0]?.signal?.detail).toBe("bash");
  });

  test("returns agents with derived presence and counters", async () => {
    const office = await createOffice();
    await office.heartbeat({ seq: 1, task: "refactor" });

    const res = await office.snapshot();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: { name: string; presence: { state: string } }[];
      counters: { agents_online: number };
    };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.presence.state).toBe("online");
    expect(body.counters.agents_online).toBe(1);
  });

  test("unknown paths return the documented error shape", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });
});

describe("health", () => {
  test("reports ok without auth and leaks nothing", async () => {
    const office = await createOffice();
    const res = await office.app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["db", "driver", "ok", "uptime_s", "version"]);
  });
});
