import { describe, expect, test } from "bun:test";
import { createAgent } from "../src/lib/agents";
import { Live, type LiveEvent } from "../src/lib/live";
import { uuidv7 } from "../src/lib/uuid";
import { createOffice, event } from "./helpers";

/** Minimal shape of a reader, so the helper does not fight the DOM lib generics. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/** Read an SSE body until the needle appears, or fail with what did arrive. */
async function readUntil(reader: ChunkReader, needle: string, timeoutMs = 3000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for "${needle}"`)), remaining),
      ),
    ]);

    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.includes(needle)) return buffer;
  }

  throw new Error(`no "${needle}" in stream. received: ${buffer.slice(0, 400)}`);
}

describe("sse stream", () => {
  test("requires a share token", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/stream");
    expect(res.status).toBe(401);
  });

  test("an agent token cannot open the stream", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/stream", {
      headers: { authorization: `Bearer ${office.agentToken}` },
    });
    expect(res.status).toBe(401);
  });

  test("sends a snapshot first, then presence changes", async () => {
    const office = await createOffice();
    const controller = new AbortController();

    const res = await office.app.request(`/api/v1/stream?share=${office.shareToken}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    try {
      const first = await readUntil(reader, "event: snapshot");
      expect(first).toContain('"org"');
      expect(first).toContain("pi-test");

      await office.heartbeat({ seq: 1, task: "stream me" });
      const second = await readUntil(reader, "event: presence");
      expect(second).toContain("agent_id");
      expect(second).toContain('"state":"online"');

      // Same state and room: content changes still have to reach the browser.
      await office.heartbeat({ seq: 2, task: "revised title", activity: "Reviewing output" });
      const third = await readUntil(reader, "revised title");
      expect(third).toContain('"activity":"Reviewing output"');
      await office.heartbeat({ seq: 3, activity: "Checking citations" });
      const fourth = await readUntil(reader, "Checking citations");
      expect(fourth).toContain('"task":"revised title"');
      await office.heartbeat({ seq: 4, state: "idle" });
      expect(await readUntil(reader, '"heartbeat_state":"idle"')).toContain('"last_seq":4');
      await office.events([event(5, "note", { title: "new activity" })]);
      await readUntil(reader, "event: signal");
      await office.heartbeat({ seq: 6, state: "idle" });
      expect(await readUntil(reader, '"last_seq":6')).toContain('"heartbeat_state":"idle"');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});

describe("task completion stream", () => {
  test("ack/fail reach an open office stream; rejected finishes emit nothing", async () => {
    const office = await createOffice();
    const run = await office.startRun(1);
    const ackId = office.addTask("complete");
    const failId = office.addTask("fail");
    await office.claim(ackId, run);
    await office.claim(failId, run);
    const controller = new AbortController();
    const response = await office.app.request(
      `/api/v1/offices/test-office/stream?share=${office.shareToken}`,
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing stream reader");
    const seen: LiveEvent[] = [];
    const unsubscribe = office.live.bus.subscribe((event) => {
      if (event.event === "task") seen.push(event);
    });
    try {
      await readUntil(reader, "event: snapshot");
      expect((await office.ack(ackId, "019ac1f0-0000-7000-8000-0000000000ff")).status).toBe(409);
      expect(seen).toHaveLength(0);
      expect((await office.ack(ackId, run)).status).toBe(200);
      expect(await readUntil(reader, '"status":"acked"')).toContain(ackId);
      expect((await office.fail(failId, run)).status).toBe(200);
      expect(await readUntil(reader, '"status":"failed"')).toContain(failId);
      expect(seen).toHaveLength(2);
    } finally {
      unsubscribe();
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});

describe("broadcaster", () => {
  test("delivers to every subscriber and stops after unsubscribe", () => {
    const bus = new Live(db(), store()).bus;
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(`a:${event.event}`));
    bus.subscribe((event) => seen.push(`b:${event.event}`));

    bus.publish({ event: "counters", data: {} });
    expect(seen).toEqual(["a:counters", "b:counters"]);

    off();
    bus.publish({ event: "counters", data: {} });
    expect(seen).toEqual(["a:counters", "b:counters", "b:counters"]);
    expect(bus.size).toBe(1);
  });

  test("a throwing subscriber does not stop the rest", () => {
    const bus = new Live(db(), store()).bus;
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("broken client");
    });
    bus.subscribe((event) => seen.push(event.event));

    expect(() => bus.publish({ event: "task", data: {} })).not.toThrow();
    expect(seen).toEqual(["task"]);
  });
});

describe("live counters", () => {
  test("publishes only when the numbers actually change", async () => {
    const office = await createOffice();
    const events: LiveEvent[] = [];
    office.live.bus.subscribe((event) => {
      if (event.event === "counters") events.push(event);
    });

    office.live.countersFor(office.orgId);
    const first = events.length;
    expect(first).toBe(1);

    office.live.countersFor(office.orgId);
    expect(events.length).toBe(first);

    office.addTask("changes the counter");
    office.live.countersFor(office.orgId);
    expect(events.length).toBe(first + 1);

    const last = events.at(-1);
    if (!last) throw new Error("expected a counters event");
    expect((last.data as { tasks_pending: number }).tasks_pending).toBe(1);
  });

  test("a heartbeat publishes presence scoped to its office", async () => {
    const office = await createOffice();
    const events: LiveEvent[] = [];
    office.live.bus.subscribe((event) => {
      if (event.event === "presence") events.push(event);
    });

    await office.heartbeat({ seq: 1, task: "hello" });
    expect(events.length).toBeGreaterThan(0);

    const data = events[0]?.data as { agent_id: string; state: string; org_id: string };
    expect(data.agent_id).toBe(office.agentId);
    expect(data.org_id).toBe(office.orgId);
    expect(data.state).toBe("online");
  });
});

describe("stream scoping", () => {
  test("a real office stream receives its signals but not another office on the same bus", async () => {
    const office = await createOffice();
    const foreignOrg = uuidv7();
    office.db
      .prepare("INSERT INTO organizations (id,name,slug,created_at) VALUES (?,?,?,?)")
      .run(foreignOrg, "Foreign", "foreign", new Date().toISOString());
    const created = createAgent(office.db, foreignOrg, { name: "Foreign agent", kind: "test" });
    if ("failure" in created) throw new Error(created.failure);
    const other = created.agent;
    const controller = new AbortController();
    const response = await office.app.request(
      `/api/v1/offices/test-office/stream?share=${office.shareToken}`,
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing stream reader");
    try {
      await readUntil(reader, "event: snapshot");
      const foreign = await office.app.request(`/api/v1/agents/${other.agentId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [event(1, "error", { code: "FOREIGN_ERROR" })] }),
      });
      expect(foreign.status).toBe(200);
      office.live.bus.publish({ event: "signal", data: { marker: "UNSCOPED_MUST_NOT_LEAK" } });
      await office.events([event(1, "error", { code: "OWN_ERROR" })]);
      const frames = await readUntil(reader, "OWN_ERROR");
      expect(frames).toContain("event: signal");
      expect(frames).not.toContain("FOREIGN_ERROR");
      expect(frames).not.toContain("UNSCOPED_MUST_NOT_LEAK");
      expect(frames).not.toContain(other.agentId);
      expect(frames).toContain(office.agentId);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
      office.db.close();
    }
  });
});

// Small helpers so the broadcaster tests do not need a full office fixture.
function db(): ConstructorParameters<typeof Live>[0] {
  return {
    driver: "bun:sqlite",
    exec: () => {},
    prepare: () => ({
      run: () => ({ changes: 0 }),
      get: () => null,
      all: () => [],
    }),
    close: () => {},
  };
}

function store(): ConstructorParameters<typeof Live>[1] {
  return {
    observe: () => {},
    list: () => [],
  } as unknown as ConstructorParameters<typeof Live>[1];
}
