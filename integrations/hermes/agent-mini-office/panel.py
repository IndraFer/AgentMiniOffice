"""Small stdlib-only client. Secrets, HTTP bodies and remote errors are never logged."""

import json
import os
import re
import secrets
import stat
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

HERE = Path(__file__).parent
ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
TOKEN = re.compile(r"amo_(join|producer)_[a-zA-Z0-9_-]{43}")


def uid():
    n = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    return str(uuid.UUID(int=(n & ~(15 << 76 | 3 << 62)) | 7 << 76 | 2 << 62))


def expires(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def config(path):
    # Open once, do not follow symlinks or trust a path checked before opening.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)) as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
        ):
            raise ValueError("private config must belong to the user and be mode 0600")
        data = json.loads(file.read(16385))
    if (
        not {"panel_url", "token"} <= set(data)
        or set(data) - {"panel_url", "token", "name", "project", "identity_mode"}
        or not TOKEN.fullmatch(data["token"])
    ):
        raise ValueError("expected a panel origin and a join or producer token")
    name = data.get("name", "")
    project = data.get("project", "")
    for label, value in (("name", name), ("project", project)):
        if (
            not isinstance(value, str)
            or len(value) > 60
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
        ):
            raise ValueError(f"{label} must be printable text up to 60 characters")
    origin = urlsplit(data["panel_url"])
    if (
        not origin.hostname
        or origin.username is not None
        or origin.password is not None
        or origin.query
        or origin.fragment
        or origin.path not in ("", "/")
        or not (
            origin.scheme == "https"
            or origin.scheme == "http"
            and origin.hostname in {"localhost", "127.0.0.1", "::1"}
        )
    ):
        raise ValueError("expected HTTPS origin or HTTP on loopback")
    mode = data.get("identity_mode", "session")
    if mode not in ("daemon", "session"):
        raise ValueError("identity_mode must be daemon or session")
    return (
        data["panel_url"].rstrip("/"),
        data["token"],
        name.strip(),
        project.strip(),
        mode,
    )


def mappings():
    catalog = json.loads((HERE / "action-v1.json").read_text())["x-actions"]
    rules = json.loads((HERE / "actions.json").read_text())
    if set(rules) != {"$schema", "tools"} or not isinstance(rules["tools"], dict):
        raise ValueError("invalid actions.json")
    for tool, rule in rules["tools"].items():
        if (
            not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,120}", tool)
            or not isinstance(rule, dict)
            or set(rule) - {"action", "variant"}
            or rule.get("action") not in catalog
        ):
            raise ValueError("invalid tool/action mapping")
        if "variant" in rule and rule["variant"] not in [
            v["id"] for v in catalog[rule["action"]].get("variants", [])
        ]:
            raise ValueError("variant does not belong to mapped action")
    return rules["tools"]


class RefuseRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Denied(Exception):
    def __init__(self, code):
        self.code = code


class Offline(Exception):
    pass


class Panel:
    def __init__(self, origin, token, folder, project="", *, lifecycle="session"):
        self.lifecycle = lifecycle
        self.origin, self.token, self.folder = origin, token, folder
        self.project = project
        self.producer = (
            token
            if token.startswith("amo_producer_")
            else "amo_producer_" + secrets.token_urlsafe(32)
        )
        self.enrolled = self.producer == token
        self.writer = "amo_writer_" + secrets.token_urlsafe(32)
        self.session = uid()  # private Hermes route/session IDs never go on the wire
        self.agent = ""
        self.seq = 0
        self.grant = False
        self.renew = 0
        self.reported_folder = None
        self.reported_project = None
        self.http = build_opener(RefuseRedirect())

    def request(self, path, body=None, *, bearer=None, method=None):
        raw = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        req = Request(
            self.origin + "/api/v1" + path,
            data=raw,
            headers={
                "Authorization": "Bearer " + (bearer or self.writer),
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with self.http.open(req, timeout=4) as response:
                return json.loads(response.read(262145) or b"{}")
        except HTTPError as error:
            error.close()
            if error.code not in (408, 429) and error.code < 500:
                raise Denied(error.code) from None
        except (OSError, URLError):
            pass
        raise Offline()

    def connect(self):
        if not self.enrolled:
            self.request(
                "/machine/enroll",
                {"producer_token": self.producer, "visit": True},
                bearer=self.token,
            )
            self.enrolled = True
        folder = self.folder
        session_body = {
            "visit": True,
            "harness": "hermes",
            "name": folder,
            "external_session_id": self.session,
            "writer_token": self.writer,
            "lifecycle": self.lifecycle,
        }
        if self.project:
            session_body["project"] = self.project
        result = self.request(
            "/machine/sessions",
            session_body,
            bearer=self.producer,
        )
        if not ID.fullmatch(result["agent_id"]) or self.agent not in (
            "",
            result["agent_id"],
        ):
            raise ValueError("invalid office identity")
        self.agent = result["agent_id"]
        self.reported_folder = folder
        self.seq = max(self.seq, result["last_seq"])
        self.grant = (
            self.token.startswith("amo_producer_") and result.get("inbox") is True
        )
        self.renew = expires(result["expires_at"]) - 60
        if self.project and self.reported_project != self.project:
            try:
                self.request(
                    f"/machine/sessions/{self.agent}/project",
                    {"project": self.project},
                    method="PATCH",
                )
            except Denied as error:
                if error.code not in (404, 405):
                    raise
            self.reported_project = self.project

    def events(self, batch):
        for i, event in enumerate(batch, 1):
            event.setdefault("seq", self.seq + i)
        result = self.request("/agents/" + self.agent + "/events", {"events": batch})
        if result.get("rejected") or not isinstance(result.get("accepted"), int):
            raise ValueError("collector rejected telemetry")
        self.seq = max(self.seq, batch[-1]["seq"])

    def heartbeat(self, state):
        # A lost committed heartbeat may leave a sequence gap; never reuse it for another operation.
        self.seq += 1
        self.request(
            "/agents/" + self.agent + "/heartbeat", {"seq": self.seq, "state": state}
        )

    def inbox(self, path="", data=None):
        return self.request("/agents/" + self.agent + "/inbox" + path, data)
