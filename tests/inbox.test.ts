import { describe, expect, test } from "bun:test";
import { expireLeases } from "../src/lib/tasks";
import { createOffice } from "./helpers";

interface InboxBody {
  tasks: { id: string; title: string; priority: number; lease_seconds: number }[];
}
interface ClaimBody {
  task: { id: string; status: string; lease_expires_at: string };
  lease_seconds: number;
}
interface ErrorBody {
  error: { code: string; message: string };
}

describe("inbox listing", () => {
  test("lists only pending tasks, highest priority first", async () => {
    const office = await createOffice();
    office.addTask("low priority", 0);
    office.addTask("high priority", 5);

    const res = await office.inbox();
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxBody;
    expect(body.tasks.map((task) => task.title)).toEqual(["high priority", "low priority"]);
    expect(body.tasks[0]?.lease_seconds).toBe(60);
  });

  test("a task claimed by this agent disappears from the pending list", async () => {
    const office = await createOffice();
    const taskId = office.addTask("claim me");
    await office.startRun(1);

    expect(((await (await office.inbox()).json()) as InboxBody).tasks).toHaveLength(1);
    const claimed = await office.claim(taskId, (await office.startRun(2)) ?? "");
    expect(claimed.status).toBe(200);

    const body = (await (await office.inbox()).json()) as InboxBody;
    expect(body.tasks).toHaveLength(0);
  });

  test("an agent token cannot read another agent's inbox", async () => {
    const office = await createOffice();
    const res = await office.app.request(
      "/api/v1/agents/019ac1f0-0000-7000-8000-00000000dead/inbox",
      {
        headers: { authorization: `Bearer ${office.agentToken}` },
      },
    );
    expect(res.status).toBe(401);
  });
});

describe("claim", () => {
  test("requires an active run", async () => {
    const office = await createOffice();
    const taskId = office.addTask("needs a run");

    const res = await office.claim(taskId, "019ac1f0-0000-7000-8000-0000000000ff");
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("conflict");
  });

  test("takes a lease and returns it", async () => {
    const office = await createOffice({ leaseSeconds: 45 });
    const taskId = office.addTask("lease me");
    const runId = await office.startRun(1);

    const res = await office.claim(taskId, runId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimBody;
    expect(body.task.status).toBe("claimed");
    expect(body.lease_seconds).toBe(45);
    expect(Date.parse(body.task.lease_expires_at)).toBeGreaterThan(Date.now());
  });

  test("another run cannot steal a live lease", async () => {
    const office = await createOffice();
    const taskId = office.addTask("contested");
    const firstRun = await office.startRun(1);
    await office.claim(taskId, firstRun);

    // A second run.started abandons the first, so create the rival run first, then re-open.
    const rivalRun = await office.startRun(2);
    const res = await office.claim(taskId, rivalRun);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("lease_held");
  });

  test("the holder can renew its own lease", async () => {
    const office = await createOffice();
    const taskId = office.addTask("renew me");
    const runId = await office.startRun(1);

    const first = (await (await office.claim(taskId, runId)).json()) as ClaimBody;
    const second = (await (await office.claim(taskId, runId)).json()) as ClaimBody;

    expect(Date.parse(second.task.lease_expires_at)).toBeGreaterThanOrEqual(
      Date.parse(first.task.lease_expires_at),
    );
    expect(second.task.status).toBe("claimed");
  });

  test("claiming an acked task is a conflict", async () => {
    const office = await createOffice();
    const taskId = office.addTask("already done");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);
    await office.ack(taskId, runId);

    const res = await office.claim(taskId, runId);
    expect(res.status).toBe(409);
  });
});

describe("finishing", () => {
  test("only the lease holder can ack", async () => {
    const office = await createOffice();
    const taskId = office.addTask("mine");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);

    const wrong = await office.ack(taskId, "019ac1f0-0000-7000-8000-0000000000aa");
    expect(wrong.status).toBe(409);

    const right = await office.ack(taskId, runId, "shipped");
    expect(right.status).toBe(200);
    expect(((await right.json()) as ClaimBody).task.status).toBe("acked");
    expect((await office.ack(taskId, runId, 'shipped')).status).toBe(200);
    expect((await office.ack(taskId, runId, 'another result')).status).toBe(409);
    expect((await office.fail(taskId, runId, 'shipped')).status).toBe(409);
    expect((await office.ack(taskId, '019ac1f0-0000-7000-8000-0000000000aa', 'shipped')).status).toBe(409);
  });

  test("ack records a server origin task.acked event", async () => {
    const office = await createOffice();
    const taskId = office.addTask("timeline me");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);
    await office.ack(taskId, runId);

    const events = office.db
      .prepare("SELECT type, origin FROM events WHERE type LIKE 'task.%' ORDER BY received_at")
      .all<{ type: string; origin: string }>();
    expect(events.map((row) => row.type)).toEqual(["task.claimed", "task.acked"]);
    expect(events.every((row) => row.origin === "server")).toBe(true);
  });

  test("fail marks the task failed and keeps it out of the inbox", async () => {
    const office = await createOffice();
    const taskId = office.addTask("will fail");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);

    expect((await office.fail(taskId, runId, "no access")).status).toBe(200);

    const body = (await (await office.inbox()).json()) as InboxBody;
    expect(body.tasks).toHaveLength(0);
  });

  test("an oversized result is rejected", async () => {
    const office = await createOffice();
    const taskId = office.addTask("too much text");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);

    const res = await office.ack(taskId, runId, "x".repeat(9000));
    expect(res.status).toBe(413);
  });
});

describe("lease expiry", () => {
  test("an expired lease returns the task to pending and records it", async () => {
    const office = await createOffice({ leaseSeconds: 60 });
    const taskId = office.addTask("abandoned");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);

    // Expired holders cannot finish even before the sweeper returns the task to pending.
    office.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),taskId);
    expect((await office.ack(taskId,runId)).status).toBe(409);
    expect((await office.fail(taskId,runId,'late')).status).toBe(409);
    // Pretend a minute and a half passed.
    const returned = expireLeases(office.db, Date.now() + 90_000);
    expect(returned).toBe(1);

    const row = office.db
      .prepare("SELECT status, claimed_by_run FROM tasks WHERE id = ?")
      .get<{ status: string; claimed_by_run: string | null }>(taskId);
    expect(row?.status).toBe("pending");
    expect(row?.claimed_by_run).toBeNull();

    const expired = office.db
      .prepare("SELECT count(*) AS n FROM events WHERE type = 'task.expired'")
      .get<{ n: number }>();
    expect(Number(expired?.n)).toBe(1);

    const body = (await (await office.inbox()).json()) as InboxBody;
    expect(body.tasks.map((task) => task.id)).toEqual([taskId]);
  });

  test("a live lease is left alone", async () => {
    const office = await createOffice();
    const taskId = office.addTask("still working");
    const runId = await office.startRun(1);
    await office.claim(taskId, runId);

    expect(expireLeases(office.db)).toBe(0);
  });
});

describe("inbox capacity", () => {
  test("refuses a sixth pending task", async () => {
    const office = await createOffice();
    for (let i = 0; i < 5; i++) office.addTask(`task ${i}`);

    expect(() => office.addTask("one too many")).toThrow(/5 pending tasks/);
  });
});

describe("snapshot", () => {
  test("carries tasks per agent", async () => {
    const office = await createOffice();
    office.addTask("visible task");
    await office.startRun(1);

    const res = await office.snapshot();
    const body = (await res.json()) as {
      agents: { tasks: { title: string; status: string }[] }[];
      counters: { tasks_pending: number };
    };

    expect(body.agents[0]?.tasks[0]?.title).toBe("visible task");
    expect(body.agents[0]?.tasks[0]?.status).toBe("pending");
    expect(body.counters.tasks_pending).toBe(1);
  });
});
