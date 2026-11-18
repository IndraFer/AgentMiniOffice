import { describe, expect, test } from "bun:test";
import path from "node:path";
import { openDb } from "../src/lib/db";
import { isBun } from "../src/lib/runtime";
import { applySchema } from "../src/lib/schema";
import { uuidv7 } from "../src/lib/uuid";

async function freshDb() {
  const db = await openDb(":memory:");
  applySchema(db, path.resolve("docs/SCHEMA.sql"));
  return db;
}

const now = new Date().toISOString();

describe("db adapter", () => {
  test("picks the driver of the current runtime", async () => {
    const db = await freshDb();
    expect(db.driver).toBe(isBun ? "bun:sqlite" : "node:sqlite");
    db.close();
  });

  test("schema reports version 1", async () => {
    const db = await freshDb();
    const row = db.prepare("SELECT max(version) AS v FROM schema_version").get<{ v: number }>();
    expect(Number(row?.v)).toBe(1);
    db.close();
  });

  test("deleting an agent cascades to runs, events, tasks, and presence", async () => {
    const db = await freshDb();
    const orgId = uuidv7();
    const agentId = uuidv7();
    const runId = uuidv7();

    db.prepare("INSERT INTO organizations (id,name,slug,created_at) VALUES (?,?,?,?)").run(
      orgId,
      "Office",
      "office",
      now,
    );
    db.prepare("INSERT INTO agents (id,org_id,name,kind,created_at) VALUES (?,?,?,?,?)").run(
      agentId,
      orgId,
      "pi-a",
      "pi",
      now,
    );
    db.prepare("INSERT INTO runs (id,org_id,agent_id,state,started_at) VALUES (?,?,?,?,?)").run(
      runId,
      orgId,
      agentId,
      "active",
      now,
    );
    db.prepare(
      "INSERT INTO tasks (id,org_id,agent_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(uuidv7(), orgId, agentId, "a task", "pending", now, now);
    db.prepare(
      "INSERT INTO events (id,org_id,agent_id,run_id,origin,type,received_at) VALUES (?,?,?,?,?,?,?)",
    ).run(uuidv7(), orgId, agentId, runId, "agent", "run.started", now);
    db.prepare(
      "INSERT INTO agent_presence (agent_id,org_id,state,room,updated_at) VALUES (?,?,?,?,?)",
    ).run(agentId, orgId, "online", "desk", now);

    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);

    const counts = {
      runs: db.prepare("SELECT count(*) AS n FROM runs").get<{ n: number }>()?.n,
      events: db.prepare("SELECT count(*) AS n FROM events").get<{ n: number }>()?.n,
      tasks: db.prepare("SELECT count(*) AS n FROM tasks").get<{ n: number }>()?.n,
      presence: db.prepare("SELECT count(*) AS n FROM agent_presence").get<{ n: number }>()?.n,
    };
    expect(Number(counts.runs)).toBe(0);
    expect(Number(counts.events)).toBe(0);
    expect(Number(counts.tasks)).toBe(0);
    expect(Number(counts.presence)).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    db.close();
  });

  test("only one active main run per agent, subagents are allowed", async () => {
    const db = await freshDb();
    const orgId = uuidv7();
    const agentId = uuidv7();
    db.prepare("INSERT INTO organizations (id,name,slug,created_at) VALUES (?,?,?,?)").run(
      orgId,
      "Office",
      "office",
      now,
    );
    db.prepare("INSERT INTO agents (id,org_id,name,kind,created_at) VALUES (?,?,?,?,?)").run(
      agentId,
      orgId,
      "pi-a",
      "pi",
      now,
    );

    const mainRun = uuidv7();
    db.prepare("INSERT INTO runs (id,org_id,agent_id,state,started_at) VALUES (?,?,?,?,?)").run(
      mainRun,
      orgId,
      agentId,
      "active",
      now,
    );

    expect(() =>
      db
        .prepare("INSERT INTO runs (id,org_id,agent_id,state,started_at) VALUES (?,?,?,?,?)")
        .run(uuidv7(), orgId, agentId, "active", now),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          "INSERT INTO runs (id,org_id,agent_id,parent_run_id,state,started_at) VALUES (?,?,?,?,?,?)",
        )
        .run(uuidv7(), orgId, agentId, mainRun, "active", now),
    ).not.toThrow();

    db.close();
  });
});
