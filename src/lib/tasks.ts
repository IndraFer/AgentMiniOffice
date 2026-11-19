import type { Db } from "./db";
import { uuidv7 } from "./uuid";

/**
 * Task inbox. The panel never pushes work: an idle agent asks for it and holds a lease.
 *
 * The lease is the whole safety story. Without it, an agent that dies mid task owns that task
 * forever. With it, the task comes back after the lease expires and another run can claim it.
 */

export const MAX_PENDING_PER_AGENT = 5;
export const DEFAULT_LEASE_SECONDS = 60;
// Pickup deadline is independent of the execution lease. A lease does not refresh task age.
export const PICKUP_TTL_MS = 15 * 60_000;
export function expirePending(db: Db, now = Date.now()) {
  return db.prepare(`DELETE FROM tasks WHERE status='pending' AND agent_id IN (SELECT agent_id FROM visit_labels) AND created_at<=? RETURNING id,org_id,agent_id`).all<{id:string;org_id:string;agent_id:string}>(new Date(now-PICKUP_TTL_MS).toISOString());
}
export const MAX_RESULT_BYTES = 8 * 1024;

export interface TaskRow {
  id: string;
  org_id: string;
  agent_id: string;
  title: string;
  brief: string | null;
  priority: number;
  status: string;
  claimed_by_run: string | null;
  lease_expires_at: string | null;
  claim_count: number;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskFailure {
  code: "not_found" | "conflict" | "lease_held" | "inbox_full" | "validation_failed";
  status: 404 | 409 | 422;
  message: string;
}

export type TaskResult =
  | { task: TaskRow; failure?: never }
  | { task?: never; failure: TaskFailure };

const nowIso = (): string => new Date().toISOString();

function recordEvent(
  db: Db,
  orgId: string,
  agentId: string,
  runId: string | null,
  type: "task.claimed" | "task.acked" | "task.expired",
  data: Record<string, unknown>,
  at: string,
): void {
  db.prepare(
    `INSERT INTO events (id, org_id, agent_id, run_id, origin, type, seq, received_at, data)
     VALUES (?,?,?,?,'server',?,NULL,?,?)`,
  ).run(uuidv7(), orgId, agentId, runId, type, at, JSON.stringify(data));
}

export function pendingCount(db: Db, agentId: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM tasks WHERE agent_id = ? AND status = 'pending'")
    .get<{ n: number }>(agentId);
  return Number(row?.n ?? 0);
}

export function listInbox(db: Db, agentId: string, limit = 20): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM tasks
        WHERE agent_id = ? AND status = 'pending' AND (created_at>? OR agent_id NOT IN (SELECT agent_id FROM visit_labels))
        ORDER BY priority DESC, created_at ASC
        LIMIT ?`,
    )
    .all<TaskRow>(agentId,new Date(Date.now()-PICKUP_TTL_MS).toISOString(), limit);
}

interface OfficeTaskRow extends TaskRow {
  agent_name: string;
  agent_simulator: number;
}

/** Rolling display window, not a deletion policy. Active work never ages out of this filter. */
export function listOfficeTasks(db: Db, orgId: string, limit = 200): OfficeTaskRow[] {
  return db
    .prepare(
      `SELECT t.*, coalesce(v.name,a.name) AS agent_name, a.simulator AS agent_simulator
         FROM tasks t JOIN agents a ON a.id = t.agent_id LEFT JOIN visit_labels v ON v.agent_id=a.id
        WHERE t.org_id = ? AND (t.status IN ('pending','claimed') OR
              (t.status IN ('acked','failed') AND t.updated_at >= ?))
        ORDER BY CASE t.status
                   WHEN 'claimed' THEN 0
                   WHEN 'pending' THEN 1
                   ELSE 2
                 END,
                 CASE WHEN t.status IN ('acked','failed') THEN t.updated_at END DESC,
                 t.priority DESC, t.created_at ASC, t.id
        LIMIT ?`,
    )
    .all<OfficeTaskRow>(orgId, new Date(Date.now() - 72 * 3600_000).toISOString(), limit);
}

export function cancelTask(db: Db, orgId: string, taskId: string, now = Date.now()): TaskResult {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND org_id = ?")
    .get<TaskRow>(taskId, orgId);

  if (!task) return { failure: { code: "not_found", status: 404, message: "no such task" } };
  if (task.status === "acked" || task.status === "failed") {
    return { failure: { code: "conflict", status: 409, message: "task is already finished" } };
  }

  db.prepare(
    "UPDATE tasks SET status = 'cancelled', lease_expires_at = NULL, updated_at = ? WHERE id = ?",
  ).run(new Date(now).toISOString(), taskId);

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get<TaskRow>(taskId);
  if (!updated) return { failure: { code: "not_found", status: 404, message: "task vanished" } };
  return { task: updated };
}

/** Reassigning only makes sense before an agent holds the lease. */
export function assignTask(
  db: Db,
  orgId: string,
  taskId: string,
  agentId: string,
  now = Date.now(),
): TaskResult {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND org_id = ?")
    .get<TaskRow>(taskId, orgId);

  if (!task) return { failure: { code: "not_found", status: 404, message: "no such task" } };
  if (task.status !== "pending") {
    return {
      failure: { code: "conflict", status: 409, message: "only a pending task can be reassigned" },
    };
  }

  const agent = db
    .prepare("SELECT id FROM agents WHERE id = ? AND org_id = ? AND archived_at IS NULL")
    .get(agentId, orgId);
  if (!agent) {
    return { failure: { code: "validation_failed", status: 422, message: "unknown agent" } };
  }

  db.prepare("UPDATE tasks SET agent_id = ?, updated_at = ? WHERE id = ?").run(
    agentId,
    new Date(now).toISOString(),
    taskId,
  );

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get<TaskRow>(taskId);
  if (!updated) return { failure: { code: "not_found", status: 404, message: "task vanished" } };
  return { task: updated };
}

export function createTask(
  db: Db,
  orgId: string,
  agentId: string,
  title: string,
  brief: string | null,
  priority: number,
): TaskResult {
  if (pendingCount(db, agentId) >= MAX_PENDING_PER_AGENT) {
    return {
      failure: {
        code: "inbox_full",
        status: 409,
        message: `agent already has ${MAX_PENDING_PER_AGENT} pending tasks`,
      },
    };
  }

  const id = uuidv7();
  const at = nowIso();
  db.prepare(
    `INSERT INTO tasks (id, org_id, agent_id, title, brief, priority, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
  ).run(id, orgId, agentId, title, brief, priority, at, at);

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get<TaskRow>(id);
  if (!task) {
    return { failure: { code: "not_found", status: 404, message: "task vanished after insert" } };
  }
  return { task };
}

function activeRunOfAgent(db: Db, runId: string, agentId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM runs WHERE id = ? AND agent_id = ? AND state = 'active'")
    .get(runId, agentId);
  return Boolean(row);
}

export function claimTask(
  db: Db,
  agentId: string,
  taskId: string,
  runId: string,
  leaseSeconds: number,
  now = Date.now(),
): TaskResult {
  if (!activeRunOfAgent(db, runId, agentId)) {
    return {
      failure: {
        code: "conflict",
        status: 409,
        message: "run_id must be an active run of this agent. Send run.started first.",
      },
    };
  }

  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND agent_id = ?")
    .get<TaskRow>(taskId, agentId);

  if (!task) return { failure: { code: "not_found", status: 404, message: "no such task" } };

  if(task.status==='pending' && Date.parse(task.created_at)+PICKUP_TTL_MS<=now && db.prepare('SELECT 1 FROM visit_labels WHERE agent_id=?').get(agentId)) return {failure:{code:'not_found',status:404,message:'task pickup deadline has passed'}};
  if (task.status === "acked" || task.status === "failed" || task.status === "cancelled") {
    return {
      failure: { code: "conflict", status: 409, message: `task is already ${task.status}` },
    };
  }

  const leaseAlive =
    task.status === "claimed" &&
    task.lease_expires_at !== null &&
    Date.parse(task.lease_expires_at) > now;

  if (leaseAlive && task.claimed_by_run !== runId) {
    return {
      failure: {
        code: "lease_held",
        status: 409,
        message: `task is leased by another run until ${task.lease_expires_at}`,
      },
    };
  }

  const expiresAt = new Date(now + leaseSeconds * 1000).toISOString();
  const at = new Date(now).toISOString();

  db.prepare(
    `UPDATE tasks SET status = 'claimed', claimed_by_run = ?, lease_expires_at = ?,
            claim_count = claim_count + 1, updated_at = ?
      WHERE id = ?`,
  ).run(runId, expiresAt, at, taskId);

  // Only the first claim is a state transition worth a timeline event.
  if (task.status === "pending") {
    recordEvent(db, task.org_id, agentId, runId, "task.claimed", { task_id: taskId }, at);
  }

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get<TaskRow>(taskId);
  if (!updated) return { failure: { code: "not_found", status: 404, message: "task vanished" } };
  return { task: updated };
}

export function finishTask(
  db: Db,
  agentId: string,
  taskId: string,
  runId: string,
  outcome: "acked" | "failed",
  result: string,
  now = Date.now(),
): TaskResult {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND agent_id = ?")
    .get<TaskRow>(taskId, agentId);

  if (!task) return { failure: { code: "not_found", status: 404, message: "no such task" } };

  // A receipt may be lost after commit. Only its owner can repeat the same outcome.
  if (task.status === outcome && task.claimed_by_run === runId && task.result === result) return { task };
  if (task.status !== "claimed" || task.claimed_by_run !== runId || Date.parse(task.lease_expires_at ?? '') <= now) {
    return {
      failure: {
        code: "conflict",
        status: 409,
        message: "only the run holding the lease can finish this task",
      },
    };
  }

  const at = new Date(now).toISOString();
  db.prepare(
    `UPDATE tasks SET status = ?, result = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(outcome, result, at, taskId);

  if (outcome === "acked") {
    recordEvent(db, task.org_id, agentId, runId, "task.acked", { task_id: taskId }, at);
  }

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get<TaskRow>(taskId);
  if (!updated) return { failure: { code: "not_found", status: 404, message: "task vanished" } };
  return { task: updated };
}

export interface ExpiredLease {
  id: string;
  orgId: string;
  agentId: string;
}

/** Return expired leases to pending and record it. Called on a timer. */
export function expireLeases(
  db: Db,
  now = Date.now(),
  onExpired?: (lease: ExpiredLease) => void,
): number {
  const at = new Date(now).toISOString();
  const rows = db
    .prepare(
      `SELECT id, org_id, agent_id, claimed_by_run FROM tasks
        WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    )
    .all<{ id: string; org_id: string; agent_id: string; claimed_by_run: string | null }>(at);

  if (rows.length === 0) return 0;

  const update = db.prepare(
    `UPDATE tasks SET status = 'pending', claimed_by_run = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed'`,
  );

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      update.run(at, row.id);
      recordEvent(
        db,
        row.org_id,
        row.agent_id,
        row.claimed_by_run,
        "task.expired",
        { task_id: row.id },
        at,
      );
      onExpired?.({ id: row.id, orgId: row.org_id, agentId: row.agent_id });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return rows.length;
}
