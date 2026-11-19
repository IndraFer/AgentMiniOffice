# AgentMiniOffice for Hermes Agent

A Hermes lifecycle plugin. Start with a private test office. No model key, transcript capture, shell wrapper or Python dependency is required by the connector. Do not install the old reference plugin alongside this one.

## Install in one trusted profile

1. Extract the Hermes ZIP into `$HERMES_HOME/plugins/` (default `~/.hermes/plugins/`). The result must be `plugins/agent-mini-office/plugin.yaml`, alongside `__init__.py` and the JSON files. From source, copy this whole directory instead.
2. Create `$HERMES_HOME/plugin-data/agent-mini-office/` with mode `0700`. Create `config.json` there with mode `0600`, owned by your OS account. Copy the two required fields from `config.example.json`; insert the real credential in a private editor, not in chat or shell history. The URL must be an HTTPS origin (HTTP on loopback is accepted). The optional `name` field sets a stable visit label; the optional `project` field sets the project label shown in the office. Set both for a folderless daemon, for example `"name": "Hermes Ops", "project": "Homelab"`. Without `name`, a session visit uses the working folder basename or `Workspace` (a daemon visit displays `Hermes`); without `project`, no project label is sent. Without a readable valid private config the plugin is inert.
3. Run `hermes plugins enable agent-mini-office` in that profile, then start a new session. Check Dashboard → Agents for the configured labels and harness `hermes`. These labels are shared by sessions using this config; they are not inferred from chat titles and do not identify or route a visit. Choose labels suitable for office viewers. The plugin does not send the full working path or native session ID.
4. A general join key needs Open admission for enrollment. A Trusted credential also works with admission Closed. Restart the host after changing config or `actions.json`. To stop reporting, disable the plugin and restart that host. This does not retire the office's producer credential.

For editor validation, associate `config.schema.json` with the private `config.json`; only `panel_url` and `token` are required.

## One avatar per messaging daemon

For a Telegram bot, merge `"identity_mode": "daemon"` into the existing private config and restart that Hermes gateway. Keep `panel_url` and `token`. For example, bot A can use `"name": "Hermes A", "project": "Homelab"` and bot B `"name": "Hermes B", "project": "Homelab"`. Use a **separate persistent Hermes profile/data directory per bot**, including separate mounts for containers. Do not share or clone the private state. The default, `session`, keeps the interactive behavior described below.

On the first admitted gateway message, the in-process `post_gateway_admission` hook starts a single heartbeat writer. Short-lived workers from all channels in that profile send only sanitized observations through a bounded local SQLite queue. Turns, chat IDs, channels and project labels never select the avatar. Concurrent turns contribute to the same working/waiting status; tool and final-response observations are not represented as independent session runs. Daemon mode never polls the inbox or chooses a chat for task injection. A worker without the gateway hook cannot start a writer.

`plugin-data/agent-mini-office/daemon-state/` is owner-only and contains resume credentials: **do not publish, sync between bots, or edit it**. Use a local POSIX filesystem supporting SQLite and `flock`. Stopping the gateway stops heartbeats. After restart and the first admitted message, the writer resumes the same visit if the collector still retains it. A removed/expired-by-retention visit, revoked credential or changed origin/token needs deliberate reconfiguration: stop the old processes, provision a valid credential if necessary, and move the old state aside securely before creating a new identity. No old avatars are merged or deleted.

## Activity mapping

`actions.json` maps exact registered tool names to a public action and optional compatible variant. Its editor schema `actions.schema.json` is generated from the panel's `action-v1.json`; the plugin checks the action/variant pairing on load. Example: `"web_search": {"action":"search_web","variant":"laptop_typing"}`. An unknown tool reports `other`, not its name or arguments. Add installed tools explicitly. Hermes tool hooks do not establish a tool's source; no source is invented.

Session/turn hooks report presence and runs, pre/post tool calls report observed tool activity, and a successful response hook can show Final Response. Paired human-input hooks display waiting/resumed, never questions, answers or approvals. Child hooks link observed first-level delegation to a live parent run; no child goal or summary is sent. Post-compaction reports only a committed compaction, not a guessed start or duration. No prompts, chat text, error details or tool results are sent to telemetry. Gateway messages, shell commands, background schedules and installed capabilities are not themselves evidence that a tool or task ran.

## Assigned tasks: Trusted Inbox

An Owner must issue a **Trusted + Inbox** credential. A join key, telemetry-only Trusted credential, or collector omitting `inbox: true` cannot enable pickup. There is no plugin task-mode switch. In Hermes enable `plugins.entries.agent-mini-office.allow_gateway_injection: true` only for a profile where the panel is trusted to send work to the configured model. Normal Hermes approval rules still apply.

For example, merge this into the profile's `config.yaml` (keep the token in the separate private JSON file):

```yaml
plugins:
  entries:
    agent-mini-office:
      allow_gateway_injection: true
```

The connector polls for **its own** tasks only when it has a specific local session target and no observed turn, child or human wait. It starts a run, claims the task, submits the title/brief as a user turn once, and renews the lease while awaiting the outcome. A completion requires the exact submitted prompt, a matching successful response ending on `PANEL-TASK-DONE <task-id>`, and successful finalization of that turn. Aborts, unrelated turns and missing receipts do not count. Only fixed status text goes back, never the response. A receipt is Hermes reporting completion, not independent proof that the work was correct. If the host exits abruptly, renewal stops and the lease can expire.

**Host limits:** telemetry and task delivery are separate capabilities. Automatic delivery requires an **in-process plugin on the LOCAL gateway**, a context-bound `agent:<profile>:local:dm:<session-id>` route matching the observed turn, and host injection permission. CLI, TUI and Desktop clients can use this path when attached to that gateway. The standalone classic CLI REPL ignores the target key; the legacy TUI injector can merge queued prompts. Both remain telemetry-only, as do messaging chats, ACP, isolated plugin hosts and unknown routes. Never configure or guess a route. Hermes accepting a queued message is not a delivery receipt. On hosts that provide route context only during a turn, start a normal turn first. The plugin does not emulate missing host hooks or bypass host consent. Hermes' validator flags the optional `gateway.session_context.bound_session_key` import as an internal API. This is deliberate: it reads only the current hook's route, never a process-wide fallback. If it is unavailable, automatic delivery stays off. Use a current Hermes version with the [documented lifecycle hooks](https://github.com/NousResearch/hermes-agent/blob/31ce88f86e6cf4a66ef6aa315e4657a31bcf9915/website/docs/user-guide/features/hooks.md) and [session injection contract](https://github.com/NousResearch/hermes-agent/blob/31ce88f86e6cf4a66ef6aa315e4657a31bcf9915/hermes_cli/plugins_injection.py).
