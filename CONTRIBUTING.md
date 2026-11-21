# Contributing

AgentMiniOffice is meant to stay small. The fastest way to make it useless is to let it grow into a worse
Grafana. Keep that in mind when proposing features.

## Ground rules

1. **The panel stays agent-agnostic.** No harness-specific branch in server code. Integration lives in
   `src/shims/`, one small adapter per harness, and every adapter talks the same REST contract.
2. **Metadata only.** Never store prompts, file contents, command output, or credentials. A pull
   request that widens this is a security change, not a feature.
3. **No invented data.** The UI may only display numbers and states that exist in the database. If a
   value is simulated, it must be labelled in the UI. This rule is not negotiable.
4. **Written here, not pasted here.** Every file in this repository is written for this repository.
   Ideas and visual direction can be taken from anywhere, code cannot be dropped in. Reuse means
   understanding a technique and reimplementing it against this project's own API and data model. A
   pull request that pastes a file from another project will be asked to rewrite it.
5. **Contract first.** Behaviour changes update `docs/CONTRACT.md` in the same pull request. A schema
   change updates `docs/SCHEMA.sql` and includes a migration note.
6. **English in public docs, any language in private notes.** Public artifacts are English so the
   project travels. Internal notes are not part of this repository.

## Development

Two supported runtimes: **Node 24** (22.5+ works with an experimental warning) and **Bun 1.4+**.
TypeScript, no build step, no bundler, no framework.

```bash
bun install
bun run dev          # Bun
bun run dev:node     # Node via tsx
bun test             # canonical test runner
bunx tsc --noEmit    # typecheck
bunx biome check src/ # lint and format
```

`bun.lock` is the only lockfile. `bun install` produces a `node_modules` tree that Node also uses through
`tsx`, so there is no second dependency tree and no separate install path.

SQLite comes from the runtime itself, `bun:sqlite` or `node:sqlite`, never a native package. `bun install`
never compiles anything, and there is no node-gyp step on any platform.

Tests use `bun test`, make no paid API calls, and must not require network access for the collector.

## Database changes

Apply the schema locally with:

```bash
sqlite3 data/minioffice.db < docs/SCHEMA.sql
```

`PRAGMA foreign_keys` is per connection, not stored in the database file. Every process that opens the
database must set it, and every test must run `PRAGMA foreign_key_check` afterwards. Deleting rows
without it leaves orphans and the cascade only looks broken.

## Visual changes

The office is the reason this project exists, so visuals are not decoration and visual regressions
count as bugs. When changing the scene:

- Check the frame rate with four agents in different rooms, not one.
- Check that an `offline` agent has an empty desk. Do not leave a ghost avatar.
- Check that an `error` state does not move the avatar. It changes local lighting only.
- Add a screenshot to the pull request.

## Versioning and releases

Use SemVer for the application (`package.json`) and independently for the Hermes package (`integrations/hermes/agent-mini-office/plugin.yaml`). Use the third number (`X.Y.Z` → `X.Y.Z+1`, for example `0.3.1` → `0.3.2`) for each independently completed fix or small user-visible refinement, including layout, labels, and scaling. Commit the change, its `package.json` bump, and a dated changelog entry together. Do not batch distinct completed refinements under one version or bump for every intermediate edit. New backward-compatible capabilities increment minor. Before 1.0, use a minor increment for breaking changes and document the migration. From 1.0 onward, breaking changes require a major increment. The REST path (`/api/v1`) and SQLite migration number are compatibility identifiers, not application versions.

Keep changes awaiting a version under **Unreleased** in `CHANGELOG.md`. Use a prerelease only for an explicitly planned prerelease, not instead of a completed patch. A versioned local commit does not authorize a tag, push, or deployment. Independently, rebuild a changed connector ZIP from its manifest and sources. For an approved application release, set the final version, move its changes under a dated changelog heading, verify the artifacts, and tag that commit `vX.Y.Z`. For a separately published Hermes release use `hermes-vX.Y.Z`. Do not invent historical tags or publish a tag merely for a development commit. `/health`, `/api/v1/config`, the startup log and the dashboard footer use the application's package version.

## Commit scope

Commit working increments. Do not commit `data/`, `.env`, database files, or anything from the local
knowledge base.

## Reporting bugs

Include the contract version, the agent kind, and the exact request that misbehaved. If the payload
contains anything sensitive, redact it. Do not paste real tokens.
