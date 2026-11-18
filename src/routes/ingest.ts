import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticateAgent } from "../lib/agentContext";
import type { Db } from "../lib/db";
import { byteLength, fail, isPlainObject, text } from "../lib/http";
import type { Live } from "../lib/live";
import { pruneOffline, wakeDedicated } from '../lib/visits';
import { signalOf } from "../lib/snapshot";
import type { PresenceStore } from "../lib/state";
import { isUuidv7, uuidv7 } from "../lib/uuid";
import { actionRoom, eventAction, validVariant, waitOptions, standardAction, isClientEventType, isRoom, roomForEvent } from "../lib/vocab";

export interface IngestContext {
  db: Db;
  store: PresenceStore;
  live: Live;
  retentionMinutes?: number;
  dedicatedRetentionMinutes?: number;
}

/** Metadata only. A public panel must never become an archive of prompts and keys. */
const FORBIDDEN_DATA_KEYS =
  /^(prompt|system_?prompt|messages?|conversation|content|output|stdout|stderr|diff|file_?content|secret|password|token|api_?key|credential)$/i;

function contentKey(data: Record<string, unknown>): string | null {
  for (const key of Object.keys(data)) {
    if (FORBIDDEN_DATA_KEYS.test(key)) return key;
  }
  return null;
}

interface Rejection {
  index: number;
  code: string;
  message: string;
}

export function ingestRoutes({ db, store, live, retentionMinutes=30, dedicatedRetentionMinutes=1440 }: IngestContext): Hono {
  const app = new Hono();

  app.post(
    "/agents/:agentId/heartbeat",
    bodyLimit({
      maxSize: 2048,
      onError: (c) => fail(c, 413, "payload_too_large", "heartbeat payload exceeds 2 KB"),
    }),
    async (c) => {
      const agentId = c.req.param("agentId");
      const body: unknown = await c.req.json().catch(() => null);
      const check = authenticateAgent(c, db, agentId, "ingest", true);
      if ("response" in check) return check.response;
      if (!isPlainObject(body))
        return fail(c, 400, "validation_failed", "body must be a JSON object");

      const seq = Number(body.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) {
        return fail(c, 400, "validation_failed", "seq must be a positive integer");
      }

      const previous = check.agent.machineSeq ?? check.agent.dormantSeq ?? store.lastSeq(agentId);
      if (seq <= previous) {
        return fail(c, 409, "invalid_seq", `seq ${seq} must be greater than ${previous}`);
      }

      if (check.agent.machineSeq !== null)
        db.prepare("UPDATE machine_sessions SET last_seq=? WHERE agent_id=?").run(seq, agentId);
      if (check.agent.dormantSeq !== null) wakeDedicated(db,check.agent.orgId,agentId,seq);
      const entry = store.heartbeat(agentId, check.agent.orgId, {
        seq,
        state: text(body.state, 40) ?? undefined,
        task: text(body.task, 200) ?? undefined,
        activity: text(body.activity, 200) ?? undefined,
      });

      if (check.agent.dormantSeq !== null) live.bus.publish({event:'roster',data:{org_id:check.agent.orgId}});
      pruneOffline(db,live,check.agent.orgId,retentionMinutes,dedicatedRetentionMinutes);
      return c.json({
        ok: true,
        seq,
        presence: { state: entry.state, room: store.effectiveRoom(entry) },
      });
    },
  );

  app.post(
    "/agents/:agentId/events",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => fail(c, 413, "payload_too_large", "event batch exceeds 64 KB"),
    }),
    async (c) => {
      const agentId = c.req.param("agentId");
      const body: unknown = await c.req.json().catch(() => null);
      const check = authenticateAgent(c, db, agentId, "ingest");
      if ("response" in check) return check.response;
      if (!isPlainObject(body) || !Array.isArray(body.events)) {
        return fail(c, 400, "validation_failed", "body must be { events: [...] }");
      }
      if (body.events.length > 200) {
        return fail(c, 413, "payload_too_large", "at most 200 events per batch");
      }

      const now = Date.now();
      const receivedAt = new Date(now).toISOString();
      const accepted: string[] = [];
      const duplicates: string[] = [];
      const rejected: Rejection[] = [];
      const committed: (() => void)[] = [];
      let nextSeq = check.agent.machineSeq ?? store.lastSeq(agentId);

      db.exec("BEGIN");
      try {
        for (let index = 0; index < body.events.length; index++) {
          const raw: unknown = body.events[index];
          if (!isPlainObject(raw)) {
            rejected.push({ index, code: "validation_failed", message: "event must be an object" });
            continue;
          }

          const eventId = raw.event_id;
          if (!isUuidv7(eventId)) {
            rejected.push({
              index,
              code: "validation_failed",
              message: "event_id must be a lowercase uuidv7",
            });
            continue;
          }

          const type = raw.type;
          if (!isClientEventType(type)) {
            rejected.push({
              index,
              code: "unsupported_type",
              message: `type ${String(type)} is not accepted from clients`,
            });
            continue;
          }

          const data = isPlainObject(raw.data) ? raw.data : {};
          if (byteLength(data) > 4096) {
            rejected.push({ index, code: "payload_too_large", message: "data exceeds 4 KB" });
            continue;
          }

          const badKey = contentKey(data);
          if (badKey) {
            rejected.push({
              index,
              code: "content_rejected",
              message: `data.${badKey} looks like content. Metadata only.`,
            });
            continue;
          }

          if ('avatar_label' in data && (type !== 'run.started' || !isUuidv7(data.parent_run_id) || typeof data.avatar_label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(data.avatar_label))) {
            rejected.push({index,code:'invalid_avatar_label',message:'Use a short public avatar label on linked child starts only.'}); continue;
          }
          if ('options' in data && (type !== 'human.waiting' || !waitOptions(data.options))) {
            rejected.push({index,code:'invalid_options',message:'Use only standard display option IDs on human.waiting.'}); continue;
          }
          if ((type === 'human.resumed' && Object.keys(data).length) || (type === 'human.waiting' &&
            (Object.keys(data).some(k=>k!=='kind' && k!=='options') || ('kind' in data && !['confirm','select','input','editor','custom'].some(k=>k===data.kind))))) {
            rejected.push({index,code:'invalid_prompt_metadata',message:'Send a standard prompt kind and optional display IDs, never prompt text or a response.'}); continue;
          }
          const action = standardAction(data.action);
          if ('action' in data && (!action || !['note','tool.start','tool.call'].includes(type))) {
            rejected.push({index, code:'invalid_action', message:'Use a v1 action ID on note, tool.start or tool.call.'});
            continue;
          }
          if ('variant' in data && !validVariant(data.action,data.variant)) {
            rejected.push({index,code:'invalid_variant',message:'Choose a variant ID listed for the explicit action.'});
            continue;
          }
          const room = raw.room ?? null;
          if (room !== null && !isRoom(room)) {
            rejected.push({
              index,
              code: "unknown_room",
              message: `${String(room)} is not in the room vocabulary`,
            });
            continue;
          }

          const seq = Number(raw.seq);
          if (!Number.isSafeInteger(seq) || seq < 1) {
            rejected.push({
              index,
              code: "validation_failed",
              message: "seq must be a positive integer",
            });
            continue;
          }

          // Check identity before run mutation, even when a replay carries a newer sequence.
          const digest =
            check.agent.machineSeq === null
              ? null
              : createHash("sha256").update(JSON.stringify(raw)).digest("hex");
          const seen = db
            .prepare(
              `SELECT e.agent_id,r.digest FROM events e LEFT JOIN machine_event_receipts r ON r.event_id=e.id WHERE e.id=?`,
            )
            .get<{ agent_id: string; digest: string | null }>(eventId);
          if (seen) {
            if (seen.agent_id !== agentId || (digest !== null && digest !== seen.digest))
              rejected.push({ index, code: "conflict", message: "event identity is unavailable" });
            else duplicates.push(eventId);
            continue;
          }
          if (seq <= nextSeq) {
            rejected.push({
              index,
              code: "invalid_seq",
              message: `seq ${seq} must be greater than ${nextSeq}`,
            });
            continue;
          }

          let runId = typeof raw.run_id === "string" && isUuidv7(raw.run_id) ? raw.run_id : null;
          const parentRunId =
            typeof data.parent_run_id === "string" && isUuidv7(data.parent_run_id)
              ? data.parent_run_id
              : null;

          let sharedChild = false;
          if (runId) {
            const existing = db
              .prepare("SELECT org_id, agent_id, parent_run_id FROM runs WHERE id = ?")
              .get<{ org_id: string; agent_id: string; parent_run_id: string | null }>(runId);
            if (
              type === "run.started"
                ? existing
                : !existing ||
                  existing.org_id !== check.agent.orgId ||
                  existing.agent_id !== agentId
            ) {
              rejected.push({
                index,
                code: "invalid_run",
                message: "run_id is not available for this event",
              });
              continue;
            }
            if (existing?.parent_run_id)
              sharedChild = Boolean(
                db
                  .prepare("SELECT 1 AS ok FROM runs WHERE id = ? AND org_id = ? AND agent_id = ?")
                  .get(existing.parent_run_id, check.agent.orgId, agentId),
              );
          }

          if (type === "run.started") {
            const newRunId = runId ?? uuidv7(now);
            // Missing or foreign parents are not linked. Preserve the existing main-run fallback.
            const parentExists = parentRunId
              ? db
                  .prepare("SELECT agent_id FROM runs WHERE id = ? AND org_id = ?")
                  .get<{ agent_id: string }>(parentRunId, check.agent.orgId)
              : null;
            sharedChild = parentExists?.agent_id === agentId;
            if (
              ('avatar_label' in data && (!parentExists || !runId)) ||
              (check.agent.machineSeq !== null && parentRunId && parentExists?.agent_id !== agentId)
            ) {
              rejected.push({
                index,
                code: "invalid_run",
                message: "parent run is unavailable for this writer",
              });
              continue;
            }
            if (parentExists) {
              const activeChildren = db
                .prepare(
                  "SELECT count(*) AS n FROM runs WHERE agent_id = ? AND parent_run_id IS NOT NULL AND state = 'active'",
                )
                .get<{ n: number }>(agentId);
              if (Number(activeChildren?.n) >= 32) {
                rejected.push({
                  index,
                  code: "capacity",
                  message: "at most 32 active child runs per agent",
                });
                continue;
              }
            }
            // A child must not abandon its owner's active main run.
            if (!parentExists)
              db.prepare(
                `UPDATE runs SET state = 'abandoned', finished_at = ?
                WHERE agent_id = ? AND state = 'active' AND parent_run_id IS NULL`,
              ).run(receivedAt, agentId);

            db.prepare(
              `INSERT INTO runs
                 (id, org_id, agent_id, parent_run_id, state, title, kind, started_at)
               VALUES (?,?,?,?,?,?,?,?)`,
            ).run(
              newRunId,
              check.agent.orgId,
              agentId,
              parentExists ? parentRunId : null,
              "active",
              text(data.title, 200),
              parentExists ? "subagent" : "main",
              receivedAt,
            );
            runId = newRunId;
            committed.push(() =>
              live?.run(check.agent.orgId, agentId, newRunId, "active", text(data.title, 200)),
            );
          } else if (type === "run.finished" || type === "run.failed") {
            if (runId) {
              db.prepare(
                `UPDATE runs SET state = ?, finished_at = ?, error_code = ?
                  WHERE id = ? AND agent_id = ?`,
              ).run(
                type === "run.finished" ? "finished" : "failed",
                receivedAt,
                type === "run.failed" ? text(data.error_code, 80) : null,
                runId,
                agentId,
              );
              const finishedRun = runId;
              committed.push(() =>
                live?.run(
                  check.agent.orgId,
                  agentId,
                  finishedRun,
                  type === "run.finished" ? "finished" : "failed",
                  null,
                ),
              );
            }
          }

          const inserted = db
            .prepare(
              `INSERT OR IGNORE INTO events
               (id, org_id, agent_id, run_id, origin, type, room, seq, reported_at, received_at, data)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              eventId,
              check.agent.orgId,
              agentId,
              runId,
              "agent",
              type,
              room,
              seq,
              text(raw.reported_at, 40),
              receivedAt,
              JSON.stringify(data),
            );

          if (inserted.changes === 0) {
            duplicates.push(eventId);
            continue;
          }

          if (digest !== null)
            db.prepare("INSERT INTO machine_event_receipts(event_id,digest) VALUES(?,?)").run(
              eventId,
              digest,
            );
          accepted.push(eventId);
          nextSeq = seq;
          // A child sharing this registered agent must not move its parent's avatar.
          const intent = eventAction(type,data,room);
          const proposed = sharedChild ? null : intent ? actionRoom(intent) : room ?? roomForEvent(type, data);
          const signal = signalOf({
            room,
            id: eventId,
            seq,
            agent_id: agentId,
            run_id: runId,
            type,
            received_at: receivedAt,
            data: JSON.stringify(data),
          });
          committed.push(() => {
            store.setLastSeq(agentId, check.agent.orgId, seq);
            if (proposed) store.applyRoom(agentId, check.agent.orgId, proposed, now);
            if (signal) live?.signal(check.agent.orgId, agentId, signal);
          });
        }

        if (check.agent.machineSeq !== null && nextSeq !== check.agent.machineSeq)
          db.prepare("UPDATE machine_sessions SET last_seq=? WHERE agent_id=?").run(
            nextSeq,
            agentId,
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        console.error("event batch failed", error);
        return fail(c, 500, "internal", "event batch could not be stored");
      }

      // Never publish a run, room, signal or sequence that the database rolled back.
      for (const publish of committed) publish();
      return c.json({
        accepted: accepted.length,
        duplicate: duplicates.length,
        rejected,
        next_seq_hint: nextSeq + 1,
      });
    },
  );

  return app;
}
