# Security

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the copyright holder named in
`LICENSE`. Do not open a public issue for anything that could let another tenant read agent data or
forge telemetry. Expect a first response within a week.

## Threat model

AgentMiniOffice listens on the public internet behind a domain, so assume it will be found and probed.

| Asset | Risk | Mitigation |
|---|---|---|
| Agent metadata and task titles | Readable by anyone who leaks a share link | Share links are read-only, scoped, expiring, revocable |
| Ability to publish fake telemetry | Office shows fiction | Agent tokens are per agent, hashed at rest, revocable, scope-limited to ingest and inbox |
| Prompt and file content | Would be a trove on a public host | Not collected. Server rejects content-looking payloads |
| Control of agents | Attacker pushes tasks | Downlink is pull only, with lease and ack, no shell execution ever |
| Admin UI | Full visibility of all agents | Separate user sessions with httpOnly cookies, roles, and no reuse of agent tokens |

## Non-goals

- AgentMiniOffice does not execute commands on agents. It stores tasks. The agent decides what to do.
- AgentMiniOffice does not store model output. If you need that, use a dedicated tracing backend.
- AgentMiniOffice is not hardened for multi-tenant hostile isolation in v1. One organization per deployment is
  the supported configuration until v3.

## Credentials

Keep office enrollment separate from private machine and human credentials:

- `amo_join_*` is a reusable office enrollment key. Only that office's Owner can reveal or rotate it, even while Closed. It cannot report for a worker. Closing blocks new enrollment; revoke an installation to stop its existing access.
- The collector derives each issued office key from a per-office nonce and a random **server-only** secret stored next to SQLite as `<db-file>.join-secret` (0600 on POSIX). Keep the database directory private. Back up the sidecar separately with restricted access, and restore it with the corresponding database. A DB-only copy cannot reveal office keys. Losing the sidecar prevents reveal, but does not invalidate existing verifiers: restore the file or explicitly rotate the affected keys. Do not ship either file in an export.
- `amo_producer_*` and `amo_writer_*` credentials remain private, hash-only on the collector. There is no reveal endpoint for them.

- `amo_agent_*` ingest tokens. Stored as SHA-256 hashes plus an eight character prefix for display.
  Shown exactly once at creation. Limit: ingest and inbox for one agent id.
- Session cookies. HttpOnly, SameSite=Lax, server-side session rows, revocable.
- Share links. Signed, read-only, expiring, revocable.

The token that an agent holds must never be able to open the panel, and a logged in user must never be
able to forge events for an agent. Both directions are enforced by separate middleware.

## Transport and deployment

- TLS is terminated by a reverse proxy (Caddy is the recommended default).
- Bind the Node process to localhost only. Never expose the port directly.
- Agent tokens are 32 random bytes, stored as SHA-256 hashes. A database leak does not hand out working
  tokens, but it does leak agent names, task titles, and timings. Treat the database as sensitive.
- Enable rate limiting per token before the collector is reachable from the internet. A runaway agent
  in a loop is the most likely denial of service against your own panel.

## Data retention

Events are pruned after 14 days. Daily aggregates survive. Back up via `sqlite3 .backup` or Litestream,
never by copying the `.db` file while WAL is active.
