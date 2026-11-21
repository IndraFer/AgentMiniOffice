# Interface standard

The panel is plain HTML, CSS, and JavaScript with no framework, so the rules below are the only thing
keeping it coherent. They are short on purpose. If something here is not followed, the interface drifts
back into ad hoc styling.

## 1. Casing

Two kinds of text, never mixed.

**Labels use Title Case.** Anything a person scans or acts on: page headings, card headings, tab and nav
labels, button labels, table column headers, stat labels, badges, field labels.

**Sentences use sentence case.** Anything a person reads: descriptions, hints, empty states, toast
messages, notices, error messages. End them with a period.

Uppercase is a visual treatment, not a casing rule. Stat labels and panel section labels are written in
Title Case in the source and uppercased by CSS, so the text stays consistent even if the styling changes.

| Kind | Correct | Wrong |
|---|---|---|
| Card heading | `Office Access` | `Office access`, `OFFICE ACCESS` |
| Button | `Create Read-Only Link` | `Create read-only link` |
| Tab | `Integrations` | `integrations` |
| Field label | `Office Name` | `Office name` |
| Description | `Open the office, or hand somebody a read-only view.` | `Open The Office, Or Hand Somebody A Read-Only View.` |
| Toast | `Read-only link created.` | `Read Only Link Created` |

Marketing copy is prose. The sign in headline stays a sentence, because it is read rather than scanned.

Compound adjectives are hyphenated when they sit before a noun: read-only link, self-hosted panel,
server-side session, title case label.

## 2. Tokens

Every value comes from a token in `:root`. No raw hex, no magic spacing, no bespoke radii.

| Group | Tokens |
|---|---|
| Surface | `--bg`, `--surface`, `--surface-2`, `--surface-3` |
| Line | `--border`, `--border-strong` |
| Text | `--text`, `--text-2`, `--muted` |
| Meaning | `--accent`, `--ok`, `--warn`, `--info`, `--ocean`, `--plum`, `--caution`, each with a `-soft` variant |
| Space | `--s1` to `--s8`, a 4px based scale |
| Radius | `--r-sm`, `--r-md`, `--r-lg`, `--r-full` |
| Type | `--fs-xs` to `--fs-2xl` |
| Motion | `--t-fast`, `--t-med`, `--ease` |

Dark mode is a second token set under `[data-theme="dark"]`. Nothing else changes: components read tokens
and therefore work in both.

## 3. Components and states

Each primitive owns its states. A component without hover, focus-visible, active, and disabled is
unfinished.

| Component | States | Notes |
|---|---|---|
| `.btn` | primary, quiet, ghost, danger, small, block, busy | `:focus-visible` ring from the accent token |
| `.input` | hover, focus, disabled, invalid placeholder | Focus uses a ring, never an outline reset |
| `.card` | static | One shadow level; heading plus optional description |
| `.badge` | neutral, accent, ok, info, demo | Demo marks simulated agents, never real ones |
| `.stat` | static | Icon tile plus label and number |
| `.tab` | default, hover, current | Current state uses a border, not a colour block |
| `.toast` | ok, error, info | Announced by `role="status"`, auto dismisses, manual close |
| `.list`, `.table` | hover row | Long values truncate, they never push the layout |
| `.empty` | static | Icon plus one sentence |

Icons are inline SVG from `ICONS` in `app.js`, stroked with `currentColor`. There is no icon font and no
CDN. Colour comes from the surrounding text or from an `icon-*` class.

The brand mark is the robot icon in an accent-soft tile, never a bare coloured square.

Toasts sit top right, under the appbar, never bottom right. Each variant carries its own colour and
icon: success uses the accent, danger the warn tone, warning the caution tone, info the info tone. A thin
strip along the bottom of the toast shrinks over its lifetime, so the reader knows how long it will stay.
Message survives that wait only as text; nothing scrolls away.

The theme toggle always shows the mode you would switch to: a moon and `Dark` while light, a sun and
`Light` while dark. It is re-rendered on every theme change, because a stale moon in dark mode is worse
than no icon at all.

An appbar never links to the page you are already on. The office view replaces its navigation with a
single `Back to Control Room` button, and that button only exists for a signed in member. A share link
visitor has no account, so offering it would lead nowhere.

## 4. Layout

- One top appbar, one page column. A sidebar is only worth its space when there are many destinations;
  with three, it is waste.
- The page is a flex column with `flex: 1`, so the footer sits at the bottom instead of leaving a hanging
  void.
- General content grids use intrinsic minimum widths. Board 2D intentionally uses four desktop
  columns, then two/one columns at narrower sizes. Its twelve Title Case cards use telemetry/lifecycle
  projections: legacy Barber becomes Lobby/Onboarding and eligible idle daemons have Standby.
- Board chips give names, action labels and task context separate grid rows. Action labels wrap rather
  than overlap or truncate; long task context can ellipsize because the detail panel contains it in full.
- Office counters belong to the content header beside the office title and view switch, not a separate
  statistics strip or the global navigation. Keep icons/numbers compact, labels in Title Case, and let
  the group wrap intrinsically on narrow screens. Dashboard counter styling remains independent.
- Project Activity uses actual project metadata, never a fixed list of demo names. Show bounded named
  agent actions and the latest received event; heartbeat freshness must not masquerade as new activity.
- The visual column and agent rail have independent heights. Project Activity sits below the visual
  column, not above the whole office or under the rail. Statistics are centered.
- Below 760px the appbar wraps, tabs scroll horizontally, and cards go full width. Nothing may overflow
  horizontally.

## 5. Colour carries meaning

The palette is small on purpose. A colour is only added when it maps to something a reader can name.

| Colour | Means | Where |
|---|---|---|
| accent (sage) | primary action, working | primary buttons, current tab, workspace rooms |
| ocean | reference, information | knowledge rooms, information stats |
| plum | coordination, people | meeting and phone rooms, agent lists |
| caution (amber) | waiting, capacity | pending tasks, intern and pantry rooms |
| clay (warn) | danger, stopped, failure | stop and destructive buttons, offline rooms |
| identity hue | this specific agent | initials tile, derived from the agent id |

Rules that keep it from turning into confetti:

1. One tone per component. A card gets one icon tone and, at most, one accent border.
2. Backgrounds stay neutral. Colour lives in icons, thin borders, and small tiles.
3. A tone is applied through a `tone-*` class that sets `--tone` and `--tone-soft`. Components read
   those two variables, so no component hardcodes a hue.
4. Destructive actions always use the clay tone, never the primary accent.
5. An empty or inactive state is muted. Only a state with something to say gets colour.

The office is meant to look alive; the dashboard is the control room for it. They share the palette so they
do not look like two different products.

## 6. Provenance and identity

The office never shows a state without a reason behind it.

- Every agent carries a **signal**: the latest event the server received, with its type and age. The
  detail panel renders it as `Room from tool.call (bash) · 12s ago`.
- Presence is a label, not a colour alone: `Reporting`, `No signal`, `Offline`, `Never reported`.
- Every agent has a **deterministic colour** derived from its id, shown as an initials tile. The same
  agent keeps the same colour on every device. The 3D avatar also has a stable ID-derived appearance;
  its clothing palette is currently separate from the initials tile palette.

## 7. The 3D view

- **Optional, never the only way to read the office.** Office 3D is the first-visit preference;
  Board 2D remains selectable and is the fallback when WebGL or Three.js cannot load.
- **Lazy.** The scene module is imported only for the 3D view; the dashboard does not load Three.js.
- **Separate time and theme.** Controls follow UI tokens. Office materials use their own art palette;
  sunrise, daylight and night follow browser-local time, not the light/dark theme toggle.
- **Procedural assets.** Geometry and canvas textures are generated locally. A decorative CSS sky and
  bounded exterior weather layer share the scene loop. Weather is labelled Simulated, not a forecast;
  glass openings show the exterior and limited rain streaks without indoor precipitation.
- **Reduced motion.** Limb/typing/fish/weather oscillation stops; human attention holds a raised-hand
  pose and necessary path movement still communicates location.
- **Stable environment.** Furniture is built once. Actor and text reconciliation includes content-only
  telemetry, rather than filtering updates by room and state alone.
- **Explicit lifecycle.** Board 2D and hidden tabs pause rendering. Disposal releases observers,
  listeners, graphics resources and sky elements. Actual device performance still needs measurement.

See [Office scene](SCENE.md) for the implemented layout, environment, verification and remaining limits.
Project Activity lists all projects independently of selection, using open-task priority then signal
recency within the current snapshot. The bottom scene caption is labelled `Selected:`. Auto follows the
prioritized/recent agent; manual agent/avatar/project selection locks it. Clicking that agent again or
Resume Auto releases the lock. A missing selection also returns Auto. A project card never filters the
other projects. Avatar presentation varies while remaining stable per ID; it is not a gender claim.

The Control Room offers an explicit daemon/session lifecycle (omission remains unspecified), plus a
five-to-eight-agent demo selector with six as default. See [Integration identity](INTEGRATION-IDENTITY.md)
for the session model. Owners open **Overview → Office Access → Workspace Access** to manage machine
admission. Rotating the join key stops new enrollments with the old key; revoking one connector
denies future reports from its writers. Trusted connectors start telemetry-only unless the Owner
explicitly grants assigned-task inbox access. The Current Mode label stays left of a right-aligned button group. View Office Key lets the Owner reveal/copy the same enrollment key in either mode. Private connector credentials are still revealed only once. Neither is saved by the browser UI.
The Agents registration form remains separate and creates a dedicated reporting agent.

### Control Room and integrations

- Navigation is Overview, Agents, Tasks and **Integrations**. Narrow layouts wrap tabs rather than
  clipping the new destination. Dashboard-specific CSS does not restyle the accepted office scene.
- Overview makes **Open Office** primary, with Register Agent and Refresh as secondary controls.
  Registered Agents, Pending Tasks and Agent Credentials are registration/queue totals, not live
  presence or LLM usage. Refresh failure preserves the previous overview.
- On wide screens the roster and Office Access sit side by side; Integration and Demo Tools share a
  second row. On narrow screens the cards reflow. Name, kind and action have aligned table columns.
  The Owner's rename editor sits inside Office Access, with the field and Save Name on one line and
  the 32-character limit visible. Existing longer names are not truncated in storage.
- **View Details** expands immediately below its triggering row in Overview and Agents, not at the
  end of the list. It reads a timestamped office snapshot for the requested
  identity, including lifecycle, presence, active runs and recent tasks. **Locate in Office** locks
  the office view to that agent; a missing identity is reported rather than silently substituted.
- Demo Tools starts collapsed unless the demo is running. During the dashboard visit, disclosure
  state and the chosen count survive start, stop and navigation. Changing the count does not start a demo.
- The lost/leaked token notice uses a short message across the available card width without a
  narrower nested text column. It explains what to do after exposure without offering fake controls.
- Human roles display as **Owner**, **Operator**, **Viewer**. Operator maps to stored `admin` without
  changing permissions. Viewers retain read navigation, but do not see credential issuance, demo,
  task creation/cancellation or share-creation controls. Server checks remain authoritative.
- **Share Office** includes an Owner-only Public View switch and an explanation of anonymous read access. When enabled, a short office URL and Copy link replace the private link form. Disabling it stops public-only live streams without revoking private links.
- **Embed 3D Office** is its own disclosure beside Share Office and appears only while Public View is on,
  so the snippet can be opened without expanding the sharing chapter. The snippet carries no token or
  query string. `/embed/<slug>` sends `frame-ancestors *` by default, which also overrides an
  `X-Frame-Options` header added by a reverse proxy; set `MINIOFFICE_EMBED_FRAME_ANCESTORS` to limit
  the allowed parent sites. Non-embed pages keep `frame-ancestors 'self'`.
- Private link creation is an explicit disclosure with a label, 1/7/30-day expiry (7 by default), and required
  acknowledgement that office information is visible to anyone holding the link. A rejected request
  keeps the form available. Success shows the link once and its server-returned expiry; the creation
  form is then hidden. This does not add private link listing/revocation or guest redaction.
- Agent registration shows the one-time token **before** refreshing the list. A refresh failure must
  not discard it. Agent IDs remain visible in the table; raw tokens are not persisted in browser storage.
- The Owner's full-width Workspace Access entry opens compact, independently sized cards. Changes with irreversible effects use a modal with Cancel focused and Escape to cancel. Manual refresh announces the result in an inline status banner. Expanded roster details use an X with an accessible name.
- Sign-in and Integrations link to the same [public developer guide](../public/guides/integrations.html), a static page with no office API calls. It includes machine header/body examples, recovery rules and a downloadable Pi telemetry sample.
- Integrations distinguishes REST adapters, harness extensions/plugins and optional Markdown skills.
  It documents credential scope/storage and missing rotation/revocation, session/daemon identity,
  heartbeat timing, event reliability, optional leased inbox execution, and troubleshooting. A sample
  sequence of 1 is explicitly a first-connection example, not a repeatable health check.
- Waiting for Human remains agent-reported telemetry, not a dashboard chat or approve/reject channel.
  Responses happen in the original harness. The guide also provides the schema-based Hermes plugin. Other connector packages, member management, configurable
  worker capacity and multi-office membership are not presented as available features.
- Setup/reference chapters use native keyboard-operable disclosures. Credentials and long text wrap;
  tables keep their own horizontal scroll rather than widening the page.

## 8. Accessibility

- Every interactive element is reachable and shows `:focus-visible`.
- Icons that carry meaning have an accessible name on their control; decorative icons are `aria-hidden`.
- Toasts live in a `role="status"` region.
- Colour is never the only signal: state has a dot plus a label.
- `prefers-reduced-motion` suppresses nonessential character motion and UI transitions; necessary
  movement remains visible.
- Form fields always have a visible label. Placeholders are examples, not labels.

## 9. Rules of the road

1. If a value is not in a token, add the token first.
2. If a component needs a one-off style, it probably needs a variant. Add the variant.
3. No inline styles. Use the utility classes (`.row`, `.stack`, `.spread`, `.mt-3`, `.field-grow`).
4. Every new string belongs to exactly one casing category.
5. Visual changes get a screenshot in the pull request. Tests keep behaviour, eyes keep legibility.
