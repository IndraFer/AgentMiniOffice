/**
 * Offline admin CLI for creating offices, registering agents and issuing share links.
 * The Control Room also supports interactive registration.
 *
 *   bun run admin init --name "My Office"
 *   bun run admin agent:add pi-dashboard --kind pi --host macbook --project kantor
 *   bun run admin share:add --label "office view" --days 30
 *   bun run admin list
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashToken, SHARE_TOKEN_PREFIX } from "../src/lib/auth";
import { config } from "../src/lib/config";
import { openDb } from "../src/lib/db";
import { officeDisplayName, officeNameError } from "../src/lib/officeName";
import { hashPassword } from "../src/lib/passwords";
import { applySchema } from "../src/lib/schema";
import { createTask } from "../src/lib/tasks";
import { uuidv7 } from "../src/lib/uuid";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "office"
  );
}

const command = process.argv[2] ?? "help";

fs.mkdirSync(config.dataDir, { recursive: true });
const db = await openDb(config.dbFile);
applySchema(db, config.schemaFile);
const now = () => new Date().toISOString();

interface OrgRow {
  id: string;
  name: string;
}

function validatedOfficeName(value: string) {
  const name = officeDisplayName(value);
  if (!name) {
    console.error(officeNameError);
    process.exit(1);
  }
  return name;
}

function requireOrg(): OrgRow {
  const org = db
    .prepare("SELECT id, name FROM organizations ORDER BY created_at LIMIT 1")
    .get<OrgRow>();
  if (!org) {
    console.error('No office yet. Run: bun run admin init --name "My Office"');
    process.exit(1);
  }
  return org;
}

switch (command) {
  case "office:add": {
    const name = validatedOfficeName(arg("name") ?? "");
    const email = (arg("email") ?? "").toLowerCase();
    const password = arg("password");

    if (!name || !email || !password) {
      console.error(
        'usage: admin office:add --name "My Office" --email you@example.com --password secret [--slug my-office] [--display-name "Your Name"]',
      );
      process.exit(1);
    }
    if (password.length < 10) {
      console.error("password must be at least 10 characters");
      process.exit(1);
    }
    if (db.prepare("SELECT id FROM members WHERE email = ?").get(email)) {
      console.error(`an account already exists for ${email}`);
      process.exit(1);
    }

    const slug = arg("slug") ?? slugify(name);
    if (db.prepare("SELECT id FROM organizations WHERE slug = ?").get(slug)) {
      console.error(`slug "${slug}" is taken`);
      process.exit(1);
    }

    const orgId = uuidv7();
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)").run(
        orgId,
        name,
        slug,
        now,
      );
      db.prepare(
        `INSERT INTO members (id, org_id, email, display_name, role, password_hash, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        uuidv7(),
        orgId,
        email,
        arg("display-name") ?? email.split("@")[0] ?? "owner",
        "owner",
        hashPassword(password),
        now,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      console.error(`could not create the office: ${String(error)}`);
      process.exit(1);
    }

    console.log(`office ready: ${name}`);
    console.log(`  dashboard  /dashboard`);
    console.log(`  office     /${slug}`);
    console.log(`  sign in as ${email}`);
    break;
  }

  case "init": {
    const existing = db.prepare("SELECT id FROM organizations LIMIT 1").get();
    if (existing) {
      console.error("An office already exists. v0 supports one office per database.");
      process.exit(1);
    }
    const name = validatedOfficeName(arg("name") ?? "My Office");
    const id = uuidv7();
    db.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)").run(
      id,
      name,
      slugify(name),
      now(),
    );
    console.log(`office created: ${name}`);
    console.log(`organization id: ${id}`);
    console.log("next: open Workspace Access in the control room");
    break;
  }

  case "share:add": {
    const org = requireOrg();
    const token = newToken(SHARE_TOKEN_PREFIX);
    const days = Number(arg("days", "0"));
    const expiresAt =
      Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 86_400_000).toISOString()
        : null;

    db.prepare(
      `INSERT INTO share_links (id, org_id, label, token_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(uuidv7(), org.id, arg("label") ?? null, hashToken(token), now(), expiresAt);

    console.log(
      "read only share link created. Anyone with this token can watch, nobody can write.",
    );
    console.log("");
    console.log(`  panel    http://${config.host}:${config.port}/?share=${token}`);
    console.log(`  snapshot http://${config.host}:${config.port}/api/v1/snapshot?share=${token}`);
    console.log("");
    console.log(`expires: ${expiresAt ?? "never"}`);
    break;
  }

  case "task:add": {
    const org = requireOrg();
    const agentName = process.argv[3];
    const title = arg("title");

    if (!agentName || !title) {
      console.error(
        'usage: admin task:add <agent-name> --title "do the thing" [--brief "..."] [--priority 0]',
      );
      process.exit(1);
    }

    const agent = db
      .prepare("SELECT id, name FROM agents WHERE org_id = ? AND name = ?")
      .get<{ id: string; name: string }>(org.id, agentName);
    if (!agent) {
      console.error(`no agent named "${agentName}". See: bun run admin list`);
      process.exit(1);
    }

    const outcome = createTask(
      db,
      org.id,
      agent.id,
      title.slice(0, 200),
      arg("brief") ?? null,
      Number(arg("priority", "0")) || 0,
    );

    if (outcome.failure) {
      console.error(`rejected: ${outcome.failure.message}`);
      process.exit(1);
    }

    console.log(`task created for ${agent.name}: ${outcome.task.id}`);
    console.log("the agent picks it up on its next idle poll of GET /api/v1/agents/:id/inbox");
    break;
  }

  case "task:list": {
    const org = requireOrg();
    const rows = db
      .prepare(
        `SELECT t.id, t.status, t.title, t.priority, t.lease_expires_at, a.name AS agent
           FROM tasks t JOIN agents a ON a.id = t.agent_id
          WHERE t.org_id = ?
          ORDER BY t.created_at DESC LIMIT 25`,
      )
      .all<{
        id: string;
        status: string;
        title: string;
        priority: number;
        lease_expires_at: string | null;
        agent: string;
      }>(org.id);

    if (rows.length === 0) console.log("no tasks yet");
    for (const row of rows) {
      const lease = row.lease_expires_at ? ` lease=${row.lease_expires_at}` : "";
      console.log(`  [${row.status}] ${row.agent}  ${row.title}${lease}`);
    }
    break;
  }

  case "list": {
    const org = requireOrg();
    const agents = db
      .prepare("SELECT id, name, kind, host FROM agents WHERE org_id = ? ORDER BY name")
      .all<{ id: string; name: string; kind: string; host: string | null }>(org.id);
    console.log(`office: ${org.name}`);
    if (agents.length === 0) console.log("no agents yet");
    for (const agent of agents) {
      console.log(`  ${agent.name}  kind=${agent.kind}  host=${agent.host ?? "-"}  ${agent.id}`);
    }
    const shares = db
      .prepare("SELECT count(*) AS n FROM share_links WHERE org_id = ? AND revoked_at IS NULL")
      .get<{ n: number }>(org.id);
    console.log(`share links: ${Number(shares?.n ?? 0)}`);
    break;
  }

  default:
    console.log("usage: admin <init|share:add|list> [options]");
    console.log('  init      --name "My Office"');
    console.log('  share:add --label "office view" --days 30');
    console.log("  list");
    break;
}

db.close();
process.exit(0);
