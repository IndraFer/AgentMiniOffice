import fs from "node:fs";
import path from "node:path";

/**
 * Load a .env file explicitly.
 *
 * Bun loads .env on its own, Node does not. Relying on that difference means dev and
 * production behave differently per runtime, so we always load it ourselves and never
 * depend on auto-loading.
 */
export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env"));

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function minutes(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const dataDir = path.resolve(process.env.MINIOFFICE_DATA_DIR ?? "data");

export const config = {
  host: process.env.MINIOFFICE_HOST ?? "127.0.0.1",
  port: positiveInt(process.env.MINIOFFICE_PORT, 3000),
  dataDir,
  dbFile: path.resolve(process.env.MINIOFFICE_DB_FILE ?? path.join(dataDir, "minioffice.db")),
  schemaFile: path.resolve(process.env.MINIOFFICE_SCHEMA ?? "docs/SCHEMA.sql"),
  onlineMs: positiveInt(process.env.MINIOFFICE_ONLINE_MS, 30_000),
  staleMs: positiveInt(process.env.MINIOFFICE_STALE_MS, 90_000),
  retentionMinutes: minutes(process.env.MINIOFFICE_RETENTION_MINUTES, 30),
  dedicatedRetentionMinutes: minutes(process.env.MINIOFFICE_DEDICATED_RETENTION_MINUTES, 1440),
  flushMs: positiveInt(process.env.MINIOFFICE_FLUSH_MS, 5_000),
  roomHysteresisMs: positiveInt(process.env.MINIOFFICE_ROOM_HYSTERESIS_MS, 2_000),
  leaseSeconds: positiveInt(process.env.MINIOFFICE_LEASE_SECONDS, 60),
  leaseSweepMs: positiveInt(process.env.MINIOFFICE_LEASE_SWEEP_MS, 5_000),
  sessionTtlMs: positiveInt(process.env.MINIOFFICE_SESSION_TTL_DAYS, 30) * 86_400_000,
  secureCookies: process.env.MINIOFFICE_SECURE_COOKIES === "1",
  allowRegistration: process.env.MINIOFFICE_ALLOW_REGISTRATION === "1",
  publicSlugs: (process.env.MINIOFFICE_PUBLIC_SLUGS ?? "open")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean),
} as const;
