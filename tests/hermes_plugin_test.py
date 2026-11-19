"""Hermes hooks, real collector API, no model/provider or live profile required."""

import importlib.util
import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = Path(
    os.environ.get(
        "AMO_TEST_HERMES_PACKAGE", ROOT / "integrations/hermes/agent-mini-office"
    )
)
UPSTREAM = bool(os.environ.get("AMO_TEST_HERMES_UPSTREAM"))
spec = importlib.util.spec_from_file_location(
    "amo_hermes", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)]
)
assert spec and spec.loader
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)


class Host:
    def __init__(self, cleanup=None):
        self.cleanup = cleanup
        self.hooks = {}
        self.prompts = []
        self._manager = SimpleNamespace(
            _cli_ref=None,
            has_tui_message_injector=False,
            has_gateway_message_injector=True,
        )

    def _gateway_injection_allowed(self):
        return True

    def session_surface(self):
        return "tui"

    def on_unload(self, callback):
        if self.cleanup:
            self.cleanup(callback)

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def inject_message(self, prompt, *, role, session_key):
        if UPSTREAM:
            from hermes_cli.plugins_injection import inject_plugin_message

            self.plugin_id = "agent-mini-office"
            self._manager.home_path = Path(os.environ["HERMES_HOME"])
            self._manager.inject_gateway_message = self.accept
            return inject_plugin_message(
                self, prompt, role, session_key=session_key, origin=None
            )
        return self.accept(session_key=session_key, content=prompt)

    def accept(self, *, session_key, content, **kwargs):
        self.prompts.append((session_key, content))
        return True

    def session_cwd(self):
        return "/private/path/Workspace"


def until(check):
    for _ in range(160):
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("timed out waiting for fixture outcome")


class Workflow(unittest.TestCase):
    def test_host_boundaries_and_grants(self):
        h = Host()
        sid = "target"
        key = "agent:main:local:dm:target"
        for bad in ("", sid, "agent:p:telegram:dm:target", key + "2"):
            self.assertIsNone(plugin.local_target(bad, sid))
        self.assertEqual(plugin.local_target(key, sid), key)
        for attr, value in [
            ("_cli_ref", object()),
            ("has_tui_message_injector", True),
            ("has_gateway_message_injector", False),
        ]:
            with patch.object(h._manager, attr, value):
                self.assertFalse(plugin.keyed_host(h))
        with patch.object(h, "_gateway_injection_allowed", return_value=False):
            self.assertFalse(plugin.keyed_host(h))
        for prefix, grant, allowed in [
            ("join", True, False),
            ("producer", False, False),
            ("producer", None, False),
            ("producer", True, True),
        ]:
            p = plugin.Panel(
                "http://localhost", "amo_" + prefix + "_" + "A" * 43, "Fixture"
            )
            reply = {
                "agent_id": plugin.panel.uid(),
                "last_seq": 0,
                "expires_at": "2030-01-01T00:00:00Z",
            }
            if grant is not None:
                reply["inbox"] = grant
            with patch.object(p, "request", return_value=reply):
                p.connect()
            self.assertIs(p.grant, allowed)

    def test_granted_visit_and_receipt(self):
        proc = subprocess.Popen(
            ["bun", "tests/hermes-office.fixture.ts"],
            cwd=ROOT,
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        stdout, stdin = proc.stdout, proc.stdin
        assert stdout and stdin
        self.addCleanup(stdout.close)
        self.addCleanup(stdin.close)
        self.addCleanup(proc.wait, 5)
        self.addCleanup(proc.terminate)

        def db(cmd):
            stdin.write(json.dumps(cmd) + "\n")
            stdin.flush()
            return json.loads(stdout.readline())

        setup = json.loads(stdout.readline())
        h = Host(self.addCleanup)
        sid = "local-test"
        route = "agent:main:local:dm:" + sid
        if UPSTREAM:
            from gateway.session_context import scoped_session_key

            self.enterContext(scoped_session_key(route))
        else:
            sessions = SimpleNamespace(bound_session_key=lambda: route)
            self.enterContext(
                patch.dict(sys.modules, {"gateway.session_context": sessions})
            )
        home = Path(self.enterContext(TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {"HERMES_HOME": str(home)}))
        private = home / "plugin-data/agent-mini-office"
        private.mkdir(parents=True, mode=0o700)
        cfg = private / "config.json"
        cfg.touch(mode=0o600)
        cfg.write_text(json.dumps({"panel_url": setup["url"], "token": setup["token"],
                                   "name": "Hermes Ops", "project": "Homelab"}))
        self.enterContext(patch.object(h, 'session_cwd', return_value=''))
        if not UPSTREAM:
            storage = SimpleNamespace(plugin_data_dir=lambda name: private)
            self.enterContext(
                patch.dict(sys.modules, {"plugins.plugin_storage": storage})
            )
        install = plugin.install
        with patch.object(
            plugin,
            "install",
            side_effect=lambda ctx, url, token, **labels: install(ctx, url, token, interval=0.15, **labels),
        ):
            plugin.register(h)

        def call(hook, **kw):
            return h.hooks[hook](session_id=sid, **kw)

        call("on_session_open")
        agent = until(lambda: db({"op": "agent"}))
        self.assertEqual(db({'op':'labels','agent':agent}), {'name':'Hermes Ops','project':'Homelab'})
        call("pre_llm_call", turn_id="human", user_message="NEVER-SEND")
        call(
            "pre_tool_call",
            tool_name="web_search",
            args={"text": "NEVER-SEND"},
            turn_id="human",
        )
        call(
            "subagent_start",
            parent_session_id=sid,
            parent_turn_id="human",
            child_session_id="child",
            child_goal="NEVER-SEND",
        )
        call(
            "subagent_stop",
            parent_session_id=sid,
            child_session_id="child",
            child_summary="NEVER-SEND",
            child_status="completed",
        )
        call("post_compaction", reason="NEVER-SEND")
        call(
            "on_human_input_request",
            request_id="wait",
            kind="approval",
            prompt="NEVER-SEND",
        )
        task = db({"op": "task", "agent": agent})
        time.sleep(0.45)
        self.assertFalse(h.prompts)
        call(
            "on_session_end",
            turn_id="human",
            completed=True,
            failed=False,
            interrupted=False,
        )
        time.sleep(0.35)
        self.assertFalse(h.prompts)
        call("on_human_input_resolved", request_id="wait", outcome="NEVER-SEND")
        key, prompt = until(lambda: h.prompts and h.prompts[0])
        self.assertEqual(key, route)
        self.assertIn(task, prompt)
        call("pre_llm_call", turn_id="bound", user_message=prompt)
        # Outlive the 2s collector lease. Renewal must not reinject the task.
        time.sleep(2.3)
        call(
            "post_llm_call",
            turn_id="bound",
            user_message=prompt,
            assistant_response="NEVER-SEND\nPANEL-TASK-SUMMARY: Updated the fixture.\nPANEL-TASK-DONE " + task,
        )
        call(
            "on_session_end",
            turn_id="bound",
            completed=True,
            failed=False,
            interrupted=False,
            turn_exit_reason="text_response(finish_reason=stop)",
        )
        until(lambda: db({"op": "status", "id": task}) == "acked")
        until(lambda: db({"op": "acks"}) == 2)
        self.assertEqual(db({'op':'result','id':task}), 'Updated the fixture.')
        second = db({"op": "task", "agent": agent})
        until(lambda: len(h.prompts) == 2)
        call("pre_llm_call", turn_id="interrupt", user_message="unrelated")
        call(
            "post_llm_call",
            turn_id="interrupt",
            user_message="unrelated",
            assistant_response="PANEL-TASK-DONE " + second,
        )
        call(
            "on_session_end",
            turn_id="interrupt",
            completed=True,
            failed=False,
            interrupted=False,
        )
        until(lambda: db({"op": "status", "id": second}) == "failed")
        stored = json.dumps(db({"op": "events"}))
        self.assertNotIn("NEVER-SEND", stored)
        for signal in (
            "search_web",
            "laptop_typing",
            "parent_run_id",
            "human.waiting",
            "human.resumed",
            "context-compacted",
        ):
            self.assertIn(signal, stored)
        self.assertNotIn('tool_source', stored)
        self.assertNotIn("/private/path", stored)
        self.assertEqual(len(h.prompts), 2)


if __name__ == "__main__":
    unittest.main()
