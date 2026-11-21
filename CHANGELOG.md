# Changelog

All notable changes to this project are documented here. Format follows Keep a Changelog. This
project and its Hermes connector follow the [versioning policy](CONTRIBUTING.md#versioning-and-releases).

## [Unreleased]

### Added

- Share Office can generate a responsive, public-only 3D iframe, with a small link back to the host office. Turning Public View off clears a live embed.
- Avatar drafts support Random, Men and Women style pools plus new face shapes, hair meshes, clothing cuts, footwear, colors and accessories. The updated catalogue also applies to existing visits and saved variations; the same seed remains stable between refreshes.

## [0.3.0] - 2026-11-20

### Added

- Agent details show a portrait built from the office's 3D avatar. Owners can preview another look, save it for that visit, or restore the original. Existing avatars keep their original appearance unless customized.

### Fixed

- Moved the coffee machine and its standing spot slightly farther from the sofa. Avatars can still reach the machine but can no longer squeeze between the planter and the sofa and get stuck passing each other there.

## [0.2.1] - 2026-11-20

### Added

- Member task cards show briefs, created/finished times and reported outcomes. Done shows the last 72 hours without deleting history. Updated Pi downloads and Hermes 0.4.0 return a marked one-line summary or reason from the task turn without a second model call.
- The office and integration guide now include favicons and social previews using a compact image of the demo office, with the office name and canonical slug URL for public offices. Private offices use a generic preview; share tokens never appear in the metadata.
- Hermes plugin 0.3.0 adds Trusted Inbox pickup for daemon avatars with host consent and gateway-backed ACP. Each task gets a private session, never a Telegram route. A durable dispatch marker prevents automatic resubmission after restart.
- Hermes plugin 0.2.0 adds opt-in daemon identity for messaging gateways: one telemetry-only avatar per installation survives worker changes and gateway restarts while its visit remains valid. Interactive session mode remains the default.
- The application version is embedded from the package manifest and displayed in the dashboard footer, including builds launched outside the repository.
- Added a downloadable Hermes Agent plugin with an editable tool-action schema, observed lifecycle telemetry and Trusted Inbox delivery on supported local gateway sessions. Plugin 0.1.2 accepts optional `name` and `project` labels for daemons without a working folder.
- Owners can switch on Public View to share a short read-only office URL, or switch it off to disconnect anonymous viewers without restarting the collector. New offices are private.
- Pi can now pick up a task assigned to its idle visit when the collector grants a Trusted token Inbox access. Visit tasks have 15 minutes for pickup. A claimed task has a separate renewable execution lease; its task-specific completion or failure receipt updates the dashboard without uploading the assistant’s reply. General and ungranted connections remain telemetry-only.
- Shared, selectable station and pose variants for 13 actions. REST clients and Pi tool maps can select an official `variant` or send the action alone for automatic placement. Explicit choices prefer their named station, then try catalogue fallbacks for the same action. New poses include desk mouse use, arranging sheets, cabinet reading/sorting and whiteboard inspection. A fully occupied office preserves the action label with a prop-free waiting gesture. The Pi ZIP includes an optional, varied example map separate from active mappings. The integration guide lists all primary actions and scene alternatives; the dashboard documentation card presents four consistent navigation links.

- Configurable offline session retention triggered by an accepted office heartbeat, including unmarked legacy sessions. Dashboard → Agents shows presence and lets Owners delete offline sessions. Dedicated credentials survive roster cleanup. Removing the last session revokes its General or Trusted connector; revoking a connector removes all its sessions.
- Pi avatars use folder names. The 3D footer shows the selected harness and activity next to the navigation hint. The tool trolley serves as a second workshop station. When both workshop stations are occupied, a tool user can type at a spare laptop without changing the reported action or taking priority over desk work. The Agents inspector groups session, activity and timing fields, with one summary for an empty workload. Row actions stay on one line, and deletion uses the same confirmation dialog as Workspace Access.

- Published the [v1 action catalogue](public/schemas/action-v1.json) and [REST sender guide](public/guides/integrations.html#actions). Connectors can report semantic actions without panel changes; unknown IDs with valid syntax display as Other Activity. Actionless clients keep their previous routing. The optional Pi extension supports local, source-specific JSON overrides without changing connection settings.

- The public Integrations guide includes reader navigation, inline request/response examples with matching JSON downloads, and a copyable, credential-free handoff for other engines. The primary Pi download is a folder ZIP with `index.ts`, editable `actions.json` and offline schemas. The single-file download remains available for compatibility; both downloads use `no-store`. Pi keeps visit proofs in process memory; simultaneous visitors may share a folder name without sharing an identity.
- Workspace Access uses in-page confirmation dialogs and a refresh banner. Its Overview entry fills
  the card width; expanded roster details have an accessible close icon.

- Owners can manage machine admission, join-key rotation, trusted connector issuance and individual
  revocation from Overview → Office Access → Workspace Access without changing human or share access.
- Fresh-install workspace admission and session API for Node and Bun: Owner-managed Open/Closed
  policy, join-key rotation, trusted and general producers, isolated writers, durable sequences,
  reconnect and producer revocation. Fresh registrations report only unless granted inbox access.

### Changed

- Moved the lounge plant alongside the sofa. Avatars now water it from the front, keeping the aisle to the coffee machine clear.
- Start Demo now shows Pi Agent, Hermes, Codex, OpenClaw, Mercury, Claude, Gemini and Antigravity when eight agents are selected. These are synthetic demo labels, not new connectors or affiliations. Older panel-owned demo rows remain eligible for cleanup.
- Reworked the GitHub README around first-time setup, with a synthetic office screenshot, a Mermaid data-flow diagram, Bun/Node and executable instructions, and a breakdown of scene actions, weather, privacy and task storage.
- Added a non-root Dockerfile and a loopback-only Docker Compose service with a readiness check and no mounts by default. The deployment guide distinguishes restarting a container from replacing it and losing its SQLite state.

- All engines share a small default vocabulary for actionless tool reports. Explicit actions or room hints take precedence; unknown tools no longer imply workshop work. The simulator and CLI demo now send actions. Pi reports linked single asynchronous subagent runs and safe, read-only confirmation metadata without exporting tasks, choices or answers.
- Pi visits display `Pi Session · <folder basename>`. A same-writer renewal refreshes a changed visit label without changing the project or ID. Agents details show reported activity instead of Host, and the office connection status pairs a colored dot with text.
- Seated avatars now keep their seated leg pose during No Signal instead of straightening their legs through the chair. Reconnecting resumes activity; going offline still triggers departure.
- A reported `compact_context` action sends the avatar to a free filing cabinet to sort books. Sorting starts on arrival, respects reduced motion and stops on the next activity or idle report. Pi reports the start and outcome without sending context contents.

- Panel Demo Tools clears its temporary agents and related data on stop or startup. Real workers keep their identities across offline periods. API request logs expose method, route template, status and latency without logging credentials or payloads.
- The Pi command, extension and settings now use `agent-mini-office`. Failed HTTP requests retry automatically (default three retries; delay = retry number × five seconds), with operation and retry status shown in Pi.
- Owners can reveal/copy the reusable office key even while Closed. Close pauses enrollment only;
  rotate explicitly replaces the key. Private agent credentials remain separate. The Pi sample now
  stores only `enabled`, `panelUrl`, `token` and `maxRetries` in one root-level `agent-mini-office.json`. `/agent-mini-office`
  controls reporting, panel URL and token. Enrollment resolves the office from the key. Project
  labels follow Pi session renames, falling back to the working folder without changing agent IDs.
- Edit/write prefer laptop desks, with standing writing spots after a short wait. Idle visitors rotate local stops and occasionally look at the whiteboard or rest in a vacant meeting room. Main lights now cover the corners, with neutral daylight and warm nights. A fire extinguisher and bin occupy the left wall instead of a separate light. Office and room names use outlined off-white floor lettering.
- The Pi connector distinguishes core, extension and SDK registrations. File lookup prefers a cabinet; known optional planning and screenshot tools use the board and output station. Long tool and editing calls use in-place gestures and occasional compatible station visits. The workbench and tool cart sit farther from the corner plant. A confirmed final Pi text response can briefly send an idle avatar to a free printer or handset without transmitting response text or delaying real work. The left filing cabinet sits nearer the telephone, with a plant in the freed corner.
- Simulated weather now uses weighted 5–15 minute periods with persistent wind, a forecast of the
  next actual change, and occasional outdoor bird silhouettes on sunny days (hidden in reduced motion).
- Some simulated rain periods now have occasional silent lightning outside the back windows.
  Reduced motion hides lightning; there is no full-screen flash or change to agent activity.
- Three researchers can use separate document stations; a second cabinet also handles printer
  overflow. Arrived workers animate board strokes, book pages and printer paper, while standby
  daemons can make coffee, take water or watch fish without claiming work.
- Overcast clouds now use a generated opacity mask instead of sampling color from a translucent
  canvas texture, to mitigate repeated colored speckles reported after refreshing in rain or snow.
- New and renamed offices accept up to 32 characters; existing names and URLs are unchanged.
  The Owner's inline rename editor shows the limit. Overview groups the agent roster with Office Access
  and pairs Integrations with Demo Tools on wide screens. Agent names, kinds and actions share aligned
  columns. View Details expands below the selected row in Overview and Agents; Locate in Office locks
  that identity in the office. Demo Tools keeps the chosen count
  and disclosure state across start/stop. The lost/leaked token notice now spans the credential card.
- Avatar badges use matching status colors for the name dot and action label: error red, human-wait
  amber, ordinary work teal and quiet/inactive gray, without changing the reported activity.

- The 3D entrance displays the office name. Its Owner can use **Rename Office** on Overview without
  changing the URL, share links or worker credentials. Avatar names now have screen-sized badges;
  selected workers, human waits and reported errors can show a separate activity badge.

- The 3D office varies prolonged stationary poses: standing workers waiting for a human can hop or
  stamp in place, while seated workers and ongoing tasks use quieter gestures. These cosmetic motions
  respect reduced motion and never change the reported status.

- Control Room Overview now prioritizes Open Office, actual registration/queue totals, agent navigation
  and a compact Office Access card. Demo Tools is a disclosure, not the main onboarding action.
- Agent Skill becomes Integrations: one-time credential location, missing rotation/revocation controls,
  REST versus extension/plugin versus skill responsibilities, lifecycle/reliability, task inbox flow,
  troubleshooting and explicit human-interaction limits. Removed the nonexistent metadata PUT endpoint.
- Existing `admin` displays as Operator in Title Case; stored roles and backend permissions are unchanged.
  Viewer UI omits write controls. Agent Credentials replaces the ambiguous Active Tokens metric.
- Share creation now requires an exposure acknowledgement and offers 1/7/30-day expiry, defaulting to
  7 days. It remains the existing full-information read-only share flow, not guest redaction or revocation.
- One-time registration credentials are displayed before list refresh, so a failed refresh cannot hide
  the only copy. The empty agent table can now populate after successful registration, and IDs stay visible.

### Added

- Explicit daemon/session lifecycle declarations through registration and the admin CLI, conservative
  unspecified behavior, and labelled daemon-only ambient standby without a schema migration.
- Six-agent default demo (five to eight selectable) with independently seeded starts and phase durations,
  mixed lifecycles and early export/printer activity; all telemetry uses the actual API.
- Auto/Locked agent following, visual-column Project Activity, centered statistics and responsive
  four-column desktop Board 2D.
- Camera-facing human-waiting gestures in the meeting room, subagent calls and webhooks at the phone
  booth, and HTTP/fetch desk requests. Desk/held telephone models now include recognizable handsets.
- Stable feminine, masculine and androgynous avatar presentations with varied hair/outfits; visual
  choices do not infer real gender. Attention labels receive collision-aware placement.
- Corner archive interaction, aquarium, water cooler, coffee machine, thin matte whiteboard, frosted
  dividers, transparent window openings, illustrative monitors/TV and brighter night interiors.
- Bounded illustrative Clear/Sunny, Cloudy, Rain and Snow with wind, variable 5–12 minute periods,
  smooth transitions, exterior precipitation and wet-glass accents using the existing render loop.
- Minimal committed event signals over office-isolated SSE, validated same-office parent-run metadata,
  bounded real child-run avatars and relationship cues. A global connector/session identity proposal
  is documented separately; no new authentication mode is shipped.
- Facing desk pairs with low partitions, close seated typing poses, separate activity labels and
  simple station props/gestures. Library reading props stop on intent changes instead of persisting
  while the agent walks elsewhere.
- Project Activity in both office views, showing all snapshot projects by open-task priority and
  signal recency, independently of selected-agent details. Completed tasks no longer affect that order.
- Local-time office environment with sunrise/sunset colours, a visible sun, moon, stars and cloud shapes.
  Night reduces ambient light while warm office lamps and visible fixtures brighten. UI theme remains
  independent of time of day; sky elements add no separate animation loop or external assets.
- Shared scene layout/navigation model with fixed furniture, obstacle-aware routes, stable interaction
  slots, waiting positions, articulated seated poses and deterministic avatar palettes/accessories.
- Focused navigation, mood/weather, project-ordering, telemetry/lifecycle and demo regressions;
  scene documentation records integrated browser evidence and remaining limitations.

### Fixed

- Avatars give one another clearance in transit and keep a lounge cushion reserved until its occupant exits. Child runs can use spare desks, and sustained tool work can visit the free library or printer without changing the reported action.
- Active Runs keeps the Subagent badge beside its age and wraps the parent name on a separate line in both agent detail views.
- Walking routes now avoid chair footprints and use reserved side-entry/exit segments for seating,
  including interrupted docking. Seats remain reserved until departing actors clear them.
- Waiting-for-human poses choose standing or one of two view-facing window seats once per episode.
  Seated bodies no longer rotate backward independently of their chairs; unsuitable views fall back
  to standing. Ending a gesture on error does not invent a new journey.
- Board 2D removes the misleading Barber card, adds truthful Standby grouping, uses Title Case titles,
  and separates action/task text into non-overlapping rows.
- Office counters are compact and integrated into the content header, freeing vertical space without
  changing navigation or counter sources.
- Project cards show real named-agent actions and the latest event, not just a representative task.
  Routine heartbeats no longer appear as new project activity; project names/counts remain data-driven.
- Weather now surrounds the full office scene rather than appearing only behind the windows: near-camera
  rain/snow, four-sided exterior volumes, soft distant clouds, scene fog and overcast lighting. The
  cutaway interior stays dry and readable; existing pause/reduced-motion/resource budgets are retained.
- Demo restart no longer reuses sequences from before an unflushed heartbeat; obsolete failed ticks
  cannot stop a newer demo generation.
- Transaction rollback and duplicate replay no longer leak event side effects. Run starts cannot reuse
  existing IDs; child events preserve the owning main run/station. Unscoped SSE publications fail closed.
- Latest snapshot signals preserve accepted insertion order when batch timestamps tie instead of
  choosing by random UUID suffix. Renewed idle heartbeats carry enough sequence state for the UI.
- An empty child-overflow notice no longer renders literal `null`; attention poses and label placement
  were adjusted after screenshot inspection.
- Content-only heartbeat changes now publish task/activity over SSE instead of waiting for a presence
  state change. Successful task ack/fail endpoints notify connected office views; rejected finishes do not.
- Scene updates no longer discard task/activity changes when the agent stays in the same room/state.
- Switching to Board 2D pauses rendering, including when a pending lazy load completes afterward.
- Lobby transitions respect the room debounce; monitor occupancy follows deferred seat changes.
  Avatar neck geometry is shared rather than retained per removed avatar.

### Added

- Demo Agents card in the dashboard with Start and Stop, backed by `POST` and `DELETE`
  `/api/v1/offices/:slug/demo`. The driver runs in process and calls the real HTTP endpoints, so a demo
  exercises validation, presence, runs, and the event log instead of writing state directly. Simulated
  agents are flagged in the database and labelled in the office.
- Theme toggle now shows the mode you would switch to (moon and Dark, or sun and Light) and is re-rendered
  on every change.
- Office appbar no longer links to itself: it shows a single `Back to Control Room` button, and only for a
  signed in member. Share link visitors do not get a link that leads nowhere.
- Brand mark is a robot icon in a tinted tile instead of a plain coloured square.

- Interface rebuilt on a real standard, documented in `docs/UI.md`: design tokens for colour, space,
  radius, type, and motion; components with hover, focus-visible, active, busy, and disabled states;
  light and dark themes from the same tokens.
- Copy casing rules: Title Case for labels (headings, tabs, buttons, table headers, stat labels, field
  labels), sentence case for prose (descriptions, hints, empty states, toasts). Uppercase is now only a
  CSS treatment on stat labels, never typed by hand.
- Hand written inline SVG icons, coloured through `currentColor`, used on tabs, buttons, stat tiles,
  room headers, empty states, and toasts. No icon font, no CDN.
- Sidebar replaced with a single top appbar: three destinations never justified 248px of empty column.
- Content fills the viewport: the page is a flex column with the footer pinned to the bottom, the office
  layout grows into the remaining height, and the detail panel stretches with it.
- Responsive work at 1100px, 760px, and 560px: two column grids collapse, the appbar wraps, tabs scroll,
  tables scroll inside their card, and nothing overflows horizontally.
- `new Function(source)` guard in the tests. A syntax error in the client shipped once because tests only
  read the file as text.

- First run setup. A database with no accounts sends `/dashboard` to a setup form that creates the first
  administrator and their office, then signs them in. `POST /api/v1/setup` returns `403` once any member
  exists, so it cannot mint a second admin.
- `GET /api/v1/config` reports `needs_setup`, which is what the dashboard uses to choose between the
  setup form, the login form, and the control room.
- Documented portability: the whole instance is one SQLite file. Delete `data/minioffice.db` and restart
  to get a clean instance and the setup form again.

- Login, roles, and server side sessions. Passwords use scrypt from `node:crypto`, no dependency. The
  session cookie is httpOnly and SameSite=Lax, and the database stores only its hash. Owner, admin, and
  viewer roles are enforced on write endpoints.
- Self registration, off by default. Turning it on lets a visitor create their own office from
  `/dashboard`; leaving it off means an operator creates accounts with `admin office:add`.
- Control room at `/dashboard`: sign in, see your office and its agents, register an agent and receive
  its token once with a ready made `curl` snippet, issue a read only share link, and sign out.
- `/<slug>` office routing. Read access is one of: the slug is public, the visitor has a share link for
  that office, or a member of that office is signed in. The stream follows the same rule.
- `admin office:add` creates an office plus its owner account in one step.

- `GET /api/v1/stream`, server sent events replacing the two second poll. Frames: `snapshot`,
  `presence`, `run`, `task`, `counters`, plus a comment ping every 15 seconds and a full snapshot resync
  every 60. Frames are filtered per organization, and events that land between the first snapshot and
  the subscription are buffered and flushed, so nothing is lost in that window.
- `src/lib/live.ts` broadcast bus, and a snapshot builder shared by `/snapshot` and the stream so the two
  can never disagree.
- The panel keeps its first paint from `/snapshot`, which gives a clean 401 path, then follows SSE.
  Presence patches in place, `run` and `task` frames trigger a debounced re-read.

- Task inbox: `GET /inbox`, `claim` with a 60 second lease, `ack`, and `fail`. Only the run holding the
  lease can finish a task, a live lease cannot be stolen, and an expired lease returns the task to
  pending on a sweeper instead of letting a dead agent own it forever. At most five pending tasks per
  agent.
- `task.claimed`, `task.acked`, and `task.expired` are recorded as server origin events, so the timeline
  explains why a task changed hands.
- Panel shows tasks per agent with status pills and a live lease countdown. Snapshot carries up to eight
  recent tasks per agent.
- Admin CLI gained `task:add` and `task:list`. Demo driver now opens a run, claims a task, holds it for
  five seconds, acks it, and refills the backlog, so the whole loop is visible.

- v0 collector server: Hono app served by Bun and Node from one entrypoint, with `GET /health`,
  `POST /api/v1/agents/:id/heartbeat`, `POST /api/v1/agents/:id/events`, `GET /api/v1/snapshot`, and
  `GET /api/v1/rooms`.
- Presence is derived server side from heartbeat timestamps with an `online` / `stale` / `offline` TTL,
  and flushed to SQLite every five seconds instead of on every request.
- Room reducer with a closed vocabulary, a server side tool to room table, and two second hysteresis
  resolved by a sweeper so a single event still lands.
- Event batches are idempotent on client generated `event_id`, enforce a monotonic per agent `seq`,
  and reject prompt or output content before it ever reaches the database.
- Dual runtime with zero native dependencies. `src/lib/db.ts` adapts `bun:sqlite` and `node:sqlite`
  behind a five method interface, and a test fails if a runtime specific API leaks outside the adapter
  files.
- Admin CLI: `init`, `agent:add`, `share:add`, `list`. There is no web login in v0, so agent tokens
  and read only share links are issued here.
- v0 panel: a two dimensional room grid, agent detail, and live counters, served from `public/` with a
  hand rolled static handler over `node:fs`. No bundler, no framework, no external asset. The UI builds
  text nodes only, never `innerHTML`, so an agent supplied task label cannot inject markup.
- `bun run demo`: a synthetic driver that creates three simulated agents and drives them through the
  real HTTP API, so the demo exercises ingest, presence derivation, the room reducer, and the sweeper
  instead of writing state directly. It prints a ready to open panel URL.
- `docs/CONTRACT.md`, the v1 REST contract, and `docs/SCHEMA.sql`, the SQLite schema with UUIDv7
  primary keys, 13 tables, and 37 indexes.
- 58 tests under `bun test`, plus a Node smoke test that boots the app on `node:sqlite`.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`.

### Added

- Toasts moved to the top right under the appbar, with per variant colour and icon (success, danger,
  warning, info) and a shrinking strip that shows how long the message will stay.
- Right rail of the office is now an accordion listing every agent, ordered by activity: online first,
  then most recent signal. The old panel always showed whichever agent sorted first, which made the rail
  look stale.
- Provenance: the snapshot carries each agent's latest event, and the panel renders `Room from
  tool.call (bash) · 12s ago`. Presence is labelled `Reporting`, `No signal`, `Offline`, or
  `Never reported` instead of a bare colour.
- Deterministic identity colour per agent, derived from its id, shown as an initials tile. Same agent,
  same colour, on every device.
- Login throttling: after five failed attempts each further try from the same address and email waits
  longer, from one second doubling to a five minute cap, answered as `429` with `Retry-After`.

### Added

- Colour system: `ocean`, `plum`, and `caution` join the palette, each mapped to one meaning. Card heads
  carry a tinted icon tile, rooms are tinted by family with an accent border only when occupied, and
  destructive actions use the clay tone.
- Stop Demo is now a danger button, and the demo card only shows an accent border while it is running.
- Identity tiles on every agent in the office rail, coloured deterministically from the agent id.

### Added

- Task board in the dashboard: `GET/POST /offices/:slug/tasks`, plus `cancel` and `assign`. The panel
  shows Todo, Doing, and Done with the lease countdown on claimed cards, and polls while open.
- The panel never finishes a task. Only the run holding the lease can ack or fail, so the board cannot
  claim work an agent never did.
- The in process demo driver now claims and acks its own inbox, so the board shows the real lease cycle
  instead of a column that never moves.

### Added

- Office 3D view with a Board 2D / Office 3D toggle, remembered per browser. The 2D board is kept as the
  light option and the fallback when WebGL is unavailable.
- Procedure geometry only: one rug per room, a desk, chair, monitor and character per agent, a soft foot
  shadow, a label sprite per room. Drag to orbit, scroll to zoom, click an agent to select it in the rail.
- Colours come from the same CSS tokens, so the scene follows the light and dark themes. Reduced motion
  disables the bobbing. The scene rebuilds only when an agent's room or state actually changes.
- three.js 0.187.0 pinned through an import map, loaded lazily, with `bun run vendor:three` as the offline
  escape hatch.

### Fixed

- The demo driver could not recover after a restart: it started its sequence at 1 while the agent's `seq`
  is monotonic, so every event came back `invalid_seq`. It now continues from `agent_presence.last_seq` or
  the highest stored event sequence.
- Rejected events were invisible. An event rejected by validation still answers `200` with a `rejected`
  array, so checking only the status hid a demo that was doing nothing. The driver now reads the body.
- Demo runs no longer inflate the active token count: the previous demo token is revoked when a new one is
  issued.
- The room reducer could never change a room. The sweeper ran at the flush cadence of five seconds
  while hysteresis was two, so a pending room was always replaced before it could land. Sweeping is now
  a separate 500ms timer, and hysteresis means "minimum time between visible changes" rather than "the
  proposal must stay stable", so the avatar tracks the newest intent instead of the first one.
- Agent names in the panel were truncated to `demo-co...` because the demo badge shared a row with the
  name. The badge moved to the second row. No test caught this, a rendered screenshot did.

### Notes

- The schema enforces closed vocabularies at the database level. Adding a room or event type is
  therefore a migration, which is intentional.
- `PRAGMA foreign_keys` is per connection. Documented in the schema and in `CONTRIBUTING.md` because
  forgetting it produces silent orphans.
