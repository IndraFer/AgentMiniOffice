import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { config } from "./lib/config";
import { openDb } from "./lib/db";
import { Live } from "./lib/live";
import { isBun, runtimeName } from "./lib/runtime";
import { applySchema } from "./lib/schema";
import { DemoDriver } from "./lib/simulator";
import { PresenceStore } from "./lib/state";
import { expirePending, expireLeases } from "./lib/tasks";
import { readVersion } from "./lib/version";

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

const db = await openDb(config.dbFile);
applySchema(db, config.schemaFile);

const store = new PresenceStore({
  onlineMs: config.onlineMs,
  staleMs: config.staleMs,
  roomHysteresisMs: config.roomHysteresisMs,
});
const live = new Live(db, store);
const driver = new DemoDriver(db, live);
const leftovers = driver.cleanupLeftovers();
if (leftovers) console.log(`[demo] Removed ${leftovers} leftover panel demo agents at startup.`);
store.load(db);
live.start();
const app = createApp({
  db,
  store,
  leaseSeconds: config.leaseSeconds,
  retentionMinutes: config.retentionMinutes,
  dedicatedRetentionMinutes: config.dedicatedRetentionMinutes,
  live,
  sessionTtlMs: config.sessionTtlMs,
  secureCookies: config.secureCookies,
  allowRegistration: config.allowRegistration,
  embedFrameAncestors: config.embedFrameAncestors,
  demo: driver,
  requestLog: process.env.MINIOFFICE_REQUEST_LOG === "0" ? undefined : (line) => console.log(line),
});

driver.attach(app);

// Two timers on purpose. Sweeping is in memory and must run finer than the room
// hysteresis window, otherwise a pending room can never become visible. Flushing is the only
// part that touches the disk, so it stays at a lazier cadence.
const SWEEP_MS = 500;
const sweepTimer = setInterval(() => store.sweep(), SWEEP_MS);
sweepTimer.unref();

const flushTimer = setInterval(() => store.flush(db), config.flushMs);
flushTimer.unref();

// Expired leases go back to pending, otherwise a dead agent owns a task forever.
const leaseTimer = setInterval(() => {
  try {
    for(const row of expirePending(db)) live.task(row.org_id,row.agent_id,row.id,'expired');
    const returned = expireLeases(db, Date.now(), (lease) =>
      live.task(lease.orgId, lease.agentId, lease.id, "pending"),
    );
    if (returned > 0) console.log(`returned ${returned} expired task lease(s) to pending`);
  } catch (error) {
    console.error("lease sweep failed", error);
  }
}, config.leaseSweepMs);
leaseTimer.unref();

type ClosableServer = { close: (callback?: () => void) => void };
let server: ClosableServer;

if (isBun) {
  server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
  }) as unknown as ClosableServer;
} else {
  const { serve } = await import("@hono/node-server");
  server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  }) as unknown as ClosableServer;
}

console.log(
  `agentminioffice ${readVersion()} on http://${config.host}:${config.port} ` +
    `(${runtimeName}, ${db.driver})`,
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  clearInterval(sweepTimer);
  clearInterval(flushTimer);
  clearInterval(leaseTimer);
  driver.stopAll();
  live.stop();
  try {
    store.flush(db);
  } catch (error) {
    console.error("final flush failed", error);
  }
  try {
    server.close();
  } catch {
    // already closed
  }
  try {
    db.close();
  } catch {
    // already closed
  }
  console.log(`stopped on ${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
