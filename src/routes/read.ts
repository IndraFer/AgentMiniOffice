import { Hono } from "hono";
import type { Db } from "../lib/db";
import { fail } from "../lib/http";
import { resolveReadAccess } from "../lib/officeAccess";
import { authorizeShare } from "../lib/shareAuth";
import { buildSnapshot } from "../lib/snapshot";
import type { PresenceStore } from "../lib/state";
import { ROOMS } from "../lib/vocab";

export interface ReadContext {
  db: Db;
  store: PresenceStore;
  publicSlugs?: string[];
}

export function readRoutes({ db, store, publicSlugs = [] }: ReadContext): Hono {
  const app = new Hono();

  // Static vocabulary. Useful for shims, contains nothing sensitive.
  app.get("/rooms", (c) => c.json({ rooms: ROOMS }));

  // Legacy: share token only, no slug.
  app.get("/snapshot", (c) => {
    const orgId = authorizeShare(db, c.req.header("authorization"), c.req.query("share"));
    if (!orgId) return fail(c, 401, "unauthorized", "a valid share token is required");
    return c.json(buildSnapshot(db, store, orgId));
  });

  // The office view URL. Public slug, member session, or share link.
  app.get("/offices/:slug/snapshot", (c) => {
    const access = resolveReadAccess(c, db, {
      slug: c.req.param("slug"),
      publicSlugs,
    });

    if (access.orgId === null) {
      return access.reason === "not_found"
        ? fail(c, 404, "not_found", "no office with that slug")
        : fail(c, 401, "unauthorized", "this office is private. sign in or use a share link.");
    }

    return c.json(buildSnapshot(db, store, access.orgId));
  });

  return app;
}
