import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { hashToken, SHARE_TOKEN_PREFIX } from "../lib/auth";
import type { Db } from "../lib/db";
import { fail, isPlainObject, text } from "../lib/http";
import type { Live } from '../lib/live';
import { deleteOffline } from '../lib/visits';
import { officeDisplayName, officeNameError } from "../lib/officeName";
import { canWrite, type MemberSession, sessionFromRequest } from "../lib/sessions";
import type { DemoDriver } from "../lib/simulator";
import {
  assignTask,
  cancelTask,
  createTask,
  listOfficeTasks,
  MAX_PENDING_PER_AGENT,
} from "../lib/tasks";
import { uuidv7 } from "../lib/uuid";

export interface OfficesContext {
  store: import('../lib/state').PresenceStore;
  db: Db;
  demo?: DemoDriver;
  live: Live;
}

interface OfficeRow {
  id: string;
  name: string;
  slug: string;
}

function officeBySlug(db: Db, slug: string): OfficeRow | null {
  return (
    db
      .prepare("SELECT id, name, slug FROM organizations WHERE slug = ? AND archived_at IS NULL")
      .get<OfficeRow>(slug) ?? null
  );
}

type Guard = { session: MemberSession; office: OfficeRow } | { response: Response };

export function requireOffice(c: Context, db: Db, slug: string, write: boolean): Guard {
  const session = sessionFromRequest(c, db);
  if (!session) return { response: fail(c, 401, "unauthorized", "sign in first") };

  const office = officeBySlug(db, slug);
  if (!office) return { response: fail(c, 404, "not_found", "no office with that slug") };

  if (session.orgId !== office.id) {
    return { response: fail(c, 403, "forbidden", "this office belongs to another account") };
  }
  if (write && !canWrite(session.role)) {
    return { response: fail(c, 403, "forbidden", "your role cannot change this office") };
  }
  return { session, office };
}

export function officesRoutes({ db, demo, store, live }: OfficesContext): Hono {
  const canReceive=(org:string,id:string)=>store.view(id)?.state==='online' && !!db.prepare(`SELECT 1 FROM agents a LEFT JOIN machine_sessions s ON s.agent_id=a.id LEFT JOIN machine_producers p ON p.id=s.producer_id WHERE a.id=? AND a.org_id=? AND a.archived_at IS NULL AND (a.simulator=1 OR (p.kind='trusted' AND p.inbox=1 AND p.revoked_at IS NULL AND s.expires_ms>?))`).get(id,org,Date.now());
  const app = new Hono();

  app.get("/offices", (c) => {
    const session = sessionFromRequest(c, db);
    if (!session) return fail(c, 401, "unauthorized", "sign in first");

    const office = db
      .prepare("SELECT id, name, slug, EXISTS(SELECT 1 FROM public_offices WHERE org_id=organizations.id) AS public_view FROM organizations WHERE id = ?")
      .get<OfficeRow & {public_view:number}>(session.orgId);
    if (!office) return c.json({ offices: [] });

    const agents = db
      .prepare(
        `SELECT a.id, coalesce(v.name,a.name) AS name, a.kind, a.host, a.project, a.simulator, a.created_at,
                (SELECT count(*) FROM agent_tokens t
                  WHERE t.agent_id = a.id AND t.revoked_at IS NULL) AS tokens,
                (SELECT count(*) FROM tasks k
                  WHERE k.agent_id = a.id AND k.status = 'pending') AS pending_tasks
           FROM agents a LEFT JOIN visit_labels v ON v.agent_id=a.id
          WHERE a.org_id = ? AND a.archived_at IS NULL
          ORDER BY a.name`,
      )
      .all<{
        id: string;
        name: string;
        kind: string;
        host: string | null;
        project: string | null;
        simulator: number;
        created_at: string;
        tokens: number;
        pending_tasks: number;
      }>(office.id);

    return c.json({
      offices: [
        {
          slug: office.slug,
          name: office.name,
          role: session.role,
          public_view: Boolean(office.public_view),
          inbox_limit: MAX_PENDING_PER_AGENT,
          demo_running: demo?.isRunning(office.id) ?? false,
          agents: agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            kind: agent.kind,
            host: agent.host,
            project: agent.project,
            simulator: Number(agent.simulator) === 1,
            created_at: agent.created_at,
            state: store.rosterState(agent.id,agent.created_at),
            tokens: Number(agent.tokens),
            pending_tasks: Number(agent.pending_tasks),
            can_receive_tasks: canReceive(office.id,agent.id),
          })),
        },
      ],
    });
  });

  app.put('/offices/:slug/agents/:id/appearance', async (c) => {
    const guard = requireOffice(c, db, c.req.param('slug'), true);
    if ('response' in guard) return guard.response;
    if (guard.session.role !== 'owner') return fail(c,403,'forbidden','only the Owner can change an avatar');
    const body: unknown = await c.req.json().catch(() => null);
    const variation = isPlainObject(body) ? body.variation : undefined;
    if (variation !== null && !(typeof variation === 'number' && Number.isInteger(variation) && variation >= 1 && variation <= 2147483647))
      return fail(c,400,'validation_failed','variation must be null or an integer between 1 and 2147483647');
    const org = guard.office.id;
    const updated = db.prepare('UPDATE agents SET avatar_variation=? WHERE id=? AND org_id=? AND archived_at IS NULL').run(variation,c.req.param('id'),org);
    if (!updated.changes) return fail(c,404,'not_found','session no longer exists');
    live.bus.publish({ event:'roster', data:{ org_id:org } });
    return c.json({ avatar_variation:variation });
  });

  app.delete('/offices/:slug/agents/:id', (c) => {
    const guard=requireOffice(c,db,c.req.param('slug'),true);
    if ('response' in guard) return guard.response;
    if (guard.session.role!=='owner') return fail(c,403,'forbidden','only the Owner can delete a session');
    const result=deleteOffline(db,live,guard.office.id,c.req.param('id'));
    if (result==='missing') return fail(c,404,'not_found','session no longer exists');
    if (result==='not_offline') return fail(c,409,'conflict','session is not offline');
    return c.body(null,204);
  });

  app.patch("/offices/:slug", async (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), true);
    if ("response" in guard) return guard.response;
    if (guard.session.role !== "owner")
      return fail(c, 403, "forbidden", "only the Owner can rename this office");
    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body) || Object.keys(body).length !== 1 || typeof body.name !== "string")
      return fail(c, 400, "validation_failed", "provide only the office name");
    const name = officeDisplayName(body.name);
    if (!name) return fail(c, 400, "validation_failed", officeNameError);
    db.prepare("UPDATE organizations SET name = ? WHERE id = ?").run(name, guard.office.id);
    return c.json({ name, slug: guard.office.slug });
  });

  app.put('/offices/:slug/public-view', async (c) => {
    const guard = requireOffice(c, db, c.req.param('slug'), true);
    if ('response' in guard) return guard.response;
    if (guard.session.role !== 'owner') return fail(c, 403, 'forbidden', 'only the Owner can change Public View');
    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body) || typeof body.enabled !== 'boolean') return fail(c, 400, 'validation_failed', 'enabled must be a boolean');
    const id = guard.office.id;
    if (body.enabled) db.prepare('INSERT OR IGNORE INTO public_offices(org_id) VALUES(?)').run(id);
    else {
      db.prepare('DELETE FROM public_offices WHERE org_id=?').run(id);
      live.bus.publish({event:'public-view-off',data:{org_id:id}});
    }
    return c.json({public_view:body.enabled});
  });

  app.post("/offices/:slug/share", async (c) => {
    const slug = c.req.param("slug");
    const guard = requireOffice(c, db, slug, true);
    if ("response" in guard) return guard.response;

    const body: unknown = await c.req.json().catch(() => ({}));
    const days = isPlainObject(body) ? Number(body.days ?? 0) : 0;
    const expiresAt =
      Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 86_400_000).toISOString()
        : null;

    const token = `${SHARE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    db.prepare(
      `INSERT INTO share_links (id, org_id, label, token_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      uuidv7(),
      guard.office.id,
      text(isPlainObject(body) ? body.label : undefined, 80),
      hashToken(token),
      new Date().toISOString(),
      expiresAt,
    );

    return c.json({ token, expires_at: expiresAt }, 201);
  });

  app.get("/offices/:slug/tasks", (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), false);
    if ("response" in guard) return guard.response;

    c.header('Cache-Control', 'private, no-store');
    const rows = listOfficeTasks(db, guard.office.id);
    return c.json({
      tasks: rows.map((task) => ({
        id: task.id,
        agent_id: task.agent_id,
        agent_name: task.agent_name,
        agent_simulator: Number(task.agent_simulator) === 1,
        title: task.title,
        brief: task.brief,
        priority: Number(task.priority),
        status: task.status,
        claimed_by_run: task.claimed_by_run,
        lease_expires_at: task.lease_expires_at,
        claim_count: Number(task.claim_count),
        created_at: task.created_at,
        finished_at: ['acked','failed'].includes(task.status) ? task.updated_at : null,
        result: ['acked','failed'].includes(task.status) ? task.result : null,
      })),
    });
  });

  app.post("/offices/:slug/tasks", async (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), true);
    if ("response" in guard) return guard.response;

    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body)) return fail(c, 400, "validation_failed", "body must be JSON");

    const agentId = text(body.agent_id, 64);
    const title = text(body.title, 200);
    if (!agentId || !title) {
      return fail(c, 400, "validation_failed", "agent_id and title are required");
    }

    const agent = db
      .prepare("SELECT id FROM agents WHERE id = ? AND org_id = ? AND archived_at IS NULL")
      .get(agentId, guard.office.id);
    if (!agent || !canReceive(guard.office.id,agentId)) return fail(c, 422, 'validation_failed','choose an online inbox-enabled visitor');

    const priority = Number(body.priority ?? 0);
    const outcome = createTask(
      db,
      guard.office.id,
      agentId,
      title,
      text(body.brief, 2000),
      Number.isFinite(priority) ? Math.max(0, Math.min(5, Math.trunc(priority))) : 0,
    );

    if (outcome.failure) {
      return fail(c, outcome.failure.status, outcome.failure.code, outcome.failure.message);
    }
    return c.json({ task: outcome.task }, 201);
  });

  app.post("/offices/:slug/tasks/:taskId/cancel", (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), true);
    if ("response" in guard) return guard.response;

    const outcome = cancelTask(db, guard.office.id, c.req.param("taskId") ?? "");
    if (outcome.failure) {
      return fail(c, outcome.failure.status, outcome.failure.code, outcome.failure.message);
    }
    return c.json({ task: outcome.task });
  });

  app.post("/offices/:slug/tasks/:taskId/assign", async (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), true);
    if ("response" in guard) return guard.response;

    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body)) return fail(c, 400, "validation_failed", "body must be JSON");

    const agentId = text(body.agent_id, 64);
    if (!agentId) return fail(c, 400, "validation_failed", "agent_id is required");

    if(!canReceive(guard.office.id,agentId)) return fail(c,422,'validation_failed','choose an online inbox-enabled visitor');
    const outcome = assignTask(db, guard.office.id, c.req.param("taskId") ?? "", agentId);
    if (outcome.failure) {
      return fail(c, outcome.failure.status, outcome.failure.code, outcome.failure.message);
    }
    return c.json({ task: outcome.task });
  });

  /**
   * Start or stop the in process demo. Simulated agents are flagged in the database, so a demo
   * never contaminates a real fleet, and the panel labels them.
   */
  app.post("/offices/:slug/demo", async (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), true);
    if ("response" in guard) return guard.response;
    if (!demo) return fail(c, 503, "internal", "demo driver is not available");

    const body: unknown = await c.req.json().catch(() => ({}));
    const count = isPlainObject(body) ? (body.count ?? 6) : null;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 5 || count > 8)
      return fail(c, 422, "validation_failed", "demo count must be an integer from 5 to 8");
    try {
      const result = demo.start(guard.office.id, count);
      return c.json({
        running: true,
        agents: result.agents,
        already_running: result.alreadyRunning,
      });
    } catch (error) {
      return fail(
        c,
        409,
        "conflict",
        error instanceof Error ? error.message : "could not start demo",
      );
    }
  });

  app.delete("/offices/:slug/demo", (c) => {
    const guard = requireOffice(c, db, c.req.param("slug"), true);
    if ("response" in guard) return guard.response;
    if (!demo) return fail(c, 503, "internal", "demo driver is not available");

    const stopped = demo.stop(guard.office.id);
    return c.json({ running: false, stopped });
  });

  return app;
}
