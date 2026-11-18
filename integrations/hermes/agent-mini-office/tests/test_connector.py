#!/usr/bin/env python3
"""Verify the official AgentMiniOffice Hermes plugin against a disposable office."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]


class State:
    def __init__(self):
        self.sessions = []
        self.heartbeats = []
        self.attempts = []
        self.accepted = []
        self.fail_first = True
        self.lock = threading.Lock()


def handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def _send(self, code, payload):
            raw = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if not self.headers.get("Authorization", "").startswith("Bearer amo_"):
                self._send(401, {"error": "unauthorized"})
                return
            if self.path == "/api/v1/machine/sessions":
                with state.lock:
                    state.sessions.append(json.loads(body))
                self._send(
                    201,
                    {
                        "agent_id": "019e0000-0000-7000-8000-000000000001",
                        "generation": 1,
                        "expires_at": (
                            datetime.now(timezone.utc) + timedelta(minutes=15)
                        ).isoformat().replace("+00:00", "Z"),
                        "last_seq": 0,
                        "inbox": False,
                    },
                )
                return
            if self.path.endswith("/heartbeat"):
                with state.lock:
                    state.heartbeats.append(json.loads(body))
                self._send(200, {"seq": json.loads(body)["seq"]})
                return
            if self.path.endswith("/events"):
                with state.lock:
                    state.attempts.append(body)
                    fail = state.fail_first
                    state.fail_first = False
                    if not fail:
                        state.accepted.extend(json.loads(body)["events"])
                if fail:
                    self._send(503, {"error": "transient"})
                else:
                    self._send(
                        200,
                        {
                            "accepted": len(json.loads(body)["events"]),
                            "duplicate": 0,
                            "rejected": [],
                            "next_seq_hint": 99,
                        },
                    )
                return
            self._send(404, {"error": "not found"})

    return Handler


def main() -> int:
    state = State()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with tempfile.TemporaryDirectory(prefix="amo-official-") as tmp:
        os.environ["HERMES_HOME"] = tmp
        config_dir = Path(tmp) / "plugin-data" / "agent-mini-office"
        config_dir.mkdir(parents=True)
        config = config_dir / "config.json"
        config.write_text(
            json.dumps(
                {
                    "panel_url": f"http://127.0.0.1:{server.server_port}",
                    "token": "amo_producer_" + ("B" * 43),
                }
            )
        )
        os.chmod(config, 0o600)

        name = "amo_official"
        spec = importlib.util.spec_from_file_location(
            name,
            PLUGIN_DIR / "__init__.py",
            submodule_search_locations=[str(PLUGIN_DIR)],
        )
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)

        class Ctx:
            def __init__(self):
                self.hooks = {}

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def session_surface(self):
                return "cli"

            def session_cwd(self):
                return "/tmp/amo-project"

            def inject_message(self, *args, **kwargs):
                return False

        ctx = Ctx()
        module.register(ctx)

        def call(hook, **kwargs):
            ctx.hooks[hook](**kwargs)

        call(
            "on_session_start",
            session_id="session-1",
            model="test",
            platform="cli",
        )
        call(
            "pre_llm_call",
            session_id="session-1",
            turn_id="turn-1",
            user_message="private prompt",
        )
        call(
            "pre_tool_call",
            session_id="session-1",
            turn_id="turn-1",
            tool_name="read_file",
            args={"path": "/home/private/secret"},
        )
        call(
            "post_tool_call",
            session_id="session-1",
            turn_id="turn-1",
            tool_name="read_file",
            args={"path": "/home/private/secret"},
            result="private result",
            status="success",
        )
        call(
            "post_llm_call",
            session_id="session-1",
            turn_id="turn-1",
            user_message="private prompt",
            assistant_response="private answer",
        )
        call(
            "on_session_end",
            session_id="session-1",
            turn_id="turn-1",
            completed=True,
            failed=False,
            interrupted=False,
            turn_exit_reason="text_response(finish_reason=stop)",
        )
        time.sleep(0.8)
        call("on_session_finalize", session_id="session-1")
        time.sleep(0.2)

        server.shutdown()
        server.server_close()

        assert len(state.sessions) == 1, "expected one visit"
        assert state.heartbeats, "expected a heartbeat"
        assert len(state.attempts) >= 2, "expected an event retry"
        assert state.attempts[0] == state.attempts[1], "event retry must be exact"
        assert any(
            event.get("type") == "tool.call"
            and event.get("data", {}).get("action") == "read"
            for event in state.accepted
        ), "expected accepted read action"
        assert all("tool_source" not in event["data"] for event in state.accepted)
        joined = b"\n".join(state.attempts)
        assert b"/home/private" not in joined and b"private result" not in joined
        assert b"private prompt" not in joined and b"private answer" not in joined

        print("visit=1")
        print(f"heartbeats={len(state.heartbeats)}")
        print(f"accepted_events={len(state.accepted)}")
        print(f"event_attempts={len(state.attempts)}")
        print("exact_retry=ok")
        print("tool_source=omitted")
        print("private_payload=absent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
