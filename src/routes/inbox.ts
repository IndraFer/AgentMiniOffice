import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticateAgent } from "../lib/agentContext";
import type { Db } from "../lib/db";
import { fail, isPlainObject, text } from "../lib/http";
import type { Live } from "../lib/live";
import {
  claimTask,
  DEFAULT_LEASE_SECONDS,
  finishTask,
  listInbox,
  MAX_RESULT_BYTES,
  type TaskRow,
} from "../lib/tasks";
import { isUuidv7 } from "../lib/uuid";

export interface InboxContext {
  db: Db;
  leaseSeconds?: number;
  live?: Live;
}

function publicTask(task: TaskRow) {
  return {
    id: task.id,
    title: task.title,
    brief: task.brief,
    priority: task.priority,
    status: task.status,
    claim_count: task.claim_count,
    lease_expires_at: task.lease_expires_at,
    created_at: task.created_at,
  };
}

function tooLarge(c: Context) {
  return fail(c, 413, "payload_too_large", "result exceeds 8 KB");
}

export function inboxRoutes({
  db,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  live,
}: InboxContext): Hono {
  const app = new Hono();

  app.get("/agents/:agentId/inbox", (c) => {
    const agentId = c.req.param("agentId");
    const check = authenticateAgent(c, db, agentId, "inbox");
    if ("response" in check) return check.response;

    const tasks = listInbox(db, agentId).map((task) => ({
      id: task.id,
      title: task.title,
      brief: task.brief,
      priority: task.priority,
      created_at: task.created_at,
      lease_seconds: leaseSeconds,
    }));

    return c.json({ tasks });
  });

  app.post(
    "/agents/:agentId/inbox/:taskId/claim",
    bodyLimit({
      maxSize: 1024,
      onError: (c) => fail(c, 413, "payload_too_large", "claim body exceeds 1 KB"),
    }),
    async (c) => {
      const agentId = c.req.param("agentId");
      const taskId = c.req.param("taskId");
      const body: unknown = await c.req.json().catch(() => null);
      const check = authenticateAgent(c, db, agentId, "inbox");
      if ("response" in check) return check.response;
      if (!isPlainObject(body) || !isUuidv7(body.run_id)) {
        return fail(c, 400, "validation_failed", "run_id must be a uuidv7");
      }

      const outcome = claimTask(db, agentId, taskId, body.run_id, leaseSeconds);
      if (outcome.failure) {
        return fail(c, outcome.failure.status, outcome.failure.code, outcome.failure.message);
      }

      live?.task(check.agent.orgId, agentId, taskId, outcome.task.status);

      return c.json({
        task: publicTask(outcome.task),
        lease_seconds: leaseSeconds,
        lease_expires_at: outcome.task.lease_expires_at,
      });
    },
  );

  const finish = (outcome: "acked" | "failed") => async (c: Context) => {
    const agentId = c.req.param("agentId") ?? "";
    const taskId = c.req.param("taskId") ?? "";
    if (!taskId) return fail(c, 400, "validation_failed", "taskId is required");
    const body: unknown = await c.req.json().catch(() => null);
    const check = authenticateAgent(c, db, agentId, "inbox");
    if ("response" in check) return check.response;
    if (!isPlainObject(body) || !isUuidv7(body.run_id)) {
      return fail(c, 400, "validation_failed", "run_id must be a uuidv7");
    }

    const raw = outcome === "acked" ? body.result : body.reason;
    // Check the raw value, not the truncated one, or the limit can never trigger.
    if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") > MAX_RESULT_BYTES) {
      return tooLarge(c);
    }
    const note = text(raw, MAX_RESULT_BYTES) ?? "";

    const result = finishTask(db, agentId, taskId, body.run_id, outcome, note);
    if (result.failure) {
      return fail(c, result.failure.status, result.failure.code, result.failure.message);
    }
    live?.task(check.agent.orgId, agentId, taskId, result.task.status);
    return c.json({ task: publicTask(result.task) });
  };

  app.post(
    "/agents/:agentId/inbox/:taskId/ack",
    bodyLimit({ maxSize: MAX_RESULT_BYTES + 1024, onError: tooLarge }),
    finish("acked"),
  );

  app.post(
    "/agents/:agentId/inbox/:taskId/fail",
    bodyLimit({ maxSize: MAX_RESULT_BYTES + 1024, onError: tooLarge }),
    finish("failed"),
  );

  return app;
}
