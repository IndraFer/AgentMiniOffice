"""One ordered writer and at most one assigned panel task per live Hermes session."""

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass

from .panel import ID, Denied, Offline, expires, uid


@dataclass
class Task:
    id: str
    prompt: str
    run: str
    started: bool = False  # run.started was accepted by the collector
    sent: bool = False
    turn: str = ""
    receipt: bool = False
    outcome: str = ""
    renew: float = 0
    start_by: float = 0


class Visit:
    def __init__(self, panel, key, inject, interval):
        self.panel, self.key, self.inject, self.interval = panel, key, inject, interval
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.closed = False
        self.pending = deque()
        self.turns, self.children, self.waits = {}, {}, set()
        self.task = None
        self.delivered = {}
        self.thread = threading.Thread(
            target=self.work, daemon=True, name="amo-hermes-visit"
        )
        self.thread.start()

    def stop(self):
        with self.lock:
            self.closed = True
            self.key = None
            self.wake.set()

    def event(self, kind, data=None, run=None):
        if len(self.pending) >= 256:
            self.stop()  # lost ordering: fail closed rather than confirm later tasks
            return
        envelope = {"event_id": uid(), "type": kind, "data": data or {}}
        if run:
            envelope["run_id"] = run
        self.pending.append(envelope)
        self.wake.set()

    def observe(self, hook, kw, rules):
        # Called under the visit lock; never store hook dictionaries or message histories.
        turn = kw.get("turn_id")
        task = self.task
        if hook == "pre_llm_call" and turn and turn not in self.turns:
            if (
                task
                and task.sent
                and not task.turn
                and not task.outcome
                and kw.get("user_message") == task.prompt
            ):
                task.turn = turn
                self.turns[turn] = task.run
            else:
                if task and not task.outcome:
                    task.outcome = "fail"
                run = self.turns[turn] = uid()
                self.event("run.started", {"title": "Hermes turn"}, run)
        elif hook in ("pre_tool_call", "post_tool_call"):
            rule = dict(rules.get(kw.get("tool_name"), {"action": "other"}))
            if hook == "post_tool_call" and kw.get("status") in (
                "ok",
                "success",
                "error",
                "blocked",
            ):
                rule["ok"] = kw["status"] in ("ok", "success")
            self.event(
                "tool.start" if hook == "pre_tool_call" else "tool.call",
                rule,
                self.turns.get(turn),
            )
        elif hook == "post_llm_call" and turn in self.turns:
            answer = kw.get("assistant_response")
            if isinstance(answer, str) and answer.strip():
                self.event("note", {"action": "final_response"}, self.turns[turn])
                if task and task.turn == turn and kw.get("user_message") == task.prompt:
                    task.receipt = (
                        answer.rstrip().rsplit("\n", 1)[-1]
                        == "PANEL-TASK-DONE " + task.id
                    )
        elif (
            hook == "on_session_end"
            and turn in self.turns
            and all(
                isinstance(kw.get(k), bool)
                for k in ("completed", "failed", "interrupted")
            )
        ):
            run = self.turns.pop(turn)
            ok = (
                kw.get("completed") is True
                and kw.get("failed") is False
                and kw.get("interrupted") is False
            )
            if task and task.run == run:
                normal_stop = kw.get("turn_exit_reason") in (
                    "text_response(finish_reason=stop)",
                    "text_response(finish_reason=end_turn)",
                )
                task.outcome = task.outcome or (
                    "ack" if ok and normal_stop and task.receipt else "fail"
                )
                self.wake.set()
            else:
                self.event("run.finished" if ok else "run.failed", run=run)
        elif hook == "on_human_input_request" and kw.get("request_id"):
            self.waits.add(kw["request_id"])
            self.event(
                "human.waiting",
                {"kind": "confirm" if kw.get("kind") == "approval" else "input"},
            )
        elif hook == "on_human_input_resolved" and kw.get("request_id") in self.waits:
            self.waits.remove(kw["request_id"])
            if not self.waits:
                self.event("human.resumed")
        elif hook == "post_compaction":
            self.event("note", {"kind": "context-compacted"})
        elif hook == "subagent_start":
            child, parent = (
                kw.get("child_session_id"),
                self.turns.get(kw.get("parent_turn_id")),
            )
            if child and parent and child not in self.children:
                run = self.children[child] = uid()
                self.event(
                    "run.started",
                    {
                        "parent_run_id": parent,
                        "avatar_label": "Hermes child",
                        "title": "Delegated work",
                    },
                    run,
                )
        elif hook == "subagent_stop" and kw.get("child_status") in (
            "completed",
            "failed",
            "interrupted",
            "error",
        ):
            run = self.children.pop(kw.get("child_session_id"), None)
            if run:
                self.event(
                    "run.finished"
                    if kw.get("child_status") == "completed"
                    else "run.failed",
                    run=run,
                )

    def idle(self):
        return bool(
            self.key and not (self.closed or self.turns or self.children or self.waits)
        )

    def pickup(self):
        with self.lock:
            if not self.idle():
                return
        listing = self.panel.inbox()
        with self.lock:
            if not self.idle():
                return
            now = time.monotonic()
            self.delivered = {k: v for k, v in self.delivered.items() if v > now}
            for item in listing.get("tasks", []):
                tid = item.get("id", "")
                if (
                    not ID.fullmatch(tid)
                    or tid in self.delivered
                    or not isinstance(item.get("title"), str)
                ):
                    continue
                prompt = (
                    f"[AgentMiniOffice panel task {tid}; delivery {uid()}]\n{item['title']}\n{item.get('brief') or ''}\n\n"
                    "Follow normal Hermes approval rules. Only after completing this task, "
                    f"end your final answer with this line alone:\nPANEL-TASK-DONE {tid}"
                )
                self.task = Task(tid, prompt, uid())
                self.event("run.started", {"title": "Panel task"}, self.task.run)
                break

    def settle(self, t, ok):
        with self.lock:
            self.task = None
            self.event("run.finished" if ok else "run.failed", run=t.run)

    def service_task(self, t):
        path, owner = "/" + t.id, {"run_id": t.run}
        now = time.monotonic()
        try:
            with self.lock:
                if t.sent and not t.turn and now >= t.start_by:
                    t.outcome = "fail"
                outcome = t.outcome
            if outcome:
                result = (
                    {"result": "Hermes reported completion for this task."}
                    if outcome == "ack"
                    else {"reason": "Hermes did not confirm completion for this task."}
                )
                self.panel.inbox(path + "/" + outcome, owner | result)
                self.settle(t, outcome == "ack")
            elif now >= t.renew:
                lease = self.panel.inbox(path + "/claim", owner)
                ttl = expires(lease["lease_expires_at"]) - time.time()
                if (
                    lease["task"]["id"] != t.id
                    or lease["task"]["status"] != "claimed"
                    or ttl <= 0
                ):
                    raise ValueError("invalid lease")
                with self.lock:
                    t.renew = time.monotonic() + ttl / 2
                    if not t.sent:
                        if not self.idle() or t.outcome:
                            t.outcome = "fail"
                            return
                        # Mark BEFORE calling the host. Ambiguous delivery must never be repeated.
                        t.sent = True
                        t.start_by = time.monotonic() + 30
                        self.delivered[t.id] = time.monotonic() + 900
                        try:
                            accepted = self.inject(
                                t.prompt, role="user", session_key=self.key
                            )
                        except Exception:
                            accepted = False
                        if accepted is not True:
                            t.outcome = "fail"
        except Denied as error:
            if error.code not in (404, 409):
                raise
            self.settle(t, False)  # cancelled, expired, or now held by another run

    def work(self):
        p = self.panel
        heartbeat = poll = 0
        last_state = None
        delay = 0.25
        batch = []
        try:
            while not self.closed:
                self.wake.clear()
                try:
                    if time.time() >= p.renew or p.folder != p.reported_folder:
                        p.connect()
                    with self.lock:
                        if self.closed:
                            break
                        if not batch:
                            batch = [
                                self.pending.popleft()
                                for _ in range(min(16, len(self.pending)))
                            ]
                        state = (
                            "waiting_for_human"
                            if self.waits
                            else "working"
                            if self.turns
                            else "idle"
                        )
                    if batch:
                        p.events(batch)
                        if self.task and any(
                            e["type"] == "run.started"
                            and e.get("run_id") == self.task.run
                            for e in batch
                        ):
                            self.task.started = True
                        batch = []
                    now = time.monotonic()
                    if now >= heartbeat or state != last_state:
                        p.heartbeat(state)
                        heartbeat = now + self.interval
                        last_state = state
                    if p.grant:
                        if self.task and self.task.started:
                            self.service_task(self.task)
                        elif self.task is None and now >= poll:
                            self.pickup()
                            poll = now + self.interval
                    delay = 0.25
                except Offline:
                    # Keep the same envelope, event ID, claim run and finish body after lost replies.
                    time.sleep(delay)
                    delay = min(delay * 2, 5)
                    continue
                if self.pending:
                    continue
                deadline = (
                    min(heartbeat, poll) if p.grant and not self.task else heartbeat
                )
                if self.task:
                    deadline = min(deadline, self.task.renew or 0, time.monotonic() + 1)
                self.wake.wait(max(0.02, deadline - time.monotonic()))
        except Exception as error:
            logging.getLogger(__name__).warning(
                "Office visit stopped (%s); no task completion assumed.",
                type(error).__name__,
            )
        finally:
            self.stop()
