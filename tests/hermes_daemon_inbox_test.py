"""Real collector + real gateway registration; only the private ACP server is synthetic."""

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


def fake_acp():
    session = "fresh-private-session"
    for line in sys.stdin:
        m = json.loads(line)

        def emit(**fields):
            print(json.dumps(dict(jsonrpc="2.0", **fields)), flush=True)

        method = m.get("method")
        args = m.get("params", {})
        if method == "initialize":
            assert args["clientCapabilities"] == {}
            result = {"protocolVersion": 1, "agentCapabilities": {}}
        elif method == "session/new":
            assert not args["mcpServers"] and "sessionId" not in args
            result = {"sessionId": session}
        elif method == "session/prompt":
            assert (
                args["sessionId"] == session
                and "Fixture brief" in args["prompt"][0]["text"]
            )
            marker = args["prompt"][0]["text"].splitlines()[-1]
            assert marker.startswith("PANEL-TASK-DONE ")
            home = Path(os.environ["HERMES_HOME"])
            with (home / "submissions").open("a") as f:
                print(marker, file=f)
            behavior = (home / "behavior").read_text()
            if behavior == "hang":
                sys.stdin.readline()  # EOF on gateway crash; do not leave a fixture orphan
                return
            elif behavior == "permission":
                emit(
                    id=71,
                    method="session/request_permission",
                    params={
                        "sessionId": session,
                        "options": [
                            {"kind": "allow_once", "optionId": "yes"},
                            {"kind": "reject_once", "optionId": "no"},
                        ],
                    },
                )
                reply = json.loads(sys.stdin.readline())
                assert reply["result"]["outcome"] == {
                    "outcome": "selected",
                    "optionId": "no",
                }
                (home / "denied").touch()
            elif behavior == "ok":
                time.sleep(2.3)  # needs renewal of two-second lease
            emit(
                method="session/update",
                params={
                    "sessionId": session if behavior != "foreign" else "telegram",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {
                            "type": "text",
                            "text": "PRIVATE-ANSWER\nPANEL-TASK-SUMMARY: Verified the fixture.\n" + marker,
                        },
                    },
                },
            )
            result = {"stopReason": "end_turn"}
        else:
            return
        emit(id=m["id"], result=result)


def gateway(home, allowed):
    from importlib import import_module

    daemon_inbox = import_module(plugin.__name__ + ".daemon_inbox")

    h = Host()
    h._manager.home_path = home
    h._gateway_injection_allowed = lambda: allowed

    def no_chat(*args, **kwargs):
        raise AssertionError("must not inject into messaging sessions")

    h.inject_message = no_chat
    data = home / "plugin-data" / "agent-mini-office"
    with (
        patch.dict(
            sys.modules,
            {"plugins.plugin_storage": SimpleNamespace(plugin_data_dir=lambda _: data)},
        ),
        patch.object(
            daemon_inbox,
            "adapter_command",
            lambda: (sys.executable, "-B", str(Path(__file__).resolve()), "acp"),
        ),
    ):
        plugin.register(h)
        h.hooks["post_gateway_admission"](platform="telegram", text="PRIVATE-GATEWAY")
        print("ready", flush=True)
        sys.stdin.readline()


class DaemonInbox(unittest.TestCase):
    def test_gates_delivery_recovery_and_receipt(self):
        office = subprocess.Popen(
            ["bun", "tests/hermes-office.fixture.ts"],
            cwd=ROOT,
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )

        def stop(p):
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=5)
            p.stdin.close()
            p.stdout.close()

        self.addCleanup(stop, office)
        output, control = office.stdout, office.stdin
        assert output and control
        setup = json.loads(output.readline())

        def db(op, **kw):
            print(json.dumps(dict(op=op, **kw)), file=control, flush=True)
            return json.loads(output.readline())

        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            data = home / "plugin-data" / "agent-mini-office"
            data.mkdir(parents=True, mode=0o700)
            cfg = data / "config.json"
            cfg.touch(mode=0o600)
            cfg.write_text(
                json.dumps(
                    dict(
                        panel_url=setup["url"],
                        token=setup["token"],
                        identity_mode="daemon",
                    )
                )
            )

            def start(allowed):
                p = subprocess.Popen(
                    [
                        sys.executable,
                        "-B",
                        __file__,
                        "gateway",
                        root,
                        str(int(allowed)),
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                )
                self.addCleanup(stop, p)
                assert p.stdout
                self.assertEqual(p.stdout.readline().strip(), "ready")
                return p

            p = start(False)
            agent = until(lambda: db("agent"))
            t = db("task", agent=agent)
            until(lambda: db("beats").get(agent, 0) > 0)
            self.assertEqual(db("polls"), 0)
            stop(p)
            (home / "behavior").write_text("ok")
            p = start(True)
            until(lambda: db("status", id=t) == "acked")
            until(lambda: db("acks") == 2)
            self.assertGreaterEqual(db("claims", id=t), 2)
            self.assertEqual(db('result', id=t), 'Verified the fixture.')
            # A foreign session's marker cannot complete our task.
            (home / "behavior").write_text("foreign")
            bad = db("task", agent=agent)
            until(lambda: db("status", id=bad) == "failed")
            (home / "behavior").write_text("permission")
            denied = db("task", agent=agent)
            until(lambda: db("status", id=denied) == "failed")
            self.assertTrue((home / "denied").is_file())
            self.assertIn('permission', db('result', id=denied))
            (home / "behavior").write_text("hang")
            lost = db("task", agent=agent)
            sent = home / "submissions"
            until(lambda: lost in sent.read_text())
            stop(p)
            time.sleep(2.1)  # simulate restart after the last granted lease has expired
            p = start(True)
            until(lambda: db("status", id=lost) == "failed")
            self.assertIn('could not verify', db('result',id=lost))
            self.assertEqual(len(sent.read_text().splitlines()), 4)
            self.assertEqual(db("agent"), agent)
            stop(p)
            self.assertNotIn("PRIVATE-", json.dumps(db("events")))
            state = (data / "daemon-state" / "office.sqlite").read_bytes()
            self.assertNotIn(b"Fixture brief", state)
            self.assertNotIn(b"PRIVATE-ANSWER", state)


if __name__ == "__main__":
    if sys.argv[1:2] == ["acp"]:
        fake_acp()
    elif sys.argv[1:2] == ["gateway"]:
        gateway(Path(sys.argv[2]), bool(int(sys.argv[3])))
    else:
        unittest.main()
