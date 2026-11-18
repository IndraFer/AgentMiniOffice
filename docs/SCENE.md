# Office scene

The office is a read-only visualization of reported telemetry. Animation never claims, acknowledges,
or fails a task. Board 2D remains available when WebGL or the pinned Three.js module cannot load.
This is a bounded visualization, not a physical simulation or a production-performance certification.

## Implementation

- `public/office-model.js`: fixed layout, collision footprints, slots, A* navigation, actor reconciliation,
  ID-derived appearance, ambient scheduling and local-time mood.
- `public/office-activity.js`: truthful activity labels, event cues, project ordering and real child-run
  projections. A spawn notification alone never invents a child identity.
- `public/office-weather.js`: deterministic illustrative weather schedules and a separately owned,
  bounded exterior layer. Uses the scene's render loop, not a new timer or network service.
- `public/scene3d.js`: articulated avatars, procedural furniture, camera, lighting, labels and graphics
  resource ownership. Repeated static meshes are instanced; animated furniture is excluded.
- `public/app.js`: REST/SSE consumption, Auto/Locked selection and view lifecycle.

## Floor plan and navigation

One fixed 20 × 14 unit cutaway floor, without slug-based mirroring. Furniture does not regenerate on
heartbeats, theme or weather changes. Collision and rendering share layout coordinates.

| Area | Objects and capacity |
|---|---|
| Workspace | Three facing desk pairs, close seats, outward-facing monitors, low translucent dividers and stable accessory variations |
| Meeting | Frosted partitions, west doorway, table, four seats, six standing attention positions and illustrative TV |
| Lounge | Two sofa seats, coffee counter/machine, water cooler, coffee table and aquarium |
| Reference | Bookshelf, thin matte whiteboard and two archive cabinets. The cabinet beside the printer can also stage output. |
| Tools/output | Workshop, printer and recognizable charcoal desk telephone with keypad and curved handset |
| Intern | One desk/seat; overflow goes to waiting positions |
| Entrance | Eight waiting positions; legacy barber/away locations use this area |

The archive footprint includes its open-door approach. A 0.25-unit A* grid and exact segment/expanded-
rectangle checks use a 0.27-unit clearance envelope. There is no teleport or straight-line fallback
through blocked furniture. All eleven desk/meeting/intern chairs are transit obstacles, including their
backs. A reserved chair has a specific open-side approach point: only its short seat-entry/exit segment
can cross its own footprint, never another chair. Interrupted entry exits through that same approach;
the departing chair stays reserved until the actor clears it. Sofa cushions remain docking surfaces
with solid arms/back. This is controlled docking, not permission to walk through chairs in transit.

Reservations survive reordered snapshots and are released on removal. Ordinary room intent is reflected
in labels immediately, but must persist for three seconds before a new trip begins. Short bursts therefore
avoid repeated cross-office journeys. Real work cancels ambient intent immediately. Movement is capped
at 2.4 units/second and simulation timesteps at 0.1 seconds. Errors, presence and task results are not
held back for animation.

This is not crowd avoidance: passing avatars can overlap, and populations exceeding all available
waiting positions are not represented well. Offline/stale avatars freeze rather than performing work.

## Identity, lifecycle and actions

Appearance is deterministic per ID. Feminine, masculine and androgynous visual presentations select
from seven hair silhouettes and four outfit styles, independently of role or harness. These are art
choices, not an inferred gender identity. Appearance remains stable through updates and refreshes;
random selection does not guarantee every small group contains every presentation.

Session open accepts an explicit `daemon` or `session` lifecycle, stored in existing capabilities.
Missing declarations remain `unspecified`; Pi/Codex/etc. are never used to guess lifecycle. An online visitor with a later explicit idle heartbeat, no active run, claimed task, human wait or latest error qualifies
for `Standby · Ambient`. Standby may use lounge/drink props and occasional bounded aquarium, plant or
archive visits. These are labelled ambient, not invented work. Stale visitors do not perform ambient activity. A previously visible visitor can walk to the door on departure; an initially offline visitor has no avatar.

All connectors can use the same [semantic action catalogue](../public/schemas/action-v1.json). The sender reports what happened; the panel chooses an available station. `lookup_file` prefers the cabinet; `search_content` prefers the bookshelf. Unknown valid IDs use **Other Activity**: a neutral interaction chosen from the available board-view, plant and aquarium stops, not evidence of printing, calling or planning. The collector resolves [common tool defaults](CONTRACT.md#81-deterministic-mapping) for actionless, roomless tool events from any engine. The scene consumes that result without reinterpreting tool names.

| Reported intent | Visualization |
|---|---|
| `compact_context` | Wait for a free filing cabinet, open it after arrival and repeatedly lift and align a book. Reduced motion shows a static pose. A newer signal, explicit idle or loss of online presence ends sorting. It does not summarize or change the underlying session. |
| Edit/write | Laptop desk; typing and monitor effects only after seating. If all desks are reserved for three seconds, use a free standing writing spot by the printer or library with a tablet, then move to a released laptop desk. This does not operate the printer. |
| HTTP/fetch | Desk `Web Request`; no claim that a particular document was fetched |
| Read/research/search | Library book, or archive output/reference paper when that slot is used |
| Export/render/generate | Printer/output area and paper after arrival; not a real print-device operation |
| `human.waiting` | Meeting room; stable per-episode seated/standing choice and raised-hand wave after arrival |
| `human.resumed` | Desk intent; waiting gesture stops immediately |
| `spawn.started` | Phone booth and handset after arrival; no fabricated child |
| `spawn.finished` | Desk intent; handset is removed immediately |
| Webhook/notifications | Phone booth communication metaphor |
| Error | Reported-error expression, without inventing recovery or moving the agent |
| Planning | Planning gesture/bulb, not a claim that a solution was found |

Waiting-pose variation is seeded from the agent and first waiting signal, once per uninterrupted waiting
episode. Heartbeats and repeated waiting notifications do not reroll it. Seated attention is restricted
to the two window-side seats facing the view; other choices use reserved standing positions. Occupied
seats fall back to standing. A seated avatar retains its chair/body orientation and only turns its head
within a bounded range. If the view no longer faces its attention seat, it safely undocks to standing
and does not chase the camera between seats. An error ends the gesture without inventing a new trip.
Normal coordination may still use all four meeting seats; the table was not rotated.

After 10–16 seconds of the same eligible action at a station, a short cosmetic gesture can layer onto
its base pose. A sustained `tool.start` at the bench alternates reaching and adjusting gestures; an ongoing edit/write at a laptop alternates mouse and screen-scan gestures. The tool cart is a second workshop station: if the bench is occupied, another worker can use the free cart on arrival, including under reduced motion. If both workshop stations are taken, a worker reporting `use_tools` can borrow a spare laptop. Once seated, the avatar types while its activity stays **Using Tools**. It yields to desk work, returns to a free workshop station without a new event, and waits if no compatible station is available. A lone workshop user may also visit the free cart after 10–16 seconds settled on an ongoing tool call. The optional writing trip to a free whiteboard still requires 50–65 seconds and yields to planners. After about 12 seconds there, the avatar seeks an available regular station. These trips keep the reported action, emit no events and are disabled under reduced motion. Completion ends the variation. A standing worker waiting for a human may hop, stamp one foot twice, or tilt its head;
seated attention uses only a nod or head tilt. Desk/tool work can lean or nod, reading/output/planning
can glance or lean, and communication/coordination can nod or tilt. An ID-based offset and 9–15 second
interval keep avatars from moving in unison. Only the visible scene clock advances the schedule, not
heartbeat age. Moving, changing task/action, reduced motion or losing eligibility clears the accent.
The floor position, chair reservation, held prop and reported status are unaffected. A foot stamp is
not an error or escalation, and a long task is not reported as idle.

Content readers prefer the bookshelf; file-name searches and directory listings prefer an available cabinet. The left cabinet stands beside the telephone with a plant in its former corner. Three simultaneous researchers can use the bookshelf and both cabinets. Output prefers the printer,
then the shared document cabinet; both uses reserve the same physical slot. Overflow waits and can
advance when a station frees without another event from the waiting worker. An explicit idle report
releases the old work intent even if the last room stays unchanged. A worker already using a suitable
alternative does not chase a newly vacant station. Human attention retains its separate meeting rules.

A newly observed `final_response` action followed by idle can briefly show **Final Response** at the printer or telephone. The avatar alternates when both are free and skips the trip when neither is available. `final_print` and `final_call` request only the named prop; there is no substitution if it is occupied. The paper or handset appears only on arrival. The Board and reported presence remain idle; new work takes priority. An initial snapshot does not replay an old response, and reduced motion skips the trip.

After arrival, a reader turns a page, a planner writes illustrative strokes that clear when the
station is no longer in use, and an occupied printer feeds a sheet without reporting task completion.
Cabinets open independently. Between lounge stops, idle visitors prefer the least recently visited available coffee, water, aquarium or plant stop. One in five trips tries a farther destination: look at the board without writing, or rest in an empty meeting room. The resting visitor yields when someone needs the meeting room. Coffee/water pours and other object motions are
cosmetic and hold a static pose under reduced motion.

A fire extinguisher and waste bin sit between the workshop and phone booth; neither is an activity station. Five overhead lights at a common height cover the main workspace: four perimeter lights over the whiteboard, printer/meeting approach, left filing cabinet and exit desk near the aquarium, plus one centered over the desk cluster. They blend from neutral daylight to warm light at night. The meeting room has a separate light. In the lounge, a warm light beneath the floor lamp’s shade lights the nearby furniture; its intensity tracks the shade’s glow, not the workspace lights. The office name and room names use off-white floor lettering with a fine gray outline.

Props require arrival at the corresponding station and disappear on incompatible intent or loss of
online presence. Reduced motion holds attention poses still and disables limb/fish/weather oscillation;
necessary path movement remains. Gestures and phone details are necessarily small at whole-office zoom.
Name badges use dark text on a light background. The dot and activity badge reflect the same
reported state: red for an online error, amber with dark text for human attention, teal for ordinary
work and gray for inactive or quiet states. Offline/stale presence takes precedence over an old
signal. Color supplements the text; neither color nor pose creates an interaction request. Their text stays the same
screen size through resize and zoom. A separate activity badge appears for selection, Waiting for
Human or a reported error; it never implies that the office can accept a response. Selection and
attention get first placement, and crowded labels may be suppressed rather than overlap. The
accessible agent rail remains the authoritative detail view. The entrance floor sign uses the office
display name from the snapshot, not the product name or URL slug.

Committed events publish minimal office-scoped `signal` frames. Run ownership and parent joins are
validated. Same-agent child events do not move the parent's avatar. Active same-office linked runs may
have temporary avatars; a separately registered child-only agent is reused rather than duplicated.
At most six temporary child avatars are drawn, with hidden counts under their owners. The collector
limits active child runs to 32 per owner. Relationship lines appear only while visible related actors
are actually seated together. Compaction inference is not implemented.

## UI and demo

The agent rail follows priority/recency in Auto mode. Manual agent/avatar/project selection locks the
choice; selecting it again or using Resume Auto releases the lock. A disappearing selection returns
Auto. Project Activity includes every snapshot project and sits below the visual column, independently
of rail height. It sorts by highest pending/claimed task priority, then recent activity; finished tasks
do not increase priority. Recency uses recorded events, run starts and task creation, not routine
heartbeat timestamps. Each real project shows up to three named agents with current telemetry-derived
actions, a remaining-agent count, and its newest reported event independently of the priority-selected
representative. Names/counts come from agent project metadata; the demo's three project names are not a
UI limit. This is the visible snapshot window, not a complete backlog or event history.

Board 2D retains twelve Title Case cards in four desktop columns and responsive two/one-column layouts:
Lobby, Standby, Desk Work, Planning, Research, Tool Work, Output & Export, Calls & Notifications, Meeting
Room, Break Area, Subagent Desk, and Inactive / Away. Legacy onboarding/Barber maps to Lobby without
changing the backend vocabulary. Standby requires the same eligibility as the 3D projection; stale and
offline agents are not shown as active workers. Name, action and optional task context occupy separate
chip rows. Long task context may ellipsize; the selected-agent panel retains the full text.

Online, Active Runs and Pending Tasks are compact counters within the office content header alongside
the title and view switch. They wrap on narrow screens without changing the top navigation or counter
sources. The scene caption explicitly identifies the selected agent.

The built-in demo defaults to six agents, with five through eight selectable. Each persona has a
reproducible independent timing sequence: staggered starts, 21–39 second work phases and 18–36 second
idle phases. A shared 1.5-second transport tick does not synchronize activity transitions. Output/export
appears early for relevant personas; other agents can work, travel or idle at the same time. All events
and heartbeats go through the real API. Restart preserves issued sequences even before SQLite presence
flushes. The demo stops on rejected telemetry rather than silently pretending it succeeded. Stopping
an emitter does not force presence offline; normal stale/offline TTLs still apply. The separate legacy
`bun run demo` CLI remains a three-agent transport exerciser; use the Control Room for this visual demo.

## Time and illustrative weather

Local browser time drives dawn, morning, afternoon, sunset and night, independently of UI theme.
Warm indoor lighting remains readable at night while the exterior stays dark. This is stylized lighting,
not astronomy, geolocation or live weather.

Each office path has a deterministic, weighted weather schedule. Long-run time targets are 30% Clear,
25% Cloudy, 20% Rain, 10% Thunderstorm and 15% Snow. A shuffled 200-period circuit preserves the
transition counts even between blocks. Rows are the current condition; columns are the next period.

| From / to | Clear | Cloudy | Rain | Thunderstorm | Snow |
|---|---:|---:|---:|---:|---:|
| Clear | 70% | 30% | 0% | 0% | 0% |
| Cloudy | 36% | 14% | 20% | 0% | 30% |
| Rain | 0% | 25% | 40% | 35% | 0% |
| Thunderstorm | 0% | 0% | 70% | 30% | 0% |
| Snow | 0% | 50% | 0% | 0% | 50% |

Periods last 5–15 minutes and may hold the same condition. Transitions blend over ten seconds.
The wind keeps its left/right direction on 80% of period boundaries. The **Simulated Forecast** card
under the time badge shows the next **different** condition, time until it starts, and its wind
direction; it reads the same schedule as the renderer, including after a reload. Clear is labelled
Sunny only in local daylight. During Sunny periods 2–4 small bird silhouettes occasionally cross
outside the back windows. They disappear at night, in other weather or with reduced motion.

Some rain periods become thunderstorms. A small, silent bolt fades in and out beyond the back
windows, first after 15 seconds and then roughly once a minute. It never changes the room lighting
or flashes the screen. Reduced motion hides the bolt entirely while preserving the rain and label.

Weather fills the surrounding world, not a backdrop confined to windows. Four exterior volumes span
X −14…34, Z −14…28 and Y 0…20, including space in front of the camera as it orbits. The entire vertical
column above the office footprint remains dry, so the cutaway view does not make rain fall indoors.
512 rain streaks or 256 snow particles share depth testing with the office; foreground precipitation
may cross its projected silhouette without occupying the interior. Wind drives drift and slanted rain.

The full sky, cool overcast fill light and restrained scene fog share the same weather state. Warm
practical lamps preserve indoor readability. Soft distant clouds use 18 camera-facing instances in
one draw, not solid blobs floating over desks. Transparent window panes retain reflection accents
and 27 rain streaks. The existing capped RAF drives everything; hidden/2D pauses rendering and reduced
motion freezes weather movement. No new timer, network request or agent behavior is introduced.
First-use graphics allocation is bounded; repeated weather cycles reuse the same resources.

## Lifecycle, verification and limits

- Lazy pinned Three.js, orthographic fit, orbit/zoom/reset, accessible list-based selection.
- Render submission cap 30 FPS and DPR cap 1.5, not a guaranteed framerate or low CPU use.
- Hidden/2D stops rendering; resume does not accumulate hidden-time movement. Late imports respect
  the selected view. Disposal releases the exterior layer, scene resources and event listeners.
- Targeted tests cover navigation, activity/lifecycle, appearance, weather boundaries, API/SSE delivery,
  transaction rollback, isolation, child relationships and independent demo scheduling.
- A bounded owned-browser run exercised real task and event APIs, phone/waiting/output interactions,
  child creation/removal, 6→8 demo restart, independent movement, ambient, all weather modes, local-time
  changes, reduced-motion waiting, resource churn, mobile fit and CDN failure fallback. It reported no
  page errors and cleaned up its Chrome, server, demo timers and temporary profile.
- The earlier integrated fixture used about 593 draw calls for six actors and 705–718 for eight. After
  replacing window-only weather with surrounding atmosphere, a focused six-actor browser fixture used
  585 calls, 36 geometries and 25 textures; resources stayed stable across weather cycles. Actor IDs,
  appearance and poses vary between fixtures, so these are not controlled performance comparisons or
  device CPU/FPS benchmarks.
- The atmosphere correction was separately checked in the actual browser: clear/cloudy/rain/snow,
  orbit, day/night, dry interior geometry, reduced-motion particles, pause/resume and mobile fit. Final
  screenshots were inspected after replacing distracting cloud blobs; no page errors were reported.
- An independent backend reviewer timed out without a usable final report. Targeted verification and
  self-review are not a substitute for a completed independent security/reliability review.
- The chair/pose browser fixture exercised six-agent seat entry/exit and mixed waiting poses with 875
  per-frame navigation samples and no invalid segment. Normal bounded orbit was checked; the defensive
  rear-view fallback used a test-only camera hook, not a newly enabled 360-degree camera.
- Follow-up checks verified non-overlapping Board chips, compact header desktop/mobile layout, and a
  fourth project registered through the API appearing in the existing page after heartbeat/events.
  Real waiting/error/resume events changed project content; heartbeats did not replace the latest event.
  These scoped checks reuse earlier results; they are not a claim of a new full-suite or backend audit.
- The scene consumes the [visit and action contracts](CONTRACT.md#machine-admission-and-sessions-implemented); it does not infer compaction from a quiet session or change heartbeat expiry for slow workers.
