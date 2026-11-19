import fs from "node:fs";
import type { Db } from "./db";

/**
 * Apply docs/SCHEMA.sql. The schema is idempotent (CREATE ... IF NOT EXISTS), so this runs
 * on every boot and doubles as a no-op migration for v0.
 */
export function applySchema(db: Db, schemaFile: string, legacyPublicSlugs = process.env.MINIOFFICE_PUBLIC_SLUGS ?? 'open'): void {
  const sql = fs.readFileSync(schemaFile, "utf8");
  db.exec(sql);

  db.exec('BEGIN IMMEDIATE');
  try {
    const version = defaultSchemaVersion(db);
    if (version === 1) {
      const grant = db.prepare('INSERT OR IGNORE INTO public_offices(org_id) SELECT id FROM organizations WHERE slug=? AND archived_at IS NULL');
      for (const slug of legacyPublicSlugs.split(',').map(s => s.trim()).filter(Boolean)) grant.run(slug);
    }
    if (version < 3) {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('agents') WHERE name='avatar_variation'").get()) {
        db.exec('ALTER TABLE agents ADD COLUMN avatar_variation INTEGER CHECK (avatar_variation BETWEEN 1 AND 2147483647)');
      }
      db.prepare('INSERT INTO schema_version(version,applied_at) VALUES(3,?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function defaultSchemaVersion(db: Db): number {
  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get<{ version: number }>();
  return row ? Number(row.version) : 0;
}
