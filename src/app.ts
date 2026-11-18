import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import type { Db } from "./lib/db";
import { Live } from "./lib/live";
import type { DemoDriver } from "./lib/simulator";
import type { PresenceStore } from "./lib/state";
import { staticRoutes } from "./lib/static";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { inboxRoutes } from "./routes/inbox";
import { ingestRoutes } from "./routes/ingest";
import { machineRoutes } from "./routes/machine";
import { officesRoutes } from "./routes/offices";
import { readRoutes } from "./routes/read";
import { streamRoutes } from "./routes/stream";

export interface AppContext {
  db: Db;
  store: PresenceStore;
  /** Defaults to ./public. Tests point this at a fixture directory. */
  publicDir?: string;
  /** Defaults to 60 seconds. */
  leaseSeconds?: number;
  retentionMinutes?: number;
  dedicatedRetentionMinutes?: number;
  /** Optional shared live feed. One is created when omitted, which is what tests rely on. */
  live?: Live;
  sessionTtlMs?: number;
  secureCookies?: boolean;
  allowRegistration?: boolean;
  publicSlugs?: string[];
  demo?: DemoDriver;
  requestLog?: (line: string) => void;
}

/**
 * One Hono instance, no runtime specific code. Both Bun and Node serve this exact object,
 * which is why dual runtime support costs two lines instead of two code bases.
 */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const live = ctx.live ?? new Live(ctx.db, ctx.store);

  const log = ctx.requestLog;
  if (log)
    app.use("/api/*", async (c, next) => {
      const start = performance.now();
      await next();
      // Only registered route templates. Never log raw paths, query strings, headers or payloads.
      const route =
        matchedRoutes(c).find(
          (r) => r.method === c.req.method && r.path.startsWith("/api/") && !r.path.includes("*"),
        )?.path ?? "unmatched-api";
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(
        c.req.method,
      )
        ? c.req.method
        : "OTHER";
      log(
        `${new Date().toISOString()} [api] ${method} ${route} ${c.res.status} ${Math.round(performance.now() - start)}ms`,
      );
    });

  app.route("/", healthRoutes(ctx));
  app.route(
    "/api/v1",
    authRoutes({
      db: ctx.db,
      sessionTtlMs: ctx.sessionTtlMs ?? 30 * 86_400_000,
      secureCookies: ctx.secureCookies ?? false,
      allowRegistration: ctx.allowRegistration ?? false,
    }),
  );
  app.route("/api/v1", machineRoutes(ctx.db, live));
  app.route("/api/v1", officesRoutes({ db: ctx.db, demo: ctx.demo, store:ctx.store, live }));
  app.route("/api/v1", readRoutes({ db: ctx.db, store: ctx.store, publicSlugs: ctx.publicSlugs }));
  app.route("/api/v1", ingestRoutes({ ...ctx, live }));
  app.route("/api/v1", inboxRoutes({ db: ctx.db, leaseSeconds: ctx.leaseSeconds, live }));
  app.route(
    "/api/v1",
    streamRoutes({ db: ctx.db, store: ctx.store, live, publicSlugs: ctx.publicSlugs }),
  );

  // Registered last so it only catches what the API did not claim.
  app.route("/", staticRoutes(ctx.publicDir ?? "public"));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: `${c.req.method} ${new URL(c.req.url).pathname} does not exist`,
        },
      },
      404,
    ),
  );

  app.onError((error, c) => {
    console.error("unhandled request error", error);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  return app;
}
