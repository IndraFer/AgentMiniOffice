# Integration and session identity

**Status:** fresh-install admission, session reporting, reconnect and producer revocation are implemented.
Use the [machine API contract](CONTRACT.md#machine-admission-and-sessions-implemented) for real requests.
The original wire/migration review below is historical. A [folder-based Pi connector](../public/guides/integrations.html#pi) implements telemetry with a private producer or office-key enrollment. Other harness packages, configurable capacity and private human responses remain proposals.

## Fresh-install baseline

The owner has confirmed that only the demo has run; there are no active deployed workers to migrate.
Design the first production machine API for a fresh database and newly issued credentials. Keeping
old token formats, assignments or demo history working is **not** an acceptance criterion. Do not add
a parallel authorization path, a token translator, or an upgrade runner for this demo schema. A fresh
start is an installation choice, not permission for the app to silently delete an existing database.

Use one authorization model on Node and Bun: the server derives the office and producer from the
credential, then verifies session ownership, writer generation and permission for the requested
operation. A workspace join key authorizes enrollment only. Display names, project paths, external
session IDs and advertised capabilities never authorize a write. Store credential verifiers rather
than recoverable token values. Keep secrets out of logs, snapshots, streams and portable exports.

**Office key exception:** the Owner can reveal/copy the reusable enrollment key in either mode. Closed stops enrollment only, not registered workers. An explicit rotation replaces the key; it does not rotate private producer or writer credentials. The active contract above supersedes conflicting historical acceptance criteria below.

**Reconnect versus reissue:** a network timeout is not evidence that a token failed. With valid proof,
reconnect to the same session and continue its committed sequence; do not mint a new avatar on each
retry. If a secret is lost, invalid or revoked, stop using it. Reconnect using a newly issued credential
through the currently authorized admission path. A general installation may re-enroll only while Open
with a valid join key; replacing a trusted credential requires authorized issuance, not self-promotion.
A replacement never silently adopts a prior session, grant, task or lease. Invalidate a replaced
credential and its dependent writer leases; an ambiguous issuance result must not cause unbounded
automatic enrollment. Do not build a service for replaying raw secrets from lost issuance replies.

The first implementation gate is a clean installation on each runtime: two sessions in one project
remain distinct; an ordinary reconnect keeps one avatar; a rejected/replaced token cannot write;
Closed denies general enrollment; and a newly connected worker cannot claim another worker's task.
The compatibility rollout and secret-recovery protocol recorded below are superseded, not a backlog.

## Problem

A globally installed Pi/OpenCode/other extension should not require a new manually configured token
for every project or session. Reusing today's agent token instead merges independent heartbeats,
sequences, runs and room changes into one misleading multitasking avatar. Project names are metadata:
two concurrent sessions in one project are still two sessions.

## Agreed product direction: admission and capabilities are separate

An office is a workspace. Its admission policy does not determine every worker's capabilities:

| Admission policy | General workers with a workspace key | Registered trusted workers with their own credential |
|---|---|---|
| Open | May join automatically for telemetry/visualization | May also join, with explicitly granted interaction capabilities |
| Closed | May not join through the general workspace key | May join if authorized |

Open admission is not anonymous access, public viewing, or Control Room membership. Human roles and
view-sharing remain separate. Registration is not exclusive to Closed workspaces: an Open workspace
can contain both general and trusted workers.

General workers can report their own presence, runs, safe activity metadata and Waiting for Human
state. They cannot claim task-board work or receive human responses through the workspace merely by
holding its general key. Reporting a waiting state does not create an interactive approval request.

A registered trusted worker may receive assigned tasks or use bidirectional human interaction when
those capabilities are explicitly granted. Trust does not grant member administration, access to other
workers' tasks, or permission to bypass the underlying harness's execution controls. The capability
names, defaults and role-to-grant matrix still require specification.

Credentials authorize a worker/connection, not a project. Both general and trusted session-based
workers must support distinct sessions without user-managed tokens for every session or project.
Persistent daemons retain stable identities while authorized; they do not require a legacy credential path.

Interactive human requests need a separate structured contract: request identity, owning worker,
session/run association, authorized responder, expiry/cancellation and duplicate-response handling.
A human response is not proof that execution resumed or completed; the worker reports the actual
outcome. The current metadata-only telemetry API is not already a chat/approval transport.

The first implementation covers enrollment, isolated session writers and an optional assigned-task
grant for trusted producers. Later capability and UI proposals are not implemented by this slice.

## Technical model for review

| Concept | Purpose |
|---|---|
| Office | Tenant boundary, determined by credentials on the server |
| Producer/integration | Stable identity of an authorized connector installation |
| Workspace key | Office-scoped admission credential for general telemetry workers in Open mode |
| Worker credential | Dedicated credential for a registered trusted worker with explicit capability grants |
| External session ID | Native harness session identity, sent automatically by the connector |
| Logical agent/avatar | A persistent daemon or an individual session, not the credential itself |
| Run/task | Work performed by that identity; parent/child relations remain explicit |

A proposed identity key is `(producer_id, harness, external_session_id)`. If a harness cannot provide a
stable session ID, the connector creates and persists a UUID for that session. Neither project path nor
an LLM-generated name substitutes for session identity. A daemon uses a separate persistent daemon key.
One connector token can therefore report multiple distinct sessions without manual per-session setup.

The collector resolves or creates a logical identity only inside the authenticated producer's office and
namespace. A client-supplied `session_id` is not authority to write another producer's avatar. Token
rotation keeps the producer ID and session history. Parent IDs must resolve to actual authorized,
same-office runs, never identities guessed from spawn labels.

## Authorization and lifecycle requirements

- Producer permissions are narrowly scoped to opening/reporting its own identities. General workspace
  admission grants telemetry only. Assigned-task execution and human-response delivery require explicit
  trusted-worker capabilities. Neither path grants member management, share-link creation or office-wide
  administration. The server must enforce these boundaries, not just hide UI controls.
- Creation and concurrent-session quotas prevent an ingest credential from spawning unlimited avatars.
- Each logical identity has its own monotonic event/heartbeat sequence. Separate sessions must not
  compete for a single shared sequence counter.
- Resuming a session reuses its identity; opening a genuinely new session does not. Concurrent emitters
  claiming the same session need an explicit single-writer/takeover policy before implementation.
- Closing a session ends its live representation while retaining history. Daemon standby is a separate,
  explicitly reported state, not a guess based on a harness name or quiet telemetry.
- Existing task/lease ownership remains authoritative. Ending a session does not silently reassign its
  work or let a new session acknowledge an old run's lease.
- Revoking a producer must block its subsequent writes. Token rotation and replay behavior require
  failure-path verification, not only a successful handshake demo.

## Panel and compatibility

The Control Room would manage workspace admission keys and registered trusted-worker credentials,
while sessions appear after an authorized handshake. Open workspaces offer both Connect to Workspace
and Register Trusted Worker; Closed workspaces admit only registered workers. The extension configures
its credential once; session IDs are automatic metadata, not additional user-managed secrets.
Fresh installations issue new credentials to daemons and session-based workers under the same rules.

### Proposed admission, resume and capacity rules

These defaults are for review, not new API guarantees.

1. Start new offices **Closed**. Opening an office enables an Owner to issue a revocable
   join key; it does not change existing workers, public viewing, share links or member roles. Register
   a trusted worker in either mode. A new registered worker starts with telemetry only; the Owner can
   grant assigned-task access and human-request access independently. Demo credentials confer no grants.
2. Exchange the Open join key once per installation for a server-assigned producer identity and a
   producer-bound reporting credential. Save it in the connector's private credential store. The
   shared key alone cannot resume a prior installation, write events, read the office, upgrade trust,
   or name another writer. If installation state is lost, enroll as a new producer; do not claim
   earlier sessions by guessing their IDs. Rate-limit enrollment separately from active capacity.
3. On session open, atomically resolve its external ID within the producer namespace, allocate a slot
   if needed and issue a short-lived writer lease. A reconnect with valid resume proof continues the
   same identity and sequence; invalidate the old writer generation before accepting new writes.
   Reject a competing writer without that proof. Accept exact event retries idempotently, not reused
   sequence numbers with different content. Project changes update metadata, not the identity.
4. Count one slot per admitted live session or daemon, not per credential, run, project or physical
   chair. Closing releases its slot. Following a disconnect, reserve it for a proposed 90-second
   reconnect grace (independent of visual freshness); then release it atomically. A late resume may
   retain history but must reacquire capacity. At the limit, reject only new slot claims, with a
   retryable capacity result; never evict a working session to make room. None of this completes a
   run, transfers a task, or extends a task lease.
5. Rotating the join key stops new enrollments with the old key. It does **not** remove installations
   already admitted: show this difference to the Owner. Closing Open admission or disabling a general
   producer denies its next handshake, write or renewal, including already-issued writer leases.
   Reopening does not revive disabled producers. Rotating a trusted credential keeps the worker ID
   but invalidates old proof; revoking it blocks that worker. Recheck mode, grants and revocation on
   protected operations, not only at enrollment. Do not log or display old raw credentials.

### First slice: wire and migration review (not shipped)

**Historical proposal — superseded.** The rest of this subsection, including the lost-reply protocol,
renew/close details and rollout, records the earlier compatibility design and its review. Do not
implement it as a requirement. The [fresh-install baseline](#fresh-install-baseline) takes precedence.

**Former recommendation:** add a separate machine session API. Leave the current agent API and credentials
alone. The first slice is admission and reporting, not inbox access, human answers, capacity UI,
member management or a connector release. A workspace slug selects a destination; it never proves
membership. The proposed routes below are relative to `/api/v1`, not instructions for existing clients.

| Proposed request | Required authority | Successful outcome |
|---|---|---|
| `POST /offices/{slug}/producers/enroll` | Open join key for this office | Create one general installation; return `producer_id` and private installation credential. No avatar yet. |
| `POST /machine/sessions/open` | Installation credential, or a separately provisioned registered-worker credential | Send `harness`, `external_session_id` and optional display metadata. Return `session_id`, `agent_id`, writer lease, `writer_generation`, lease revision zero, `expires_at`, resume proof and `last_seq` (initially 0). |
| `POST /machine/sessions/{id}/resume` | Same producer credential **and** private session resume proof | Send expected `writer_generation`. Return the same IDs, committed `last_seq`, new generation, lease, revision zero, expiry and resume proof; invalidate the old writer atomically. |
| `POST /machine/sessions/{id}/renew` | Current writer lease | Advance its lease revision and expiry once per accepted renewal. Do not extend a task lease or update presence. |
| `POST /machine/sessions/{id}/heartbeat` or `/events` | Current writer lease | Accept metadata only for the bound logical agent. Never take an authoritative office, producer or agent ID from the body. |
| `POST /machine/sessions/{id}/close` | Same producer credential and current writer lease | End this live session, invalidate its lease and resume proof, retain history. Do not finish a run or change task ownership. |

Use TLS. Send bearer credentials in authorization headers; any additional resume proof belongs in a
redacted request field, never a URL. Secret-bearing replies are private and non-cacheable. Recheck
producer status, office admission and writer generation at each protected operation, including retries.
An authenticated general producer cannot use the inbox even to list tasks. Open and Closed both admit
separately authorized registered workers. General admission never creates one.

**Retries and conflicts.** An external session ID is a lookup key, not resume proof. Opening an
already-live identity from another writer returns `409 writer_active`, not a replacement lease.
Disconnect is not close: an unclosed identity with a lapsed writer requires resume proof, never a
fresh open. Explicit close is terminal for that external session key. A fresh open or resume of a
closed key must not create a writer. A fresh open by its authorized producer returns
`409 session_closed`; resume with the invalidated proof returns `401` and is not a status lookup. Opening a genuinely new session requires a different external ID. Only a newly created
identity starts at sequence zero. Retain the closed mapping and its final high-water mark.
Use the lost-reply protocol below for enrollment, open and resume. It recovers the original
result, not a new credential or an implicit takeover.

#### Lost replies: enroll, open and resume (design only)

1. **Before sending:** the connector generates a fresh UUIDv7 `Idempotency-Key` and a separate
   32-byte cryptographically random `recovery_secret` (unpadded base64url) for this one operation.
   Persist both, the destination and the exact request in private connector storage **before** the
   first send. Serialize outstanding opens/resumes for one logical session. Retry with the same
   fields after a timeout or restart. Neither the UUID, the join key nor the external session ID
   substitutes for the secret. This is possession of private connector state, not device attestation.
2. **On first acceptance:** require the normal route authority. Use a database uniqueness constraint
   on `(office, operation, caller namespace, Idempotency-Key)`; the enrollment namespace is the join
   key's immutable ID, not its raw value. For open/resume use the authenticated producer ID. Bind the
   receipt to the exact target, credential version, validated request fields and recovery-secret
   verifier. For resume, require the current session proof and expected writer generation; replace the
   generation and rotate the session proof atomically. Concurrent requests for the same old generation
   cannot both win. One transaction commits the state change **and** its successful response receipt;
   return nothing before commit. A rollback leaves neither. An exact concurrent retry reads the winner.
3. **Receipt storage:** store verifier hashes, a request digest, current-result references and the
   encrypted **complete** original success response. No bearer token or resume proof is stored in
   plaintext; the recovery secret itself is never stored, even inside the ciphertext. For this response only, derive an encryption key from the high-entropy recovery secret
   with HKDF-SHA-256 (operation-specific domain, fresh random salt). Use authenticated encryption
   (AES-256-GCM, fresh 96-bit nonce), binding the receipt identity, target and expiry as associated
   data. Store salt, nonce and authentication tag with the ciphertext. Do not place secret fields,
   headers, bodies or decrypted responses in logs, URLs, snapshots, SSE or diagnostics. Return
   `Cache-Control: no-store`. Never extend a lease or its recovery window on replay.
4. **On replay:** authenticate the original enrollment/producer credential and recheck current office
   policy and revocation *before* disclosing any receipt. Require the same recovery secret and
   matching request. Changed fields with correct proof give `409 idempotency_conflict`; wrong proof
   gives generic `401` with no identity details. For a committed resume only, the consumed resume
   proof can match its stored verifier for this exact receipt; it cannot authorize another resume.
   Return the complete original response: enrollment includes its installation credential; open and
   resume include the **issued resume proof**, writer lease, generation, lease revision, IDs, expiry and sequence as
   of commit. Do not mint substitutes. If the caller is still authorized and has the exact receipt
   proofs but the *result* is closed, superseded or past its original lease expiry, return
   `409 result_obsolete` without any credential, even inside the retry window. An invalid caller
   credential still gets `401`; admission denied by current policy gets `403`. A rotated join key
   cannot retrieve replies using the old credential. No slot, publication, lease or sequence change.
5. **Bounded lifetime:** record `accepted_at` on the server in the winning transaction. The receipt
   expires at `accepted_at + 120s` by server time; the connector's UUID timestamp is not a clock
   input. This window does not extend a writer lease or the separate reconnect grace. At or after
   expiry, purge ciphertext and retain a non-secret spent-key marker scoped to the authenticated
   operation namespace for as long as that namespace can submit requests. An authorized retry of
   a spent key returns `409 attempt_expired`, never a new mutation or any session details. Limit
   accepted operations per namespace; on storage quota exhaustion refuse new attempts rather than
   evicting live-namespace markers. Never recycle retired namespace IDs. If
   the connector already holds valid session proof, use a fresh, authorized resume after timeout;
   otherwise stop automatic recovery and report that re-enrollment or operator reconciliation is
   needed. Do not silently create another installation, replace a writer, or adopt by name. After a
   successful reply, atomically persist the returned credentials before deleting the pending attempt.

#### Renewal and explicit close

- **Renew:** send the current writer lease, expected lease revision (initially zero) and a fresh
  attempt ID. A successful renew advances the revision once and returns the new revision and absolute
  expiry. Persist the last successful renewal ID, request digest and result on the writer generation.
  An exact retry with the still-valid lease returns that result without extending time again. Older
  revisions or conflicting requests return `409`; a stale or expired writer cannot renew or replay.
- **Close:** send the producer credential as well as the current writer lease and a fresh attempt ID.
  Atomically close the mapping, release its slot once and save a non-secret acknowledgment bound to
  producer, generation, attempt and a verifier for the consumed lease. An authorized exact retry
  returns the same `204` even though that lease can no longer write. Recheck producer authority and
  office policy; this narrow exception confirms only its own close. Never renew a closed lease,
  reopen a closed mapping or return a secret from this acknowledgment.

**Acceptance gate (not yet run):** exercise all five lifecycle routes on Node and Bun. Drop the reply
immediately after commit, restart the connector and collector, and retry: same result, one mutation.
Drop before commit: exactly one eventual success. Race identical retries and competing resumes.
Try the same join key and attempt ID from an installation missing the recovery secret: no credential
or avatar disclosure. Retry after close, rotation, supersession, lease expiry, and receipt purge:
no usable old proof and no new identity. Check that the persisted receipt and logs contain no raw
secrets. Use the proof recovered from a lost open/resume reply for a subsequent legitimate resume.
Test a skewed client clock, the exact server expiry boundary, a lost renewal reply (unchanged expiry),
and a lost close reply (same acknowledgment, single release, same external ID cannot reopen).
This protocol does not change legacy `amo_agent_` retries or task leases.

For new writers, persist the sequence high-water mark and a bounded receipt (identity, event ID or
heartbeat sequence, normalized payload digest, outcome) in the **same transaction** as acceptance.
An exact retry is successful without a second publication; conflicting reuse returns a conflict. For
batches report item-level outcomes. Outside receipt retention, reject an old sequence without
reapplying it. Resume must return the durable value even after process restart. Missing/invalid,
expired, stale-generation or wrong-target credentials return a non-enumerating `401`; valid authority
blocked by current policy returns `403`. Do not return details about another office or producer.

**Compatibility findings from the current implementation:**

- `authenticateAgent` binds `amo_agent_` to the route's `agentId`, rejects revoked or archived agents
  and returns **401**, including on an ID mismatch. Ingest and inbox use that same check. The stored
  token `scopes` default and self-reported agent `capabilities` are **not** an enforced grant system.
  Never pass new telemetry-only credentials through this guard or issue legacy tokens for session avatars.
- `createAgent` creates both an agent row **and** a legacy credential. `agents(org_id, name)` is unique.
  Allocate session avatars without this registration helper; disambiguate same-name sessions for
  display without merging them. Use server-enforced `(producer_id, harness, external_session_id)`
  uniqueness and a transactional writer generation, not a project path or display-name lookup.
- Existing heartbeat rejects `seq <= last_seq`; event batches identify duplicates by event ID, not a
  comparison of payload and owner. The presence store periodically flushes its in-memory sequence.
  Do not promise crash-safe resume or exact-retry semantics by wrapping these handlers unchanged.
- Today's registration endpoint is `POST /offices/{slug}/agents`. Do not build a migration around
  `PUT /agents/{id}` or token-management examples in the wider contract: these are not implemented
  registration, upgrade or revocation endpoints.

**Rollout proposal:**

1. Back up an existing v1 database. Introduce a versioned, transactional, additive migration before
   enabling any new route. The current bootstrap runs idempotent schema SQL and records version 1 on
   an empty version table; that alone is not an upgrade runner. Default new admission to Closed.
2. Do not transform, copy, reissue or re-scope legacy tokens. Preserve registered agent IDs, token
   hashes and revocations, sequence state, run history, inbox assignments and outstanding task leases.
   Closing general admission must not disable authorized legacy workers. No auto-conversion by name.
3. Enable new routes only after both runtimes can open an upgraded v1 fixture and pass the same HTTP
   checks: a legacy connector still reports and completes its existing claim; a revoked one stays
   denied; two same-name/same-project sessions get distinct avatars; restart/resume fences the old
   writer; Closed denies a previously admitted general writer. A rejected request must not change a
   sequence, avatar, task, slot or stream. Test lost replies and concurrent opens as well as success.
4. To back out, disable **all** new enroll/open/resume/renew/report paths, including live leases, and
   retain new records. Keep legacy routes running. Do not downgrade a live database or restore an old
   backup over newer writes. Any later opt-in transfer of a legacy identity is a separate design.

### Proposed interactive Waiting for Human flow

| Actor | Allowed action | What others see |
|---|---|---|
| Any reporting worker | Report `human.waiting`, without opening a request | Waiting status; **Respond in Original Harness** guidance, no reply control |
| Registered worker with human-request grant | Open a bounded, structured choice request for its own session and active run | An authorized Owner/Operator can see the question, choices and expiry in worker details |
| Same-office Owner or Operator | Select an offered choice while the request is pending | **Response Recorded**, not **Resumed**. A Viewer, share-link holder or general worker cannot read private request content or respond |
| Owning connector | Pull the recorded answer, deduplicate by request ID, acknowledge delivery and apply the harness's own policy | The avatar changes only on real telemetry, such as `human.resumed`, not on response or delivery |

Propose choice-only responses first, not arbitrary commands or free-form chat. Bind request ID to
workspace, producer, session and run on the server. Keep request/response bodies out of shared
snapshots, public SSE, generic activity labels and logs. Private reads must recheck membership and
capability. The first valid response wins atomically: retry of the same response by its author is
idempotent; a different response conflicts. An unanswered request can expire or be cancelled by its
owner; record these outcomes without inventing a reply. Terminating a session/run or withdrawing the
grant prevents further responses or delivery. Lost delivery acknowledgements allow the same answer
to be fetched again, never a second decision. If a connector cannot safely consume an answer after
reconnect, direct the human back to the original harness instead of replaying an action blindly.
Server deduplication does not guarantee that a connector applies a decision exactly once if it
crashes between applying and acknowledging it. Connector-side recovery remains a separate design gate.

## Gate before implementation

Review the proposed defaults, especially Close versus rotate, grant administration, response roles,
capacity grace and the fresh-install wire contract. No demo-data migration is required. Before
exposing controls, prove the following through the actual server routes on both supported runtimes:

- Open accepts both worker paths; Closed rejects general admission and previously admitted general
  writers. Invalid, revoked or foreign credentials cannot read or write another office.
- Two sessions in the same project have independent streams of writes, sequences, avatars and task
  owners. Resume preserves history; a stale writer or a different producer cannot take over.
- Concurrent final-slot claims admit at most one new identity. Reconnect during grace consumes no
  second slot. Expiry of grace does not acknowledge, fail or transfer a task.
- A general key or a worker lacking a particular grant cannot claim tasks, read private answers or
  submit interactive requests by inventing a worker ID. No machine credential can manage members.
- A plain waiting event shows no actionable request. Answer races, retries, expiry, cancellation,
  grant loss, private data in shared views and a disconnected harness have explicit negative cases.
  Only subsequent worker telemetry changes the displayed work status.

See the machine API contract above for shipped endpoints. No private interaction channel or demo-data migration is included.
