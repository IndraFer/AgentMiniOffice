# AgentMiniOffice API Contract v1

Status: draft for the v0 implementation. Every decision below is binding. If something needs to change,
change it here before writing server code.

## 1. Scope

The panel receives telemetry from any agent over plain REST. The panel does **not** know what hermes,
openclaw, codex, claude, or pi is. The mapping from a harness to office events lives on the client side
as a small shim. From the panel's point of view, everything is `curl`.

Out of scope for v1:

- Prompt and response content. Metadata only. See section 12.
- Downlink over WebSocket. Downlink is pull based (task inbox, section 10).
- Multi-organization UI. `org_id` exists in the schema from the start, but the v1 UI is single
  organization.
- Visitor chat. Nice to have, last in line.

## 2. Principles

1. **The server owns presence.** An agent may not report `offline`. Offline is inferred from missing
   heartbeats.
2. **Telemetry must never disturb the agent.** The client shim is fire and forget. If the panel is
   down, the agent keeps working.
3. **Events are append-only facts.** Never update an event. Corrections are new events.
4. **State is derived, not input.** Clients send heartbeats and events. The server computes rooms and
   presence.
5. **Closed vocabularies.** `room` and `type` are bounded sets defined here. Unknown values are
   rejected or normalized, never stored raw.

## 3. Identity

Every primary key is a **UUIDv7** stored as 36 character TEXT (hyphenated, lowercase). No auto
increment, no integer ids. Rationale: hard deletes leave no numbered holes, ids are not guessable, and
id order follows time so indexes stay local.

| Entity | Created by | Note |
|---|---|---|
| `organization` | panel | one per office |
| `member` | panel | a human with a login |
| `agent` | admitted producer or simulator | the server allocates the ID |
| `agent_token` | panel | shown once, stored as a hash |
| `run` | server, from `run.started` | one unit of work, may be ephemeral |
| `task` | panel or agent | outlives a run |
| `event` | **client** | idempotent, must be unique |
| `session` | server | browser login |

### Temporary visitors, not a registry

There is no manual agent creation endpoint or CLI command. Use machine admission below. Retention applies to the office roster regardless of visit label, harness or installation date.

`fingerprint` (`host:harness:project-slug`) is optional and display only, never used for automatic
lookup. Automatic lookup destroys attribution and lets two machines overwrite each other.

### Machine admission and sessions (implemented)

Use one server process per SQLite file. The collector stores credential hashes. Use HTTPS outside
local development. Never log credential-bearing request bodies, authorization or writer headers. The
machine API replies with `Cache-Control: no-store`. It does not grant human login, read or share access.

**Temporary visit mode.** Set `visit: true` on session open, and on enrollment for a disposable general producer. A visit label is not unique; only its ID identifies it. Retrying or renewing a live visit with the same producer, harness, external ID and writer keeps that ID. When the sender supplies a changed `name`, the collector refreshes only the visit label and sends one office-scoped `roster` notification. It never derives a missing folder from the project or an ID. Offline starts at the stale threshold (default 90 seconds after the last heartbeat, or creation if none). Retention starts then; see §14. Unused disposable enrollments age out. Removing or closing the last non-archived session revokes its General or Trusted connector. Other non-archived sessions keep the connector, even if temporarily offline. Issuing an unused Trusted connector does not revoke it. Unmarked sessions follow the same rule. A new visit never inherits tasks. A pending visit task expires 15 minutes from creation even if its visitor is still online.

**Owner operations.** Paths below are relative to `/api/v1/offices/{slug}/machine`; use the Owner's
same-office session cookie. The Workspace Access page calls these same routes.

| Request | Result |
|---|---|
| `GET /admission`, `PUT /admission` with `{"mode":"open"}` or `{"mode":"closed"}` | Defaults to Closed. Closed rejects join-key enrollment only. The key, registered producers and current writer leases are unchanged; reopen to accept the same key again. |
| `GET /join-key` | Reveal the existing office enrollment key (`token`) to its Owner, in either mode. Never creates/rotates a key. 404 if not issued; 409 for legacy hash-only keys or unavailable server key material. |
| `POST /join-key` | Explicit issue/rotation in either mode. Rejects the old key for new enrollments; does not disable enrolled producers. Older hash-only keys need one explicit rotation to enable reveal. See [backup requirements](../SECURITY.md#credentials). |
| `POST /trusted` with `{}` or `{"inbox":true}` | Issue `producer_id` and private `token`. Telemetry only unless the Owner explicitly grants assigned-task inbox access. Works in Closed or Open. |
| `GET /producers`, `DELETE /producers/{id}` | List active IDs, kinds and inbox grants without secrets; revoke one producer, delete its sessions and their tasks/activity immediately, and deny its writers. |

**Connector sequence.** Generate each connector secret from 32 fresh cryptographically random bytes,
base64url without padding. Retain it privately **before** sending; Pi keeps visit proofs in process memory. Do not reuse it across sessions,
installations or generations; a name, project or native session ID is not a secret.

1. For a general installation only, `POST /api/v1/machine/enroll` (or the office-scoped `/api/v1/offices/{slug}/machine/enroll`) with the join key as
   bearer and `{"producer_token":"amo_producer_<random>"}`. Returns `producer_id` (201, or 200 for
   the same credential and office). No configured office name is needed. For a new or rotated key, `GET /api/v1/machine/enroll` with the same join bearer returns only its `office_id` while Open, so an installation can reuse its private producer for that office without sending it to another. After enrollment use only the producer credential. For a trusted
   installation use the Owner-issued producer instead. If one is lost, revoke and provision afresh.
2. `POST /api/v1/machine/sessions` with producer bearer and `harness` (1–40), `external_session_id`
   (1–128), `name` (1–60), private `writer_token` (`amo_writer_<random>`), optional `project` (1–60)
   and `lifecycle` (`session` by default, or `daemon`). These are session-open payload fields, not installer settings. For a workspace-based plugin, set `harness` from the engine and `name` from the working folder’s basename. Do not require a static `project` setting: omit this public display label or derive it from session metadata suitable for office viewers. The credential selects the office. A new session returns 201 with `agent_id`,
   `generation`, `expires_at`, `last_seq` and a boolean `inbox`. Only `inbox: true` is a task grant; treat a missing field from older collectors as false. Retrying with the same live writer returns its metadata
   (200), not a second avatar. A different writer for that identity gets 409. Names may be disambiguated
   for display. Safety ceilings are 256 non-revoked producers per office and 128 session identities per
   producer, including closed identities. These are not physical seats or configurable billing quotas.
3. Use the **writer** bearer with `/api/v1/agents/{agent_id}/heartbeat` and `/events`. Start at
   `last_seq + 1`; serialize reports. The machine session's sequence survives collector restart.
   For an exact event retry, preserve the original JSON field order and event ID. Changed content is
   rejected; retries do not duplicate run effects. A duplicate heartbeat is rejected with 409.
   Only writers with the inbox grant may list or operate on tasks assigned to that identity.
   To update display metadata, `PATCH /api/v1/machine/sessions/{agent_id}/project` with the current writer bearer and `{"project":"Release Notes"}` (1–60 characters). This publishes an office-scoped `project` notification only on change, without renaming the agent, starting a run, or changing its sequence.
4. Before the 15-minute writer expiry, or after disconnection, `POST /api/v1/machine/sessions/{agent_id}/resume`
   with producer bearer, current `writer_token` and a freshly generated `next_writer_token`. Only one
   rotation wins. IDs, sequence and history remain; the old writer cannot report. Keep both secrets
   until confirmed. If the reply was lost, try step 2 with the new writer to discover a committed
   rotation without another mutation. Reporting expiry alone does not destroy proof for authorized
   resume. If neither proof works, stop; never create replacement sessions in a retry loop.
5. `DELETE /api/v1/machine/sessions/{agent_id}` with producer bearer and `X-Writer-Token` closes the
   identity. Its writer cannot report or resume. A genuinely new session needs a new external ID.
   Closing, revoking or re-enrolling does not finish a run, transfer a task or extend its task lease.

Report-only credentials receive 403 from inbox routes, even for a pending task addressed to them.
A revoked, expired or wrong-target writer receives 401. Only trusted producers explicitly granted `inbox:true` may pull visit tasks. Demo workers explicitly use
both ingest and inbox. Producer management is available to Owners in Workspace Access. The [public connector guide](../public/guides/integrations.html) includes wire examples and a [Pi folder package](../public/downloads/agent-mini-office.zip) for telemetry and, with a Trusted Inbox grant, assigned-task delivery to the idle Pi visit. Its local `actions.json` maps registered tools by source; it is not a credential file or part of the HTTP contract. See the [mapping example and schema](../public/guides/integrations.html#pi-actions).

A child run has `parent_run_id`; it does not automatically register a new agent. An already registered
same-office child agent may own a linked run and reuse its existing avatar.

### Explicit lifecycle

Machine session open accepts optional `lifecycle: "daemon" | "session"`; invalid values return 422. Omission defaults to `session` for machine opens; legacy rows without a declaration remain `unspecified`. The value is stored as `lifecycle:daemon` or `lifecycle:session` in
existing capabilities, without a migration. Conflicting/malformed declarations remain unspecified.
Harness kind never implies lifecycle. Online standby requires explicit idle and no active run, claimed work, error or human wait; see [Office scene](SCENE.md).

## 4. Credentials

Three kinds, never interchangeable.

| Kind | Shape | Used for | Must not |
|---|---|---|---|
| Agent token | `Authorization: Bearer amo_agent_<32 byte base64url>` | ingest heartbeat and events, fetch tasks | open the UI, read other agents |
| User session | `amo_session` cookie, httpOnly, SameSite=Lax | the panel UI | forge agent events |
| Share link | `?share=<signed token>` | visitor read-only view | write anything |

Token storage rules:

- The raw token is shown exactly once, at creation.
- What is stored: `sha256(token)` plus the first 8 characters as a display prefix
  (`amo_agent_ab12cd34...`).
- Default scopes: `ingest`, `inbox`. No admin scope.
- Revocation invalidates the grant. Session cleanup removes the writer and revokes a machine connector only after its last session. The separate legacy fixed-token dedicated grant survives roster cleanup.

Rate limits are per token, not per IP, because IPs get NATed behind one address:

| Action | Limit |
|---|---|
| heartbeat | 1 per 5 seconds, excess requests are coalesced into a `200` with no work |
| event batch | 60 requests per minute |
| payload per batch | 64 KB, at most 200 events |
| payload per event `data` | 4 KB |
| claim and ack | 120 per minute |

A `429` response includes `Retry-After`. Clients must honor it.

## 5. Endpoints

Base: `https://<domain>/api/v1`. All bodies are JSON, `content-type: application/json`.

### 5.1 Ingest (agent token)

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/agents/{agent_id}` | update metadata (kind, host, version, capabilities) |
| `POST` | `/agents/{agent_id}/heartbeat` | lightweight liveness and status |
| `POST` | `/agents/{agent_id}/events` | event batch, idempotent |
| `GET` | `/agents/{agent_id}/inbox?status=pending` | list unclaimed tasks |
| `POST` | `/agents/{agent_id}/inbox/{task_id}/claim` | lease for 60 seconds, renewable by the holder |
| `POST` | `/agents/{agent_id}/inbox/{task_id}/ack` | finish and submit a result |
| `POST` | `/agents/{agent_id}/inbox/{task_id}/fail` | finish with a reason, task becomes `failed` |

A writer is valid only for its own `agent_id`. A wrong-target credential returns `401`; a valid writer without the required scope returns `403`.

### 5.2 Read (user session or share link)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/snapshot` | bootstrap the UI in one payload |
| `GET` | `/stream` | SSE, see 5.4 |
| `GET` | `/agents/{agent_id}` | one agent in detail |
| `GET` | `/agents/{agent_id}/events?since_event_id=&limit=` | timeline |
| `GET` | `/rooms` | room definitions and occupants |

### 5.3 Write (user session, role owner or admin)

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/tasks` | list and create tasks |
| `PATCH` | `/tasks/{task_id}` | change title, brief, priority; cancel |
| `GET`/`POST` | `/agents` | list and create agents |
| `POST` | `/agents/{agent_id}/tokens` | issue a token |
| `DELETE` | `/agents/{agent_id}/tokens/{token_id}` | revoke |
| `GET`/`POST` | `/members`, `/invites` | manage humans |

### 5.4 Stream

`GET /stream` sends SSE with these `event:` names:

```
event: snapshot      → same payload as GET /snapshot
event: presence      → {agent_id, org_id, state, room, task, activity, heartbeat_state, last_seq, last_seen_at}
event: signal        → {org_id, agent_id, signal: {id, seq, run_id, type, at, detail}}
event: run           → {org_id, agent_id, run_id, state, title}
event: task          → {org_id, task_id, agent_id, status}
event: counters      → {org_id, agents_online, runs_active, tasks_pending}
```

Implementation notes: frames are filtered per organization, so one share link never sees another
office. Unscoped bus publications are also rejected. Signal metadata is published only after commit;
rolled-back, duplicate and rejected events do not produce signal frames. `detail` is a bounded metadata
summary, never raw nested event data. Events arriving during the initial snapshot use a bounded buffer
and are flushed afterward; periodic snapshots provide resynchronization. `run` and `task` frames are hints: a client should
re-read `/snapshot` rather than try to reassemble task lists from deltas.

Clients reconnect with `Last-Event-ID`. The server sends a full `snapshot` every 60 seconds as a resync.
An SSE keepalive comment (`: ping`) goes out every 15 seconds so proxies do not drop the connection.

Raw event bodies are not sent over SSE; the timeline is fetched on demand through 5.2. Minimal `signal`
frames update reported cues immediately. Snapshot latest-signal ties use insertion order rather than
random UUID tails, so a resync does not reverse events accepted within the same batch.

### 5.5 Dashboard and offices (user session)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/config` | public: whether registration is open, public slugs, `needs_setup` |
| `POST` | `/setup` | first run only, creates the first administrator and office |
| `POST` | `/auth/login` | email and password, sets the session cookie |
| `POST` | `/auth/logout` | revokes the session server side |
| `GET` | `/auth/me` | current member and office |
| `POST` | `/auth/register` | creates an office and its owner, when enabled |
| `GET` | `/offices` | your office, its agents, token counts |
| `PATCH` | `/offices/{slug}` | same-office Owner only: rename the office display name |
| `POST` | `/offices/{slug}/demo` | start demo; optional integer `count` 5–8, default 6 |
| `DELETE` | `/offices/{slug}/demo` | stop and clear this panel demo's agents and their assigned tasks, runs, tokens and presence; startup also clears leftovers. CLI or ambiguous ownership is preserved. A demo parent linked to another worker's run is retained to prevent cascading deletion of that worker's history. |
| `POST` | `/offices/{slug}/share` | issue a read only share link |
| `GET` | `/offices/{slug}/tasks` | board list with agent names, any status but cancelled |
| `POST` | `/offices/{slug}/tasks` | create a task for one agent |
| `POST` | `/offices/{slug}/tasks/{task_id}/cancel` | cancel before it finishes |
| `POST` | `/offices/{slug}/tasks/{task_id}/assign` | move a **pending** task to another agent |

Setup, self-registration, CLI office creation and rename accept a single-line display name with a
trimmed length of 1–32 UTF-16 code units (the HTML `maxlength` measure). Overlong values are rejected,
not truncated. Existing office names are not rewritten. Rename accepts only `{ "name": "KoiN Studio" }` and returns
`{ "name": "KoiN Studio", "slug": "original-slug" }`. Invalid input returns 400, a missing member
session 401, and a wrong office or non-Owner role 403. The slug, share links and credentials do not
change. Office views receive the name in the next snapshot; no new SSE event is required.

Board writes never finish a task. Only the run holding the lease can `ack` or `fail` it, so the panel
cannot fake work that an agent never did.

`POST /setup` answers `403 forbidden` as soon as any member exists. It is a bootstrap, not a backdoor,
and it never creates a second administrator.

Only the office Owner may `PUT /offices/:slug/public-view` with `{"enabled":true}` or `{"enabled":false}`. The response includes the stored boolean `public_view`, also present in the member's office listing. Off ends anonymous live streams (`access-revoked`); turning it off does not revoke member sessions or private share tokens.

Read access to an office is the union of three things: the office has Public View enabled, the caller holds a
share link for that office, or the caller is signed in as a member of it. Public means read only.

### 5.6 Health

`GET /health` requires no auth and returns only `{ok:true, version, uptime_s, db:"ok"}`. Do not leak
agent counts.

## 6. Heartbeat and presence

```json
POST /api/v1/agents/{agent_id}/heartbeat
{
  "seq": 1482,
  "reported_at": "2026-11-17T13:45:43.120Z",
  "state": "working",
  "task": "refactor auth middleware",
  "activity": "editing src/auth.ts",
  "run_id": "019ac1f2-...",
  "progress": 0.4,
  "counters": { "tokens_in": 1840, "tokens_out": 620 }
}
```

Every field except `seq` is optional. `seq` is monotonic per agent, starts at 1, and keeps increasing
across restarts (persisted in `~/.minioffice/agent.json`). A `seq` lower than the stored `last_seq` is
rejected with `409` unless the request is a replay.

Presence is computed by the server and never sent by the client:

| Condition | State |
|---|---|
| `now - last_seen_at < 30s` | `online` |
| `30s <= delta < 90s` | `stale` |
| `delta >= 90s` | `offline` |

Recommended client heartbeat: **20 seconds with 0 to 5 seconds of jitter**. The TTL is 3x the interval
so a wobbling WiFi connection for 20 seconds does not raise a false alarm.

**A heartbeat does not write to disk per request.** The server keeps it in memory and flushes to
`agent_presence` every 5 seconds or whenever `state` or `room` changes, whichever comes first. This is a
requirement, not premature optimization: 50 agents would otherwise saturate the VPS disk.

## 7. Events

```json
POST /api/v1/agents/{agent_id}/events
{
  "events": [
    {
      "event_id": "019ac1f4-8f2e-7c31-9b02-5a1c2d3e4f50",
      "seq": 1483,
      "type": "tool.call",
      "reported_at": "2026-11-17T13:46:02.000Z",
      "run_id": "019ac1f2-...",
      "room": null,
      "data": { "tool": "bash", "duration_ms": 1240, "ok": true }
    }
  ]
}
```

`event_id` is generated by the **client** as a UUIDv7. The server stores it as the primary key, so a
retry is automatically idempotent: an existing `event_id` returns `200` with `{"duplicate": true}` and
inserts nothing.

Response:

```json
{ "accepted": 1, "duplicate": 0, "rejected": [], "next_seq_hint": 1484 }
```

`rejected` contains `{index, code, message}`. A rejected event does not fail the rest of the batch.

### 7.1 Event taxonomy

Only the types in this table are accepted. Anything else returns `422 unsupported_type`, and the client
shim must map to one of these.

| Type | Origin | Meaning | Example `data` |
|---|---|---|---|
| `agent.registered` | agent | agent came up, harness version | `{version, capabilities}` |
| `agent.shutdown` | agent | clean shutdown | `{reason}` |
| `run.started` | agent | a unit of work begins | `{title, kind}` |
| `run.finished` | agent | completed normally | `{summary?}` |
| `run.failed` | agent | completed with an error | `{error_code, message}` |
| `plan.start` | agent | thinking phase | `{kind: brainstorm\|read\|research\|design, topic}` |
| `plan.end` | agent | thinking phase done | `{outcome?}` |
| `tool.start` | agent | a long tool begins | `{tool, target?}` |
| `tool.end` | agent | long tool finished | `{tool, duration_ms, ok}` |
| `tool.call` | agent | short tool, one event | `{tool, duration_ms, ok}` |
| `spawn.started` | agent | subagent created | `{child_label, purpose}` |
| `spawn.finished` | agent | subagent done | `{child_label, ok}` |
| `human.waiting` | agent | blocking human input | `{kind?, options?}` (standard display IDs only) |
| `human.resumed` | agent | blocking prompt closed; no decision implied | `{}` |
| `error` | agent | error that is not a run failure | `{code, message, recoverable}` |
| `note` | agent | free form note for the timeline | `{text}` |
| `task.claimed` | server | agent took a task | `{task_id}` |
| `task.acked` | server | task completed | `{task_id}` |
| `task.expired` | server | lease expired | `{task_id}` |

A `tool.start` without a matching `tool.end` is closed automatically after 10 minutes with
`ok:false, reason:"timeout"`. That is the guard for an agent that dies mid tool call.

`data` must not contain prompts, file contents, command output, or credentials. See section 12.

## 8. Room vocabulary

A closed set. The server rejects a `room` outside this list (`422 unknown_room`) and resolves `null`
through the mapping in 8.1.

| Room | When |
|---|---|
| `lobby` | agent registered, never sent a heartbeat |
| `barber` | onboarding, first session |
| `desk` | default work, writing code, HTTP/fetch requests; idle is labelled separately |
| `whiteboard` | `plan.start` kind `brainstorm` or `design` |
| `library` | `plan.start` kind `read` or `research` |
| `workshop` | heavy execution tools: bash, build, test, deploy, migrate |
| `print-room` | producing artifacts: export, generate, render |
| `phone-booth` | `spawn.started`, webhooks, notifications and email |
| `meeting` | `human.waiting` and explicitly reported coordination |
| `pantry` | `run.finished`, cooldown, backoff after a rate limit |
| `intern-desk` | a subagent run working on its own |
| `away` | presence `offline` |

`error` does **not** move the avatar. The avatar stays in its room and the desk lights red. Moving the
character on error hides the bug.

### Semantic actions (v1)

The sender translates observed work into `data.action`. The [action schema and catalogue](../public/schemas/action-v1.json) defines the IDs, labels, poses and room intents; its `type: string` validates the field, not the whole batch. A sender without tools can use `{"type":"note","data":{"action":"lookup_file"}}` inside a normal sequenced event. `tool.start` and `tool.call` accept the same field. See the [authenticated curl example](../public/guides/integrations.html#actions). New engine mappings belong in senders, not in the reducer.

On those same event types, optional `data.variant` must be an ID listed under the explicit `data.action` in `x-actions`. For example, `{"action":"search_web","variant":"laptop_typing"}` keeps the search label and library room intent but requests a spare laptop. The collector rejects a missing action or mismatched variant with `invalid_variant`. The committed variant is present in both SSE and snapshot signals. If occupied, try the selected entry’s direct `fallback` IDs in order, then its action’s remaining `working` and `overflow` variants, without duplicates. Cosmetic `work_trip` entries are not implicit fallbacks. The local tool map need not define fallbacks. Return to the selected variant when possible. If every compatible station is busy, keep the activity label and wait with a prop-free gesture (still under reduced motion). Omitting the field keeps automatic assignment.

An ID must match `^[a-z][a-z0-9_]*$` and be at most 48 characters. Unknown valid IDs project as `other` in SSE and snapshots: lobby on the Board, **Other Activity** at a neutral available object in 3D. A malformed ID or use on another event type puts `invalid_action` in the batch's `rejected[]`, even on HTTP 200. An omitted action is accepted; see the common defaults below. `final_response`, `final_print` and `final_call` have no room intent; they describe an optional visual beat, not a task outcome.

### 8.1 Deterministic mapping

The reducer runs server side, in priority order:

1. Events for a child sharing its parent's registered agent do not move the parent's room.
2. A supplied `data.action` controls room intent, ahead of a valid `event.room`, `data.tool` or `data.kind`. A null catalogue room keeps the previous room.
3. Without an action, an explicit valid `event.room` overrides event mapping.
4. Otherwise `type`, `data.kind` and `data.tool` propose a room. Unmapped events keep the previous room. `spawn.finished` and `human.resumed` propose `desk`; silence proposes nothing.
5. Effective presence still overrides the room to `away` when offline. Before reporting, use lobby.

Linked child avatar placement is a separate UI projection (intern desk or a visible parent's meeting),
not a server-side override of the registered parent's presence.

**Cross-engine defaults.** Only `tool.start` and `tool.call` without either action or room use this case-insensitive table of complete tool names. `bash`, `powershell`, `shell` → `use_tools`; `grep`, `rg` → `search_content`; `ls`, `find`, `glob` → `lookup_file`; `read` → `read`; `edit`, `write` → `write`. Everything else is accepted as `other`. Snapshot and SSE expose the resolved action; `action_origin: "default"` distinguishes a collector default from a sender report. No matching on harness, extension, command, arguments or results. The scene consumes the action; it has no tool-name fallback.

**Migration differences.** Unknowns no longer imply workshop. A filename glob now prefers a filing cabinet. A sender reporting a webhook as `call` gets Communication, not Sending Webhook. A final beat requires an explicit final action, not a note title. A `write` still prefers a desk and may briefly visit an available board; `plan` has priority there. The simulator, CLI demo and both Pi downloads report explicit tool actions. No producer is revoked and the flat download remains supported. See the [examples and common defaults](../public/guides/integrations.html#legacy-actions).

**Passive human waits.** `human.waiting` accepts an optional `data.options` array of distinct standard IDs (`yes`, `no`, `select`, `input`); the panel renders labels, never controls. Omit it when no safe metadata is available. Do not send titles, option text or decisions. Pi's blocking UI hook exposes the prompt kind, not the actual choice list. `human.resumed` has empty data. [Display field schemas](../public/schemas/display-v1.json).

### 8.2 Hysteresis

The visual room may not change faster than every **2 seconds**. The server keeps `room_pending` and
`room_pending_since` and only writes the effective `room` once the threshold passes. Without this the
avatar flickers and the panel becomes unreadable.

## 9. Runs and subagents

A `run` is a unit of work. It is created automatically by `run.started` and closed by `run.finished` or
`run.failed`.

| Field | Content |
|---|---|
| `id` | UUIDv7, supplied by the client on `run.started`; the server generates one if omitted |
| `agent_id` | owner |
| `parent_run_id` | set when this is a subagent |
| `task_id` | optional, when the run works a task from the inbox |
| `state` | `active`, `finished`, `failed`, `abandoned` |
| `title` | public task label from `data.title`, max 200 characters; use a neutral category instead of prompt text |
| `avatar_label` | optional public name in a linked child start, 1–40 ASCII letters/digits/spaces/underscore/hyphen, starting with a letter or digit; projected separately from the task title |

Rules:

- The client generates `run_id` so it can tag events before the `run.started` response arrives, and so a
  retried batch stays idempotent. The server falls back to generating one when the field is missing.
- At most **one active main run** per agent. Starting a new main run abandons the old active main;
  starting a linked child does not abandon it.
- Up to **32 active child runs per agent**; excess items are rejected with `capacity`.
- A supplied existing run ID cannot be reused for a new start. Other explicit run IDs must belong to
  the authenticated agent in the same office; invalid ownership returns an `invalid_run` item rejection.
- Parent links must resolve within the office. A labeled child requires a valid explicit child ID and existing parent. Machine writers can only link a parent owned by the same agent. Older dedicated-agent starts without an avatar label retain the unlinked main-run fallback for missing/foreign parents; snapshots suppress historical foreign parent links.
- Snapshots expose `kind`, `parent_run_id` and `parent_agent_id` for actual active runs. At most six
  temporary child avatars are drawn; overflow counts remain visible under their owners. A separately
  registered child-only agent is reused, not duplicated. Spawn notifications alone create no avatar.
- Automatic abandonment after 30 minutes is not implemented; clients must close runs explicitly.
  This is distinct from heartbeat-based stale/offline presence and task lease expiration.

## 10. Task inbox (downlink)

The panel never pushes. The agent pulls. Agents live behind NAT on a homelab and a Macbook: pushing means
opening a port or a tunnel, pulling means nothing.

```json
GET /api/v1/agents/{agent_id}/inbox?status=pending

{
  "tasks": [
    {
      "id": "019ac1f5-...",
      "title": "Fix failing auth test",
      "brief": "Token refresh test fails in CI.",
      "priority": 2,
      "created_at": "2026-11-17T13:00:00.000Z",
      "lease_seconds": 60
    }
  ]
}
```

### 10.1 State machine

```
pending ──claim──> claimed ──ack──> acked
   ^                  │
   │                  ├──fail──> failed
   │                  │
   └────expired───────┘  (lease ran out, sweeper)
```

| Endpoint | Effect |
|---|---|
| `claim` | `pending` to `claimed`, set `lease_expires_at = now + 60s`, record `claimed_by_run` |
| `ack` | `claimed` to `acked`, store `result` (max 8 KB, text only) |
| `fail` | `claimed` to `failed`, store `result` with the reason |

In v1 the inbox endpoint lists `pending` tasks only, up to 20, ordered by priority then age. There is
no `status` filter yet, and claiming always requires a `run_id` that is an active run of that agent. Send
`run.started` first or the claim is rejected with `409`.

`task.claimed`, `task.acked`, and `task.expired` are written to the event log with `origin = server`.
There is deliberately no `task.failed` event: the task row itself carries the outcome in `status` and
`result`, and adding a type would mean a schema migration for no extra information.

Rules that prevent double work:

- Repeating `claim` for the same `run_id` and live lease returns `200` and extends the execution deadline. It does not create a second `task.claimed` event.
- If another run holds a live lease, return `409 lease_held` with `lease_expires_at`.
- The lease can be renewed by claiming again from the same `run_id`.
- A `claimed` task whose lease expires returns to `pending` and the server records `task.expired`. A 60
  second lease means long work must renew. That is intentional, so a dead agent cannot hold a task
  hostage.
- `ack` and `fail` require the unexpired lease and its owning `run_id`. After a terminal receipt is committed, only a retry with the same run, outcome and result returns the recorded task; a conflicting receipt returns `409`.

### 10.2 When an agent polls

- Only when **idle**, never while working. A busy agent does not need to be offered more work, and this
  is natural backpressure.
- Every 30 to 90 seconds with jitter. Clients must randomize, so all agents do not poll on the same
  second.
- When the panel creates a task there is no push notification. The task waits for the next poll. That is
  an accepted consequence of pulling.

At most 5 `pending` tasks per agent. Beyond that, `POST /tasks` is rejected with `409 inbox_full`, so the
inbox does not become a dumping ground.

## 11. Idempotency, ordering, time

| Concern | Rule |
|---|---|
| `event_id` | UUIDv7 from the client, primary key of `events`. A duplicate returns `200 duplicate:true` |
| `seq` | monotonic per agent, may not go backwards. `UNIQUE(agent_id, seq)` in the database |
| `reported_at` | client clock, **display only**. May be wrong |
| `received_at` | server clock, authoritative for sorting, TTL, and aggregates |
| Presence | computed from `received_at`, never from `reported_at` |
| Timeline sort | `received_at`, then `id` |

Clock skew cannot be avoided. Never sort a timeline by agent clocks: three machines with three wrong
clocks produce an order that makes no sense.

## 12. Content policy

`data` carries **metadata only**. The server rejects the following with `422 content_rejected`:

- Prompts, system prompts, or conversation text.
- File contents, command output, diffs.
- Credentials, tokens, keys, cookies.

Allowed: tool names, file names (path only, no content), durations, status, token counts, hashes, task
titles, and a `summary` of at most 280 characters that the agent has already redacted.

Rationale: the panel sits on a public domain. Once prompt text is ingested, you own an archive that may
contain API keys and customer data. Metadata is enough for the purpose of watching an office.

If deep debugging becomes necessary later, add a separate blob channel with 24 hour retention and
encryption at rest. Never mix it into the `events` table.

## 13. Error format

```json
{
  "error": {
    "code": "lease_held",
    "message": "Task 019ac1f5 is claimed by another run until 2026-11-17T13:47:00Z",
    "request_id": "019ac1f9-..."
  }
}
```

Codes in use: `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `payload_too_large`,
`unsupported_type`, `unknown_room`, `invalid_seq`, `content_rejected`, `lease_held`, `lease_expired`,
`inbox_full`, `validation_failed`.

## 14. Retention

Only an accepted heartbeat triggers automatic roster cleanup, in that heartbeat’s office. There is no startup or periodic roster sweep. `MINIOFFICE_RETENTION_MINUTES` defaults to 30 minutes **after Offline** and accepts positive whole minutes. `MINIOFFICE_DEDICATED_RETENTION_MINUTES` defaults to 1440. Neither setting changes presence or writer lease durations. If the office is silent, eligible rows remain until the next heartbeat or manual removal.

`DELETE /api/v1/offices/{slug}/agents/{id}` requires an Owner session. It returns 204 on deletion, 409 if the agent is not offline, and 404 if the ID is not on that office’s roster. It removes the agent’s tasks, events, runs, aggregates and presence; independently owned children are detached rather than deleted. A fixed-token dedicated worker retains a hidden credential anchor and sequence watermark. Only an authorized heartbeat for the same ID with a higher sequence restores it. Old tasks do not return. A machine-session writer is not a dedicated grant.

Session removal takes precedence over the per-table lifetimes below.

| Table | Lifetime |
|---|---|
| `events` | 14 days, then pruned in batches |
| `agent_presence` | one row per reporting agent until session removal |
| `runs` | 30 days after `finished` |
| `tasks` | visit tasks: 15-minute pending pickup deadline; removed with their visit. Other inboxes retain their own lifecycle. |
| `daily_aggregates` | until session removal |
| `sessions` | 30 days, or on logout |

Daily aggregates (`runs`, `tool_calls`, `errors`, `tokens_in`, `tokens_out`) replace raw events after
pruning, so historical charts survive without keeping every detail.

## 15. Appendix A: curl cookbook

Everything an agent needs can be done without an SDK. This is what "universal panel, skill on the client
side" means in practice.

```bash
BASE=https://minioffice.example.com/api/v1
TOKEN=amo_agent_xxx
AGENT=019ac1f0-7a11-7000-8000-000000000001

# heartbeat
curl -s -X POST "$BASE/agents/$AGENT/heartbeat" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seq":1,"state":"working","task":"refactor auth"}'

# event batch
curl -s -X POST "$BASE/agents/$AGENT/events" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"events":[{"event_id":"019ac1f4-8f2e-7c31-9b02-5a1c2d3e4f50","seq":2,"type":"tool.call","data":{"tool":"bash","duration_ms":1200,"ok":true}}]}'

# fetch tasks
curl -s "$BASE/agents/$AGENT/inbox?status=pending" -H "authorization: Bearer $TOKEN"

# claim
curl -s -X POST "$BASE/agents/$AGENT/inbox/$TASK/claim" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"run_id":"019ac1f2-..."}'
```

The most minimal heartbeat, for an agent with no shim at all:

```bash
curl -s -X POST "$BASE/agents/$AGENT/heartbeat" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seq":1}'
```

## 16. Appendix B: UUIDv7 generator

SQLite has no v7 generator. Build it in Node, one function, no dependencies:

```js
const crypto = require('node:crypto');

function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(40 - i * 8)) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;              // version 7
  b[8] = (b[8] & 0x3f) | 0x80;              // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
```

An honest caveat: two ids created within the same millisecond are not guaranteed to sort against each
other, because the tail is random. The official order remains `received_at` then `id`. The benefit of v7
here is index locality and unguessable ids, not a replacement for a timestamp.

## 17. Appendix C: client shim obligations

This is not part of the panel, but it is the contract for the skills you write per harness. All are
mandatory:

1. **Never block the agent.** Send through an in-memory queue, no `await` on the critical path.
2. **Bounded queue** (200 events), drop the oldest when full, keep a `dropped_count`.
3. **Batch** every 2 seconds or 20 events.
4. **Retry with backoff** 1s, 2s, 4s, 8s, at most 5 attempts, then drop.
5. **Honor `429`** through `Retry-After`.
6. **Persist `seq` and `agent_id`** in `~/.minioffice/agent.json` so a restart does not move the sequence
   backwards.
7. **Close runs properly** on `SIGINT` and `SIGTERM`: send `run.failed` with
   `error_code:"interrupted"`.
8. **One config file**: `MINIOFFICE_URL`, `MINIOFFICE_TOKEN`, `MINIOFFICE_AGENT_ID`.

Mapping per harness, all ending in the same `curl` or `fetch`:

| Harness | Event source | Mapping |
|---|---|---|
| pi | session, tool, prompt and compaction hooks | The sample reports heartbeats, `tool.start`/`tool.call` with source-specific action and allowlisted tool metadata, `human.waiting`/`human.resumed`, and content-free notes for compaction start (`compact_context`), outcomes and confirmed final text responses. New visit display names use the working folder’s basename alone; changing the project label leaves the visit name and ID intact. A `note` with `kind: final-response` does not finish a task or alter the reported room. For pi-subagents, only an observed same-session single async launch and matching terminal lifecycle receipt produce linked child telemetry. The Pi adapter owns this translation; the collector does not recognize Pi event names. Session boundaries are not inferred run boundaries. See [Pi activity coverage](../public/guides/integrations.html#pi-actions). |
| hermes | session, turn, tool, child, human-input and post-compaction hooks | The [Hermes plugin](../integrations/hermes/agent-mini-office/README.md) sends observed lifecycle events and schema-mapped tool actions. An LLM call is not evidence of planning. Assigned task delivery uses the explicit Trusted Inbox grant, a session-bound LOCAL gateway route and the host’s injection permission. An accepted injection, idle state or ordinary reply does not acknowledge a task. |
| codex | CLI wrapper | argv to `run.started` with `title`, exit code to `run.finished` or `run.failed` |
| claude CLI | wrapper | same as codex, coarser granularity |
| anything | cron `curl` | heartbeat only |

If a harness can only send a heartbeat, that is still useful: the agent is visible sitting at a desk. Do
not force a full integration on day one.
