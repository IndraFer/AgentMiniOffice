import { Hono } from "hono";
import type { Db } from "../lib/db";
import { readVersion } from "../lib/version";

export interface HealthContext {
  db: Db;
  allowRegistration?: boolean;
  publicSlugs?: string[];
}

export function healthRoutes({
  db,
  allowRegistration = false,
  publicSlugs = [],
}: HealthContext): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    let database = "ok";
    try {
      db.prepare("SELECT 1 AS ok").get();
    } catch {
      database = "down";
    }

    // Deliberately no agent counts here. This endpoint needs no auth.
    return c.json({
      ok: database === "ok",
      version: readVersion(),
      uptime_s: Math.floor(process.uptime()),
      db: database,
      driver: db.driver,
    });
  });

  // What the dashboard needs to know before it renders a login or register form.
  app.get("/api/v1/config", (c) => {
    const members = db.prepare("SELECT count(*) AS n FROM members").get<{ n: number }>();

    return c.json({
      version: readVersion(),
      allow_registration: allowRegistration,
      public_slugs: publicSlugs,
      // True only while the instance has no account at all. The dashboard turns this into a
      // first run form, and POST /setup closes for good once the first admin exists.
      needs_setup: Number(members?.n ?? 0) === 0,
    });
  });

  return app;
}
