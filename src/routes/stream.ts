import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "../lib/db";
import { fail } from "../lib/http";
import type { Live, LiveEvent } from "../lib/live";
import { resolveReadAccess } from "../lib/officeAccess";
import { authorizeShare } from "../lib/shareAuth";
import { buildSnapshot } from "../lib/snapshot";
import type { PresenceStore } from "../lib/state";

export interface StreamContext {
  db: Db;
  store: PresenceStore;
  live: Live;
  publicSlugs?: string[];
}

const PING_MS = 15_000;
const RESYNC_MS = 60_000;

export function streamRoutes({ db, store, live, publicSlugs = [] }: StreamContext): Hono {
  const app = new Hono();

  const openStream = (c: Context, orgId: string) =>
    streamSSE(c, async (stream) => {
      let closed = false;

      const send = async (event: string, data: unknown): Promise<void> => {
        if (closed) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          closed = true;
        }
      };

      // Subscribe before the first snapshot and buffer until it is written. A change landing
      // between "build snapshot" and "subscribe" would otherwise be invisible until resync.
      let flushing = false;
      const pending: LiveEvent[] = [];
      const unsubscribe = live.bus.subscribe((event) => {
        const scoped = event.data as { org_id?: string } | null;
        // An unscoped publisher is a bug, not permission to broadcast across offices.
        if (scoped?.org_id !== orgId) return;
        if (flushing) void send(event.event, event.data);
        else if (pending.length < 200) pending.push(event);
      });

      await send("snapshot", buildSnapshot(db, store, orgId));
      flushing = true;
      for (const event of pending.splice(0)) await send(event.event, event.data);

      const ping = setInterval(() => {
        if (!closed) void stream.write(": ping\n\n").catch(() => {});
      }, PING_MS);

      const resync = setInterval(() => {
        void send("snapshot", buildSnapshot(db, store, orgId));
      }, RESYNC_MS);

      const cleanup = () => {
        closed = true;
        clearInterval(ping);
        clearInterval(resync);
        unsubscribe();
      };

      stream.onAbort(cleanup);

      try {
        while (!closed) await stream.sleep(1000);
      } catch {
        closed = true;
      } finally {
        cleanup();
      }
    });

  app.get("/stream", (c) => {
    const orgId = authorizeShare(db, c.req.header("authorization"), c.req.query("share"));
    if (!orgId) return fail(c, 401, "unauthorized", "a valid share token is required");
    return openStream(c, orgId);
  });

  app.get("/offices/:slug/stream", (c) => {
    const access = resolveReadAccess(c, db, { slug: c.req.param("slug"), publicSlugs });
    if (access.orgId === null) {
      return access.reason === "not_found"
        ? fail(c, 404, "not_found", "no office with that slug")
        : fail(c, 401, "unauthorized", "this office is private. sign in or use a share link.");
    }
    return openStream(c, access.orgId);
  });

  return app;
}
