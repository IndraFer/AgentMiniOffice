"""Separate Hermes profiles, gateway and short-lived workers, one disposable collector."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_plugin_test import ROOT, Host, plugin, until


def process(role):
    home = Path(os.environ["HERMES_HOME"])
    h = Host()
    storage = SimpleNamespace(plugin_data_dir=lambda _: home)
    with patch.dict(sys.modules, {"plugins.plugin_storage": storage}):
        plugin.register(h)
    if role == "gateway":
        h.hooks["post_gateway_admission"](text="PRIVATE-GATEWAY-TEXT")
        print("ready", flush=True)
        sys.stdin.readline()
    else:
        sid = role
        for hook, kwargs in [
            ("pre_llm_call", {"user_message": "PRIVATE-PROMPT"}),
            (
                "pre_tool_call",
                {"tool_name": "web_search", "args": {"path": "PRIVATE-ARG"}},
            ),
            (
                "on_session_end",
                {"completed": True, "failed": False, "interrupted": False},
            ),
        ]:
            h.hooks[hook](
                session_id=sid,
                turn_id="same-turn-id",
                platform="discord" if role == "other-channel-turn" else "telegram",
                **kwargs,
            )


class Daemons(unittest.TestCase):
    def test_separate_gateways_workers_and_restart(self):
        office = subprocess.Popen(
            ["bun", "tests/hermes-office.fixture.ts"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(office.wait, 5)
        self.addCleanup(office.terminate)
        output, control = office.stdout, office.stdin
        assert output and control
        self.addCleanup(output.close)
        self.addCleanup(control.close)
        setup = json.loads(output.readline())

        def db(op):
            control.write(json.dumps({"op": op}) + "\n")
            control.flush()
            return json.loads(output.readline())

        def command(home, role):
            return subprocess.Popen(
                [sys.executable, "-B", __file__, role],
                env=dict(os.environ, HERMES_HOME=str(home)),
                text=True,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )

        def gateway(home):
            p = command(home, "gateway")
            self.addCleanup(stop, p)
            assert p.stdout
            self.assertEqual(p.stdout.readline().strip(), "ready")
            return p

        def stop(p):
            if p.poll() is None:
                p.stdin.close()
                p.wait(timeout=7)
            p.stdout.close()

        with tempfile.TemporaryDirectory() as temp:
            homes = [Path(temp) / n for n in ("Bot A", "Bot B")]
            for home in homes:
                home.mkdir(mode=0o700)
                config = home / "config.json"
                config.touch(mode=0o600)
                config.write_text(
                    json.dumps(
                        {
                            "panel_url": setup["url"],
                            "token": setup["token"],
                            "identity_mode": "daemon",
                            "name": home.name,
                            "project": "Homelab",
                        }
                    )
                )

            # Worker hooks alone must never open a visit, poll inbox or become the heartbeat owner.
            def worker(home, sid):
                p = command(home, sid)
                p.communicate(timeout=5)
                self.assertEqual(p.returncode, 0)

            worker(homes[0], "ephemeral")
            self.assertEqual(db("roster"), [])
            a, b = map(gateway, homes)
            standby = gateway(homes[0])
            stop(standby)
            roster = until(lambda: r if len(r := db("roster")) == 2 else None)
            self.assertEqual({r["name"] for r in roster}, {"Bot A", "Bot B"})
            for home in homes:
                for sid in ("telegram-turn", "other-channel-turn"):
                    worker(home, sid)

            def actions():
                return [e for e in db("events") if "search_web" in e["data"]]

            until(lambda: len(actions()) == 5)
            baseline = db("beats")
            self.assertEqual(set(baseline), {r["agent_id"] for r in roster})
            deadline = time.monotonic() + 19
            while time.monotonic() < deadline and any(
                db("beats")[a] <= n for a, n in baseline.items()
            ):
                time.sleep(0.15)
            self.assertTrue(
                all(db("beats")[a] > n for a, n in baseline.items()),
                "idle gateways must keep both avatars online without workers",
            )
            db("dropEvents")
            worker(homes[0], "lost-reply")
            until(lambda: db("lostEvents") > 0)
            stop(a)
            db("restoreEvents")
            db("dropRotation")
            a = gateway(homes[0])
            worker(homes[0], "after-restart")
            until(lambda: len(actions()) >= 7)
            self.assertEqual(
                len(actions()), 7
            )  # lost committed batch was replayed, not duplicated
            self.assertEqual(roster, db("roster"))
            self.assertEqual(db("polls"), 0)
            self.assertNotIn("PRIVATE-", json.dumps(db("events")))
            stop(a)
            stop(b)
            prior = db("deniedRotations")
            db("revoke")
            blocked = gateway(homes[0])
            until(lambda: db("deniedRotations") >= prior + 2)
            stop(blocked)
            self.assertEqual(db("roster"), roster)  # no silent replacement enrollment


if __name__ == "__main__":
    if len(sys.argv) > 1:
        process(sys.argv[1])
    else:
        unittest.main()
