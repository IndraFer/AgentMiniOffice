"""One new Hermes ACP session on private stdio. No chat routing or auto-approvals."""

import asyncio
import contextlib
import json
import os
import threading
import time

from .task_receipt import receipt


class PrivateTurn:
    def __init__(self, command, profile, workspace, task, prompt, deadline):
        self.command, self.profile, self.workspace = command, profile, workspace
        self.deadline = deadline
        self.cancel = threading.Event()
        self.done = threading.Event()
        self.ok = False
        self.note = ""
        self.thread = threading.Thread(
            target=self._run, args=(task, prompt), daemon=True
        )
        self.thread.start()

    def _run(self, task, prompt):
        try:
            self.ok = asyncio.run(self._exchange(task, prompt))
        except Exception:
            # Exceptions from an adapter can contain private model output. Never log them.
            self.ok = False
        finally:
            self.done.set()

    async def _exchange(self, task, prompt):
        env = {
            k: os.environ[k]
            for k in ("PATH", "HOME", "LANG", "TMPDIR", "SSL_CERT_FILE")
            if k in os.environ
        }
        env["HERMES_HOME"] = str(self.profile)
        p = await asyncio.create_subprocess_exec(
            *self.command,
            cwd=self.workspace,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=1024 * 1024,
        )
        assert p.stdin and p.stdout
        writer, reader = p.stdin, p.stdout
        sid = None
        tail = ""
        denied = False

        async def send(msg):
            writer.write((json.dumps({"jsonrpc": "2.0", **msg}) + "\n").encode())
            await writer.drain()

        async def rpc(n, method, params):
            nonlocal tail, denied
            await send({"id": n, "method": method, "params": params})
            while True:
                line = await reader.readline()
                if not line:
                    raise EOFError()
                try:
                    msg = json.loads(line)
                except (ValueError, UnicodeError):
                    raise ValueError("invalid ACP response") from None
                if msg.get("jsonrpc") != "2.0":
                    raise ValueError("invalid ACP envelope")
                if "method" not in msg:
                    if msg.get("id") != n or "error" in msg:
                        raise ValueError("unexpected ACP response")
                    return msg["result"]
                if "id" in msg:
                    if msg["method"] == "session/request_permission":
                        self.note = "Hermes requested interactive permission; the daemon did not grant it."
                        denied = True
                        options = msg.get("params", {}).get("options", [])
                        reject = next(
                            (
                                o.get("optionId")
                                for o in options
                                if o.get("kind") == "reject_once"
                            ),
                            None,
                        )
                        outcome = (
                            {"outcome": "selected", "optionId": reject}
                            if reject
                            else {"outcome": "cancelled"}
                        )
                        await send(
                            {
                                "id": msg["id"],
                                "result": {"outcome": outcome},
                            }
                        )
                        self.cancel.set()
                    else:
                        await send(
                            {
                                "id": msg["id"],
                                "error": {"code": -32601, "message": "Not supported"},
                            }
                        )
                    continue
                data = msg.get("params", {})
                if (
                    n != 3
                    or msg["method"] != "session/update"
                    or data.get("sessionId") != sid
                ):
                    continue
                update = data.get("update", {})
                if update.get("sessionUpdate") in ("tool_call", "user_message_chunk"):
                    tail = ""
                if update.get("sessionUpdate") == "agent_message_chunk":
                    content = update.get("content", {})
                    if content.get("type") == "text":
                        # Keep only a bounded suffix; a cut inside a line is not a valid prefix.
                        tail += content["text"]
                        if len(tail) > 1024:
                            tail = "…" + tail[-1023:]

        async def turn():
            nonlocal sid
            init = await rpc(
                1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
            )
            if init.get("protocolVersion") != 1:
                return False
            session = await rpc(
                2, "session/new", {"cwd": str(self.workspace), "mcpServers": []}
            )
            sid = session.get("sessionId")
            if (
                not isinstance(sid, str)
                or not sid
                or self.cancel.is_set()
                or time.monotonic() >= self.deadline
            ):
                return False
            result = await rpc(
                3,
                "session/prompt",
                {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]},
            )
            if denied or result.get("stopReason") != "end_turn":
                self.note = self.note or "The private turn did not end normally."
                return False
            status, self.note = receipt(tail, task)
            if not status:
                self.note = "The private turn ended without a matching task receipt."
            return status == "ack"

        job = asyncio.create_task(turn())
        try:
            limit = time.monotonic() + 15 * 60
            while not self.cancel.is_set() and time.monotonic() < min(
                limit, self.deadline
            ):
                done, _ = await asyncio.wait({job}, timeout=0.1)
                if done:
                    return job.result()
            return False
        finally:
            if not job.done():
                if sid and p.returncode is None:
                    with contextlib.suppress(OSError, TimeoutError):
                        await asyncio.wait_for(
                            send(
                                {
                                    "method": "session/cancel",
                                    "params": {"sessionId": sid},
                                }
                            ),
                            timeout=0.2,
                        )
                job.cancel()
            await asyncio.gather(job, return_exceptions=True)
            writer.close()
            try:
                await asyncio.wait_for(p.wait(), timeout=0.5)
            except TimeoutError:
                if p.returncode is None:
                    p.kill()
                await p.wait()

    def stop(self):
        self.cancel.set()
        self.thread.join(timeout=2)
