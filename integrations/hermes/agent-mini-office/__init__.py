"""A passive Hermes plugin. Only a granted, addressable session can receive an inbox task."""

import atexit
import logging
import re
import threading
from pathlib import Path

from .panel import Panel, config, mappings
from .visit import Visit

HOOKS = (
    "on_session_open",
    "on_session_start",
    "on_session_reset",
    "on_session_finalize",
    "pre_llm_call",
    "post_llm_call",
    "on_session_end",
    "pre_tool_call",
    "post_tool_call",
    "on_human_input_request",
    "on_human_input_resolved",
    "subagent_start",
    "subagent_stop",
    "post_compaction",
)


def keyed_host(ctx):
    # Host routing checks classic CLI first (ignores the key), then the unscoped TUI queue.
    # Only the LOCAL gateway FIFO checks profile ownership and admits a distinct turn.
    manager = getattr(ctx, "_manager", None)
    return (
        manager is not None
        and getattr(manager, "_cli_ref", True) is None
        and not getattr(manager, "has_tui_message_injector", True)
        and getattr(manager, "has_gateway_message_injector", False)
        and getattr(ctx, "_gateway_injection_allowed", lambda: False)() is True
    )


def local_target(key, sid):
    parts = key.split(":")
    return (
        key
        if (
            len(parts) == 5
            and parts[0] == "agent"
            and parts[1]
            and parts[2:4] == ["local", "dm"]
            and parts[4] == sid
            and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", sid)
        )
        else None
    )


def target(ctx, sid, surface):
    if not keyed_host(ctx) or surface not in ("cli", "tui", "desktop"):
        return None
    # A version-pinned optional capability. Never read a process-global default route.
    try:
        from gateway.session_context import bound_session_key
    except ImportError:
        return None
    return local_target(bound_session_key(), sid)


class Connector:
    def __init__(self, ctx, origin, token, interval):
        self.ctx, self.origin, self.token = ctx, origin, token
        self.interval = interval
        self.rules = mappings()
        self.closed = False
        self.lock = threading.RLock()
        self.visits = {}

    def handle(self, hook, kw):
        child = hook in ("subagent_start", "subagent_stop")
        sid = kw.get("parent_session_id") if child else kw.get("session_id")
        if not sid or not child and kw.get("parent_session_id"):
            return
        with self.lock:
            if self.closed:
                return
            if hook in ("on_session_open", "on_session_start", "pre_llm_call") and any(
                sid in v.children for v in self.visits.values()
            ):
                return  # a known delegated child is a linked run, never a second inbox visit
            if hook == "post_compaction" and kw.get("old_session_id") not in (
                None,
                "",
                sid,
            ):
                previous = self.visits.pop(kw["old_session_id"], None)
                if previous:
                    previous.stop()
            if hook in ("on_session_reset", "on_session_finalize"):
                old = self.visits.pop(kw.get("old_session_id") or sid, None)
                if old:
                    old.stop()
                return
            visit = self.visits.get(sid)
            if hook in ("on_session_open", "on_session_start", "pre_llm_call"):
                surface = getattr(self.ctx, "session_surface", lambda: "")()
                # on_session_open binds the route, but some Hermes versions only pass
                # the client surface as a hook argument until the first turn.
                key = target(self.ctx, sid, surface or kw.get("platform"))
                cwd = getattr(self.ctx, "session_cwd", lambda: "")() if surface else ""
                folder = Path(cwd or "").name.strip()[:60]
                if visit is None:

                    def inject(prompt, **kwargs):
                        if not keyed_host(self.ctx):
                            return False
                        return self.ctx.inject_message(prompt, **kwargs)

                    visit = self.visits[sid] = Visit(
                        Panel(self.origin, self.token, folder or "Workspace"),
                        key,
                        inject,
                        self.interval,
                    )
                else:
                    with visit.lock:
                        visit.key = key
                        if folder and folder != visit.panel.folder:
                            visit.panel.folder = folder
                            visit.wake.set()
            if visit:
                with visit.lock:
                    if not visit.closed:
                        visit.observe(hook, kw, self.rules)

    def close(self):
        with self.lock:
            self.closed = True
            for visit in self.visits.values():
                visit.stop()
            self.visits.clear()


def bind(ctx, connector):
    def callback(hook):
        def observe(**kw):
            try:
                if connector is not None:
                    connector.handle(hook, kw)
            except Exception as error:
                # On Hermes a thrown pre_tool_call callback would veto the user's tool.
                # Stop office pickup on lost ordering; never print hook values or affect approvals.
                if connector is not None:
                    connector.close()
                logging.getLogger(__name__).warning(
                    "Office observer disabled (%s).", type(error).__name__
                )
            # pre_llm_call and pre_tool_call must never return a directive.

        return observe

    for hook in HOOKS:
        ctx.register_hook(hook, callback(hook))
    if connector and hasattr(ctx, "on_unload"):
        ctx.on_unload(connector.close)
    return connector


def install(ctx, origin, token, *, interval=15):
    connector = Connector(ctx, origin, token, interval)
    return bind(ctx, connector)


def register(ctx):
    from plugins.plugin_storage import plugin_data_dir

    try:
        origin, token = config(plugin_data_dir("agent-mini-office") / "config.json")
        connector = install(ctx, origin, token)
    except FileNotFoundError:
        bind(ctx, None)
        return
    except (OSError, ValueError, KeyError, TypeError):
        logging.getLogger(__name__).warning(
            "Office disabled: check the private config and packaged action map."
        )
        return
    if not hasattr(ctx, "on_unload"):
        atexit.register(connector.close)
