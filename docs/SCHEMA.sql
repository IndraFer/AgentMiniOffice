-- AgentMiniOffice: SQLite schema v1
-- Every primary key is TEXT UUIDv7 (36 characters, lowercase, hyphenated), generated in the
-- application layer. No AUTOINCREMENT anywhere. Hard deletes leave no numbered holes.
-- All timestamps are TEXT ISO8601 UTC, for example '2026-11-17T13:45:43.120Z'.
-- Lexicographic comparison is valid for that format.
--
-- Apply with: sqlite3 data/minioffice.db < docs/SCHEMA.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

-- ---------------------------------------------------------------------------
-- Meta
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Organizations and humans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  slug        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uq
  ON organizations(slug);

-- Absence means private, including offices created after an upgrade.
CREATE TABLE IF NOT EXISTS public_offices (
  org_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  password_hash TEXT,                       -- NULL when login is via invite link or SSO only
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- One email per organization. The same person in two offices has two memberships.
CREATE UNIQUE INDEX IF NOT EXISTS members_org_email_uq
  ON members(org_id, email);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,               -- sha256(cookie value); the raw cookie is never stored
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_uq
  ON sessions(token_hash);

CREATE INDEX IF NOT EXISTS sessions_member_idx
  ON sessions(member_id, expires_at);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  token_hash  TEXT NOT NULL,
  created_by  TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS invites_token_uq
  ON invites(token_hash);

-- Read-only visitor links. Not a member, no password, cannot write.
CREATE TABLE IF NOT EXISTS share_links (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label       TEXT,
  token_hash  TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '{}',   -- JSON, for example {"agents":["uuid"],"show_tasks":false}
  created_by  TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS share_links_token_uq
  ON share_links(token_hash);

-- ---------------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind          TEXT NOT NULL,              -- hermes | openclaw | codex | claude | pi | antigravity | other
  host          TEXT,                       -- vps | homelab | macbook
  project       TEXT,                       -- project slug, for example 'auth-service'
  fingerprint   TEXT,                       -- optional, host:harness:project, display only
  version       TEXT,
  capabilities  TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  simulator     INTEGER NOT NULL DEFAULT 0 CHECK (simulator IN (0, 1)),
  created_at    TEXT NOT NULL,
  archived_at   TEXT                        -- NULL means active. Hard delete is an explicit admin action.
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_org_name_uq
  ON agents(org_id, name);

CREATE INDEX IF NOT EXISTS agents_org_idx
  ON agents(org_id, archived_at);

-- Public visit labels need not be unique; distinct sessions can report the same folder.
CREATE TABLE IF NOT EXISTS visit_labels (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60)
);

-- An archived dedicated identity may return only if explicitly retired by roster cleanup.
CREATE TABLE IF NOT EXISTS dormant_dedicated (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL
);

-- Simulated agents must be separable from real data at query level, not only in the UI.
CREATE INDEX IF NOT EXISTS agents_simulator_idx
  ON agents(simulator);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  prefix       TEXT NOT NULL,               -- first 8 characters, shown in the UI, for example 'amo_agen'
  label        TEXT,
  scopes       TEXT NOT NULL DEFAULT '["ingest"]',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_tokens_hash_uq
  ON agent_tokens(token_hash);

CREATE INDEX IF NOT EXISTS agent_tokens_agent_idx
  ON agent_tokens(agent_id, revoked_at);

-- Machine admission is independent from human membership and public viewing.
-- No row means Closed. Only verifiers, never raw credentials, are stored here.
CREATE TABLE IF NOT EXISTS machine_admission (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('open','closed')),
  join_hash TEXT UNIQUE
);
-- Absent for legacy hash-only keys. Explicit issue/rotation creates a fresh nonce.
CREATE TABLE IF NOT EXISTS machine_join_nonces (
  org_id TEXT PRIMARY KEY REFERENCES machine_admission(org_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_producers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('general','trusted')),
  token_hash TEXT NOT NULL UNIQUE,
  inbox INTEGER NOT NULL DEFAULT 0 CHECK(inbox IN (0,1) AND (inbox=0 OR kind='trusted')),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS machine_producers_office ON machine_producers(org_id, revoked_at);
-- General credentials created for one volatile connector process, not Owner-issued grants.
CREATE TABLE IF NOT EXISTS visit_enrollments (
  producer_id TEXT PRIMARY KEY REFERENCES machine_producers(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_sessions (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  producer_id TEXT NOT NULL REFERENCES machine_producers(id) ON DELETE CASCADE,
  harness TEXT NOT NULL,
  external_id TEXT NOT NULL,
  writer_id TEXT NOT NULL UNIQUE REFERENCES agent_tokens(id),
  generation INTEGER NOT NULL DEFAULT 1,
  expires_ms INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(producer_id,harness,external_id)
);

-- Derived state. Written by the server, never by a client. Flushed periodically, not per request.
CREATE TABLE IF NOT EXISTS agent_presence (
  agent_id          TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state             TEXT NOT NULL CHECK (state IN ('lobby', 'online', 'stale', 'offline')),
  room              TEXT NOT NULL CHECK (room IN (
                      'lobby', 'barber', 'desk', 'whiteboard', 'library', 'workshop',
                      'print-room', 'phone-booth', 'meeting', 'pantry', 'intern-desk', 'away')),
  room_pending      TEXT,                   -- latest room the reducer proposed, not visible yet
  room_pending_since TEXT,                  -- when the visible room last changed, for hysteresis
  task_label        TEXT,                   -- free text, shown on the desk monitor
  activity          TEXT,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  last_seen_at      TEXT,
  online_since      TEXT,
  offline_since     TEXT,
  heartbeat_state   TEXT,                   -- state reported by the client, not authoritative
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_presence_org_state_idx
  ON agent_presence(org_id, state);

-- ---------------------------------------------------------------------------
-- Runs (units of work) and subagents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,   -- set when this is a subagent
  task_id       TEXT,                                          -- FK added after tasks; see notes
  state         TEXT NOT NULL CHECK (state IN ('active', 'finished', 'failed', 'abandoned')),
  title         TEXT CHECK (title IS NULL OR length(title) <= 200),
  kind          TEXT,                       -- 'main' | 'subagent' | free form from the client
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error_code    TEXT,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0
);

-- One active main run per agent. Enforced in the application too, but this is the last guard.
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_agent_uq
  ON runs(agent_id) WHERE state = 'active' AND parent_run_id IS NULL;

CREATE INDEX IF NOT EXISTS runs_agent_started_idx
  ON runs(agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS runs_parent_idx
  ON runs(parent_run_id, state);

CREATE INDEX IF NOT EXISTS runs_org_state_idx
  ON runs(org_id, state);

-- ---------------------------------------------------------------------------
-- Events (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,             -- event_id from the client, UUIDv7
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('agent', 'server', 'system')),
  type        TEXT NOT NULL CHECK (type IN (
                'agent.registered', 'agent.shutdown',
                'run.started', 'run.finished', 'run.failed',
                'plan.start', 'plan.end',
                'tool.start', 'tool.end', 'tool.call',
                'spawn.started', 'spawn.finished',
                'human.waiting', 'human.resumed',
                'error', 'note',
                'task.claimed', 'task.acked', 'task.expired')),
  room        TEXT,                         -- NULL lets the reducer decide
  seq         INTEGER,                      -- NULL for server originated events
  reported_at TEXT,                         -- client clock, display only
  received_at TEXT NOT NULL,                -- server clock, authoritative
  data        TEXT NOT NULL DEFAULT '{}'    -- JSON, max 4 KB, metadata only
);

-- Sequence is monotonic per agent, but only for events that came from the agent.
-- Only machine-session events need a durable exact-retry verifier.
CREATE TABLE IF NOT EXISTS machine_event_receipts (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  digest TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_agent_seq_uq
  ON events(agent_id, seq) WHERE seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_agent_received_idx
  ON events(agent_id, received_at DESC);

CREATE INDEX IF NOT EXISTS events_org_received_idx
  ON events(org_id, received_at DESC);

CREATE INDEX IF NOT EXISTS events_run_idx
  ON events(run_id, received_at);

-- For the sweeper: tool.start events that were never closed.
CREATE INDEX IF NOT EXISTS events_type_received_idx
  ON events(org_id, type, received_at DESC);

-- ---------------------------------------------------------------------------
-- Tasks (inbox, downlink by pulling)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  brief            TEXT,
  priority         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'acked', 'failed', 'cancelled')),
  claimed_by_run   TEXT REFERENCES runs(id) ON DELETE SET NULL,
  lease_expires_at TEXT,
  claim_count      INTEGER NOT NULL DEFAULT 0,
  result           TEXT,                    -- text, max 8 KB, written on ack or fail
  created_by       TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_agent_status_idx
  ON tasks(agent_id, status, priority DESC, created_at);

-- Lease sweeper: find claimed tasks past their deadline.
CREATE INDEX IF NOT EXISTS tasks_lease_idx
  ON tasks(status, lease_expires_at) WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS tasks_org_created_idx
  ON tasks(org_id, created_at DESC);

-- The limit of 5 pending tasks per agent is enforced in the application, since it needs a count.

-- ---------------------------------------------------------------------------
-- Daily aggregates (replace raw events after retention)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS daily_aggregates (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day        TEXT NOT NULL CHECK (length(day) = 10),   -- 'YYYY-MM-DD' in UTC
  runs       INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_aggregates_uq
  ON daily_aggregates(agent_id, day);

-- ---------------------------------------------------------------------------
-- Implementation notes
-- ---------------------------------------------------------------------------
-- 1. There is deliberately no circular FK between runs.task_id and tasks.claimed_by_run.
--    Pick one authority for "who is working this task": tasks.claimed_by_run is that authority.
--    runs.task_id stays an unconstrained string reference used for display and joins.
-- 2. Deleting an organization cascades everything. Deleting an agent cascades its presence, runs,
--    events, and tasks. Because ids are UUIDv7 there is no number that can be reused, so there is no
--    "dirty" leftover data.
-- 3. Retention runs in batches (for example 1000 rows per minute) so it does not hold the WAL lock.
-- 4. Backup: `sqlite3 data/minioffice.db ".backup /backup/minioffice-$(date +%F).db"`, or Litestream to object
--    storage. Copying the .db file directly while WAL is active can produce an inconsistent copy.
-- 5. Never write prompt content into the data or result columns.
-- 6. PRAGMA foreign_keys is PER CONNECTION, not stored in the database file. Verified: deleting an
--    agent over a connection without the pragma leaves orphan rows in runs, events, tasks, and
--    agent_presence, and CASCADE only looks broken. The server must run
--    `PRAGMA foreign_keys = ON` every time it opens a connection (with better-sqlite3:
--    db.pragma('foreign_keys = ON')), never relying on this migration file. Run
--    `PRAGMA foreign_key_check` in tests.
