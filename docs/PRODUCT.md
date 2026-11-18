# Product direction

This file pins the shape of the product so the code has something to be wrong against. It describes
what you install and what you click, not internal design. Internal design lives in `docs/CONTRACT.md`.

## One install, many offices

Kantor is a single long running service. Start it with `bun run start` or `node`, optionally as a
container. It listens on one port and serves three things:

| URL | What it is | Who may open it |
|---|---|---|
| `/dashboard` | control room: login, your office, agent tokens | any member, after login |
| `/<slug>` | the office view for one office | a member of that office, or a valid share link, or anyone if the slug is listed as public |
| `/api/v1/*` | REST contract for agents and clients | depends on the credential |

There is no per-office process and no per-office port. One service, one port, offices separated by slug.

## The default office

A fresh install ships with one office that anyone can watch without logging in, at `/open`. That is the
"single open office" case: you want to glance at your agents without administrating anything.

The slug is configurable. `MINIOFFICE_PUBLIC_SLUGS=open,lobby` makes both public. An empty list means
every office requires a credential. Public means read only, never write.

## First run

A fresh database has no accounts, so `/dashboard` shows a setup form: name, email, password, office
name. Submitting it creates the first administrator and their office, then signs them in. That endpoint
closes permanently once any account exists, so it cannot be used to add a second admin.

There is no separate migration step and no seed script. Deleting `data/minioffice.db` and restarting
returns the instance to exactly this state, which makes "start over" a one line operation.

## A user's own office

A member owns exactly one office in this version. Flow:

1. Open `/dashboard`.
2. Log in, or create an account if the instance allows it.
3. The dashboard shows your office, its agents, and a panel link.
4. Create an agent, receive its token exactly once, copy the ready made `curl` snippet into the agent.
5. Open `/<your-slug>` to watch it work.

Everything an agent can do still goes through the same REST contract. The dashboard is a convenience
over it, never a second protocol.

## Roles

Three, deliberately small, mirroring the roles already in the schema:

| Role | May |
|---|---|
| `owner` | everything in their office: create agents, revoke tokens, create tasks, issue share links |
| `admin` | same as owner except deleting the office |
| `viewer` | read the office and its tasks, nothing else |

Invites and multiple members per office are modelled in the schema but not wired into the UI yet.

## Agents

An agent is registered by a human, never by itself. Registration yields an agent id and a token shown
once. The token is scoped to that agent: it can send telemetry and read its own inbox, and it can never
open the dashboard or read another agent.

The agent side is a skill, not a protocol adaptation. The skill explains how to map a harness (pi hook,
hermes loop, codex wrapper, plain cron) onto the contract, and ships with the endpoint URL and token
placeholders. The panel never grows harness specific branches.

## Two views of the same office

`/<slug>` offers a toggle, remembered per browser:

- **Board 2D** is the lightest view: a room grid with chips. It works without WebGL, on a slow
  connection, and in any browser.
- **Office 3D** draws the same state as a floor plan: one rug per room, a desk per agent, a character
  whose shirt colour is the agent's identity hue. Drag to orbit, scroll to zoom, click an agent to open
  its details in the rail.

The panel on the right is identical in both views, and both are fed by the same snapshot and stream. The
2D board stays because it is faster and because a 3D canvas is not always available.

## Demo

The dashboard has a Demo Agents card with Start and Stop. Starting it creates simulated agents and drives
them through the real HTTP API, so presence, the room reducer, runs, and the event log all take the same
path as a real agent. They are flagged with `simulator = 1` in the database and labelled `Demo` in the
office, so a demo never contaminates a real fleet. Stopping it leaves them to go stale in 30 seconds and
offline in 90, which is the TTL doing its job.

`bun run demo` remains for a terminal driven demo without the dashboard.

## What is built, and what is next

| Piece | State |
|---|---|
| REST contract, schema, dual runtime | done |
| Presence, rooms, events, task inbox with lease | done |
| Read only panel and live SSE stream | done |
| Login, sessions, roles | done |
| First run setup on a fresh database | done |
| `/dashboard`: your office, agents, tokens | done |
| `/<slug>` routing with public and private access | done |
| Share link management UI | next |
| Task creation from the panel (kanban) | done: board with create, cancel, reassign |
| 3D office scene | done: toggle Board 2D / Office 3D |
| Invites, multiple members per office | later |
| Multiple offices per user | later, needs a `users` table split |

## Known limitation, written down on purpose

One member owns one office, because a login is keyed by email and each email exists once. Supporting
several offices per person properly needs a `users` table separate from office membership, which is a
migration rather than a feature. Until then, inviting somebody means giving them their own account.
