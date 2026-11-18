import fs from "node:fs";
import type { Db } from "./db";

/**
 * Apply docs/SCHEMA.sql. The schema is idempotent (CREATE ... IF NOT EXISTS), so this runs
 * on every boot and doubles as a no-op migration for v0.
 */
export function applySchema(db: Db, schemaFile: string): void {
  const sql = fs.readFileSync(schemaFile, "utf8");
  db.exec(sql);

  const row = db.prepare("SELECT count(*) AS n FROM schema_version").get<{ n: number }>();
  if (!row || Number(row.n) === 0) {
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      1,
      new Date().toISOString(),
    );
  }
}

export function defaultSchemaVersion(db: Db): number {
  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get<{ version: number }>();
  return row ? Number(row.version) : 0;
}
