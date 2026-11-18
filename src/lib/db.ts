/**
 * One tiny adapter over the two built-in SQLite drivers.
 *
 * Only the subset whose behaviour is identical in both is exposed: exec, prepare().run,
 * prepare().get, prepare().all, close. Verified identical in Node 24 (node:sqlite) and
 * Bun 1.4 (bun:sqlite) for PRAGMA, cascade delete, upsert, and transactions.
 *
 * Rules that keep this thin, do not break them:
 *   1. Positional `?` parameters only. Named parameter syntax differs between drivers.
 *   2. Never read lastInsertRowid. Primary keys are UUIDv7, so it is never needed, and
 *      its type differs between drivers.
 *   3. Transactions are written as exec("BEGIN") / exec("COMMIT"), because the
 *      .transaction() helper only exists in Bun.
 */
import { isBun } from "./runtime";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
}

export interface Statement {
  run(...params: SqlValue[]): RunResult;
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | null;
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
}

export interface Db {
  readonly driver: "bun:sqlite" | "node:sqlite";
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface RawStatement {
  run(...params: unknown[]): { changes?: number | bigint } | undefined;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

function wrap(raw: RawDatabase, driver: Db["driver"]): Db {
  return {
    driver,
    exec(sql) {
      raw.exec(sql);
    },
    close() {
      raw.close();
    },
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        run(...params) {
          const result = statement.run(...params);
          return { changes: Number(result?.changes ?? 0) };
        },
        get<T>(...params: SqlValue[]) {
          return (statement.get(...params) ?? null) as T | null;
        },
        all<T>(...params: SqlValue[]) {
          return (statement.all(...params) ?? []) as T[];
        },
      };
    },
  };
}

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  // Foreign keys are per connection, never stored in the file. Without this, deletes
  // silently leave orphans and CASCADE only looks broken.
  "PRAGMA foreign_keys = ON",
] as const;

export async function openDb(file: string): Promise<Db> {
  let db: Db;

  if (isBun) {
    const { Database } = await import("bun:sqlite");
    db = wrap(new Database(file, { create: true }) as unknown as RawDatabase, "bun:sqlite");
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = wrap(new DatabaseSync(file) as unknown as RawDatabase, "node:sqlite");
  }

  for (const pragma of PRAGMAS) db.exec(pragma);
  return db;
}
