"""Task journal serviced only by the elected telemetry writer, on its ordered event queue."""

import importlib.util
import json
import logging
import os
import stat
import sys
import time
from pathlib import Path

from .panel import ID, Denied, expires, uid
from .private_turn import PrivateTurn


def adapter_command():
    # Hermes also ships as a source checkout. Use the running host's adapter, not a
    # command on PATH, a plugin setting, or a module resolved from the task directory.
    spec = importlib.util.find_spec("acp_adapter")
    if not spec or not spec.origin or not importlib.util.find_spec("acp"):
        return None
    package = Path(spec.origin).resolve().parent
    if not (package / "gateway_server.py").is_file():
        return None
    return (
        sys.executable,
        "-I",
        "-c",
        "import sys; sys.path.insert(0,sys.argv.pop(1)); from acp_adapter.entry import main; main([])",
        str(package.parent),
    )


def for_profile(ctx, home):
    # An admission can be called under a routed profile. Never infer the execution profile
    # from a Telegram message or the gateway process's ambient HERMES_HOME.
    host = getattr(getattr(ctx, "_manager", None), "home_path", None)
    consent = getattr(ctx, "_gateway_injection_allowed", None)
    if not host or not callable(consent):
        return None
    profile = Path(host).resolve()
    if home.resolve() != profile / "plugin-data" / "agent-mini-office":
        return None
    command = adapter_command()
    return DaemonInbox(profile, home, consent, command) if command else None


class DaemonInbox:
    def __init__(self, profile, home, consent, command):
        self.profile, self.home, self.consent = profile, home, consent
        self.command = command
        self.disabled = False
        self.turn = None
        self.poll_at = self.renew_at = 0

    def stop(self):
        if self.turn:
            self.turn.stop()
            self.turn = None

    @staticmethod
    def event(db, kind, run):
        eid = uid()
        data = {"title": "Panel task"} if kind == "run.started" else {}
        body = json.dumps({"event_id": eid, "type": kind, "data": data, "run_id": run})
        db.execute("INSERT INTO queue(body) VALUES(?)", (body,))
        return eid

    def tick(self, db, p, idle):
        now = time.monotonic()
        if now < self.poll_at:
            return
        if not p.grant or not self.consent():
            self.stop()
            self.poll_at = now + 5
            return
        row = db.execute("SELECT id,run,phase,start_event FROM inbox_job").fetchone()
        if not row:
            self.poll_at = now + 3
            if not idle:
                return
            items = p.inbox().get("tasks", [])
            for item in items:
                tid = item.get("id")
                if not isinstance(tid, str) or not ID.fullmatch(tid):
                    continue
                with db:
                    # Pickup for visits expires after 15 minutes. Keep tombstones substantially longer.
                    db.execute(
                        "DELETE FROM inbox_sent WHERE at < ?", (time.time() - 86400,)
                    )
                    if db.execute(
                        "SELECT 1 FROM inbox_sent WHERE id=?", (tid,)
                    ).fetchone():
                        continue
                    run = uid()
                    eid = self.event(db, "run.started", run)
                    db.execute(
                        "INSERT INTO inbox_job VALUES(?,?,?,?)",
                        (tid, run, "claim", eid),
                    )
                self.poll_at = 0
                break
            return
        tid, run, phase, eid = row
        if db.execute(
            "SELECT 1 FROM queue WHERE json_extract(body,'$.event_id')=?", (eid,)
        ).fetchone():
            return
        path = "/" + tid
        owner = {"run_id": run}
        try:
            if phase == "sent" and (not self.turn or self.turn.done.is_set()):
                # A process restart cannot prove completion and must never re-submit a prompt.
                phase = "ack" if self.turn and self.turn.ok else "fail"
                with db:
                    db.execute("UPDATE inbox_job SET phase=?", (phase,))
                self.stop()
            if phase in ("ack", "fail"):
                note = (
                    {"result": "Hermes reported completion for this task."}
                    if phase == "ack"
                    else {"reason": "Hermes did not confirm completion for this task."}
                )
                try:
                    p.inbox(path + "/" + phase, owner | note)
                except Denied as error:
                    if error.code != 409 or phase != "fail":
                        raise
                    # Restart after lease expiry: settle ambiguous work as failed, never dispatch it again.
                    p.inbox(path + "/claim", owner)
                    p.inbox(path + "/fail", owner | note)
                self.finish(db, run, phase == "ack")
                return
            if phase == "sent" and now < self.renew_at:
                return
            lease = p.inbox(path + "/claim", owner)
            item = lease["task"]
            ttl = expires(lease["lease_expires_at"]) - time.time()
            if item["id"] != tid or item["status"] != "claimed" or ttl <= 0:
                raise ValueError("invalid task lease")
            now = time.monotonic()
            self.renew_at = now + ttl / 2
            if self.turn:
                self.turn.deadline = now + ttl
                return
            if not idle or not self.consent():
                with db:
                    db.execute("UPDATE inbox_job SET phase='fail'")
                return
            prompt = (
                f"[AgentMiniOffice panel task {tid}]\n{item['title']}\n{item.get('brief') or ''}\n\n"
                f"Follow normal Hermes approval rules. Only after completing this task, end your final answer with this line alone:\nPANEL-TASK-DONE {tid}"
            )
            workspace = self.home / "task-workspace"
            workspace.mkdir(mode=0o700, exist_ok=True)
            info = workspace.lstat()
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                raise ValueError("unsafe task workspace")
            with db:
                db.execute("INSERT INTO inbox_sent VALUES(?,?)", (tid, time.time()))
                db.execute("UPDATE inbox_job SET phase='sent'")
            self.turn = PrivateTurn(
                self.command, self.profile, workspace, tid, prompt, now + ttl
            )
        except Denied as error:
            if error.code not in (404, 409):
                raise
            self.finish(db, run, False)

    def finish(self, db, run, ok):
        self.stop()
        with db:
            self.event(db, "run.finished" if ok else "run.failed", run)
            db.execute("DELETE FROM inbox_job")

    def service(self, db, p, idle):
        if self.disabled:
            return
        try:
            self.tick(db, p, idle)
        except Denied as error:
            if error.code not in (401, 403):
                raise
            self.stop()
            self.poll_at = time.monotonic() + 30
            logging.getLogger(__name__).warning(
                "Daemon Inbox permission denied; no task delivery."
            )
        except (ValueError, OSError, KeyError, TypeError) as error:
            self.stop()
            self.disabled = True
            logging.getLogger(__name__).warning(
                "Daemon Inbox stopped (%s); telemetry remains active.",
                type(error).__name__,
            )
