"""Profile-local daemon telemetry. Workers enqueue allowlisted observations, never credentials or chat data."""

import fcntl
import hashlib
import json
import logging
import os
import secrets
import sqlite3
import stat
import threading
import time
from contextlib import closing

from .panel import Denied, Offline, Panel, uid

LOG = logging.getLogger(__name__)
MAX_QUEUE = 512


def digest(*parts):
    return hashlib.sha256(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


class Mailbox:
    def __init__(self, home, origin, token):
        parent = home.lstat()
        if (
            not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.getuid()
            or parent.st_mode & 0o022
        ):
            raise ValueError("unsafe daemon state parent")
        self.root = home / "daemon-state"
        self.root.mkdir(mode=0o700, exist_ok=True)
        info = self.root.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_mode & 0o077
            or info.st_uid != os.getuid()
        ):
            raise ValueError("daemon-state requires an owned private directory")
        self.path = self.root / "office.sqlite"
        fd = os.open(self.path, os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR, 0o600)
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                raise ValueError("daemon state must be a private file")
        finally:
            os.close(fd)
        binding = digest(origin, token)
        with closing(self.open()) as db, db:
            db.executescript("""CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS inbox_job(id TEXT PRIMARY KEY,run TEXT NOT NULL,phase TEXT NOT NULL,start_event TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS inbox_sent(id TEXT PRIMARY KEY,at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS queue(n INTEGER PRIMARY KEY, body TEXT NOT NULL, seq INTEGER);
                CREATE TABLE IF NOT EXISTS activity(k TEXT PRIMARY KEY,session TEXT NOT NULL,kind TEXT NOT NULL,pid INTEGER NOT NULL);""")
            db.execute("INSERT OR IGNORE INTO meta VALUES('binding',?)", (binding,))
            if self.get(db, "binding") != binding:
                raise ValueError(
                    "stop the old installation before rebinding private daemon state"
                )

    def open(self):
        return sqlite3.connect(self.path, timeout=0.4)

    @staticmethod
    def get(db, key):
        row = db.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
        return row[0] if row else None

    @staticmethod
    def put(db, key, value):
        db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, value))

    @staticmethod
    def enqueue(db, kind, data):
        body = json.dumps(
            {"event_id": uid(), "type": kind, "data": data}, separators=(",", ":")
        )
        db.execute(
            "INSERT INTO queue(body) SELECT ? WHERE (SELECT count(*) FROM queue) < ?",
            (body, MAX_QUEUE),
        )

    def observe(self, hook, kw, rules):
        # Hash correlation IDs for local bookkeeping. No native identifiers go on the wire.
        child_hook = hook in ("subagent_start", "subagent_stop")
        sid = kw.get("parent_session_id") if child_hook else kw.get("session_id")
        if not isinstance(sid, str) or not sid:
            return
        session = digest(sid)
        turn = kw.get("turn_id")
        request = kw.get("request_id")
        with closing(self.open()) as db, db:
            if child_hook:
                child = kw.get("child_session_id")
                if not isinstance(child, str) or not child:
                    return
                key = digest(sid, "child", child)
                if hook == "subagent_start":
                    db.execute(
                        "INSERT OR IGNORE INTO activity SELECT ?,?,'child',? WHERE (SELECT count(*) FROM activity)<512",
                        (key, session, os.getpid()),
                    )
                elif kw.get("child_status") in (
                    "completed",
                    "failed",
                    "interrupted",
                    "error",
                ):
                    db.execute("DELETE FROM activity WHERE k=?", (key,))
            elif hook in ("pre_llm_call", "on_human_input_request"):
                wait = hook == "on_human_input_request"
                identifier = request if wait else turn
                if not identifier:
                    return
                kind = "wait" if wait else "turn"
                db.execute(
                    "INSERT OR IGNORE INTO activity SELECT ?,?,?,? WHERE (SELECT count(*) FROM activity)<512",
                    (digest(sid, kind, identifier), session, kind, os.getpid()),
                )
                if wait:
                    self.enqueue(
                        db,
                        "human.waiting",
                        {
                            "kind": "confirm"
                            if kw.get("kind") == "approval"
                            else "input"
                        },
                    )
            elif hook == "on_session_end" and turn:
                db.execute(
                    "DELETE FROM activity WHERE k=?", (digest(sid, "turn", turn),)
                )
            elif hook == "on_human_input_resolved" and request:
                removed = db.execute(
                    "DELETE FROM activity WHERE k=?", (digest(sid, "wait", request),)
                ).rowcount
                if (
                    removed
                    and not db.execute(
                        "SELECT 1 FROM activity WHERE kind='wait'"
                    ).fetchone()
                ):
                    self.enqueue(db, "human.resumed", {})
            elif hook in ("on_session_finalize", "on_session_reset"):
                db.execute(
                    "DELETE FROM activity WHERE session=?",
                    (digest(kw.get("old_session_id") or sid),),
                )
            elif hook in ("pre_tool_call", "post_tool_call"):
                self.enqueue(
                    db,
                    "tool.start" if hook == "pre_tool_call" else "tool.call",
                    rules.get(kw.get("tool_name"), {"action": "other"}),
                )
            elif hook == "post_compaction":
                self.enqueue(db, "note", {"kind": "context-compacted"})
            elif (
                hook == "post_llm_call"
                and isinstance(kw.get("assistant_response"), str)
                and kw["assistant_response"].strip()
            ):
                self.enqueue(db, "note", {"action": "final_response"})

    @staticmethod
    def load_batch(db, last_seq):
        # Persist wire sequence before attempting the network. A committed-but-lost
        # event replays with the exact same ID, sequence and JSON key order after a crash.
        with db:
            rows = db.execute(
                "SELECT n,body,seq FROM queue WHERE seq IS NOT NULL ORDER BY n LIMIT 16"
            ).fetchall()
            if not rows:
                rows = db.execute(
                    "SELECT n,body,seq FROM queue ORDER BY n LIMIT 16"
                ).fetchall()
            batch = []
            for index, (n, raw, seq) in enumerate(rows, 1):
                if seq is None:
                    seq = last_seq + index
                    db.execute("UPDATE queue SET seq=? WHERE n=?", (seq, n))
                batch.append(dict(json.loads(raw), seq=seq))
            return batch, [r[0] for r in rows]

    @staticmethod
    def presence(db):
        # Workers may exit without sending a final hook. Never fabricate a run outcome.
        with db:
            for (pid,) in db.execute("SELECT DISTINCT pid FROM activity").fetchall():
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    db.execute("DELETE FROM activity WHERE pid=?", (pid,))
            kinds = {row[0] for row in db.execute("SELECT DISTINCT kind FROM activity")}
            return (
                "waiting_for_human"
                if "wait" in kinds
                else "working"
                if kinds
                else "idle"
            )


class GatewayWriter:
    def __init__(self, box, panel, inbox=None):
        self.box, self.panel, self.inbox = box, panel, inbox
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.thread = None

    def start(self):
        with self.lock:
            if self.stopped.is_set() or self.thread and self.thread.is_alive():
                return
            self.thread = threading.Thread(
                target=self.run, daemon=True, name="amo-hermes-daemon"
            )
            self.thread.start()

    def connect(self, db):
        p = self.panel
        raw = self.box.get(db, "proof")
        proof: dict = (
            json.loads(raw)
            if raw
            else dict(
                session=p.session,
                writer=p.writer,
                producer=None if p.producer == p.token else p.producer,
                agent="",
                enrolled=p.enrolled,
            )
        )

        def save():
            with db:
                self.box.put(db, "proof", json.dumps(proof))

        if not raw:
            save()  # enrollment/open retries must retain these same proofs after power loss
        p.session, p.writer, p.agent = (
            proof[k] for k in ("session", "writer", "agent")
        )
        p.producer = proof["producer"] or p.token
        p.enrolled = proof["enrolled"]
        if not p.enrolled:
            p.request(
                "/machine/enroll",
                {"producer_token": p.producer, "visit": True},
                bearer=p.token,
            )
            p.enrolled = proof["enrolled"] = True
            save()
        if p.agent:
            # Target the known server ID first: an owner removal must not create a new avatar.
            # A lost rotation reply is recovered by proving the saved candidate, never by enrolling.
            for attempt in range(2):
                candidate = proof.setdefault(
                    "next", "amo_writer_" + secrets.token_urlsafe(32)
                )
                save()
                try:
                    result = p.request(
                        "/machine/sessions/" + p.agent + "/resume",
                        {
                            "writer_token": proof["writer"],
                            "next_writer_token": candidate,
                        },
                        bearer=p.producer,
                    )
                except Denied as error:
                    if error.code != 401 or attempt:
                        raise
                    proof["writer"] = proof.pop("next")
                    save()
                    continue
                if result.get("agent_id") != p.agent:
                    raise ValueError("daemon identity mismatch")
                p.writer = proof["writer"] = proof.pop("next")
                save()
                break
        p.connect()  # refresh public labels and obtain the collector's actual last sequence
        proof["agent"] = p.agent
        save()

    def run(self):
        fd = os.open(self.box.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            with closing(self.box.open()) as db:
                heartbeat = 0
                last_state = None
                delay = 0.25
                while not self.stopped.is_set():
                    try:
                        if time.time() >= self.panel.renew:
                            self.connect(db)
                        batch, ids = self.box.load_batch(db, self.panel.seq)
                        if batch:
                            self.panel.events(batch)
                            with db:
                                db.executemany(
                                    "DELETE FROM queue WHERE n=?", [(i,) for i in ids]
                                )
                        state = self.box.presence(db)
                        if self.inbox:
                            self.inbox.service(db, self.panel, state == "idle")
                            if state == "idle" and self.inbox.turn:
                                state = "working"
                        if time.monotonic() >= heartbeat or state != last_state:
                            self.panel.heartbeat(state)
                            last_state = state
                            heartbeat = time.monotonic() + 15
                        delay = 0.25
                        self.stopped.wait(0 if batch else 0.25)
                    except Offline:
                        self.stopped.wait(delay)
                        delay = min(5, 2 * delay)
        except Exception as error:
            self.stopped.set()
            LOG.warning(
                "Daemon office writer stopped (%s); check admission, credential and private state.",
                type(error).__name__,
            )
        finally:
            if self.inbox:
                self.inbox.stop()
            os.close(fd)

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=5)


class DaemonConnector:
    def __init__(self, home, origin, token, name, project, rules, inbox=None):
        self.box = Mailbox(home, origin, token)
        self.rules = rules
        self.writer = GatewayWriter(
            self.box,
            Panel(origin, token, name or "Hermes", project, lifecycle="daemon"),
            inbox,
        )

    def handle(self, hook, kw):
        if hook == "post_gateway_admission":
            self.writer.start()
        else:
            try:
                self.box.observe(hook, kw, self.rules)
            except sqlite3.OperationalError as error:
                if error.sqlite_errorcode not in (
                    sqlite3.SQLITE_BUSY,
                    sqlite3.SQLITE_LOCKED,
                ):
                    raise
                # Bounded best effort: contention must not disable the plugin or block a tool.

    def close(self):
        self.writer.close()
