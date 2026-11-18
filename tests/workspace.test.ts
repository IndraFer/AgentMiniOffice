import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app";
import { openDb } from "../src/lib/db";
import { applySchema } from "../src/lib/schema";
import { PresenceStore } from "../src/lib/state";
import { uuidv7 } from "../src/lib/uuid";

const secret = (kind: string) => `amo_${kind}_${randomBytes(32).toString("base64url")}`;
test("fresh install: two session writers, retry, resume after restart, admission, permissions and revocation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amo-workspace-"));
  const file = path.join(dir, "test.db");
  let db = await openDb(file);
  const boot = () => {
    applySchema(db, "docs/SCHEMA.sql");
    const store = new PresenceStore({ onlineMs: 30000, staleMs: 90000, roomHysteresisMs: 0 });
    return createApp({ db, store, allowRegistration: true });
  };
  let app = boot();
  const api = async (
    method: string,
    url: string,
    status: number,
    body?: unknown,
    bearer = "",
    cookie = "",
    extra: Record<string, string> = {},
  ) => {
    const r = await app.request(`/api/v1${url}`, {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.status, status, `${method} ${url}`);
    const value: Record<string, unknown> =
      status === 204 ? {} : ((await r.json()) as Record<string, unknown>);
    return {
      value,
      headers: r.headers,
      str(k: string) {
        const v = value[k];
        assert.equal(typeof v, "string", k);
        return v as string;
      },
    };
  };
  const member = (name: string) => ({
    name,
    office: name,
    email: `${name}@example.org`,
    password: "valid-test-password",
  });
  try {
    const owner = await api("POST", "/setup", 201, member("Core"));
    const cookie = owner.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const foreign = await api("POST", "/auth/register", 201, member("Other"));
    const foreignCookie = foreign.headers.get("set-cookie")?.split(";")[0];
    assert.ok(foreignCookie);
    const base = "/offices/core/machine";
    const admin = (method: string, suffix: string, status: number, body?: unknown) =>
      api(method, base + suffix, status, body, "", cookie);
    assert.equal((await admin("GET", "/admission", 200)).value.mode, "closed");
    await api("POST", base + "/trusted", 403, {}, "", foreignCookie);
    await api("POST", base + "/trusted", 401, {});
    await api("GET", base + "/join-key", 403, undefined, "", foreignCookie);
    await api("GET", base + "/join-key", 401);
    await admin("GET", "/join-key", 404);
    // A previous hash-only installation is never silently rotated on read or mode change.
    db.prepare(
      "INSERT INTO machine_admission(org_id,mode,join_hash) SELECT id,'closed','legacy' FROM organizations WHERE slug='core'",
    ).run();
    await admin("GET", "/join-key", 409);
    const join = (await admin("POST", "/join-key", 201, {})).str("token");
    assert.equal((await admin("GET", "/join-key", 200)).str("token"), join);
    await admin("PUT", "/admission", 200, { mode: "open" });
    const producer = secret("producer");
    const enroll = (k: string, t: string, status: number) =>
      api("POST", base + "/enroll", status, { producer_token: t }, k);
    await api("GET", "/machine/enroll", 401, undefined, secret("join"));
    await api("GET", "/machine/enroll", 200, undefined, join);
    const gen = await api("POST", "/machine/enroll", 201, { producer_token: producer }, join);
    assert.equal((await enroll(join, producer, 200)).value.producer_id, gen.value.producer_id);
    assert.equal(gen.value.token, undefined);
    const trusted = await admin("POST", "/trusted", 201, { inbox: true });
    const trustedToken = trusted.str("token");
    const open = (p: string, external: string, writer: string, status: number) =>
      api(
        "POST",
        "/machine/sessions",
        status,
        {
          harness: "pi",
          external_session_id: external,
          name: "Pair",
          project: "same",
          writer_token: writer,
        },
        p,
      );
    const a = secret("writer"),
      b = secret("writer"),
      next = secret("writer");
    await open(join, "no", a, 401);
    const first = await open(producer, "alpha", a, 201);
    const aid = first.str("agent_id");
    assert.equal(first.value.inbox, false);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal((await open(producer, "alpha", a, 200)).value.agent_id, aid);
    await open(producer, "alpha", secret("writer"), 409);
    const bid = (await open(producer, "beta", b, 201)).str("agent_id");
    assert.notEqual(aid, bid);
    const rename = (writer: string, status: number) =>
      api(
        "PATCH",
        `/machine/sessions/${aid}/project`,
        status,
        { project: "Release Notes" },
        writer,
      );
    await rename(b, 401);
    await rename(a, 200);
    const updated = (await api("GET", "/offices/core/snapshot", 200, undefined, "", cookie)).value
      .agents as { id: string; project: string }[];
    assert.equal(updated.find((x) => x.id === aid)?.project, "Release Notes");
    assert.equal(updated.find((x) => x.id === bid)?.project, "same");
    const hb = (id: string, t: string, seq: number, status: number) =>
      api("POST", `/agents/${id}/heartbeat`, status, { seq, state: "working" }, t);
    await hb(aid, a, 1, 200);
    await hb(bid, a, 2, 401);
    await api("GET", `/agents/${aid}/inbox`, 403, undefined, a);
    await api("POST", `/agents/${aid}/inbox/${uuidv7()}/claim`, 403, { run_id: uuidv7() }, a);
    const batch = {
      events: [{ event_id: uuidv7(), type: "run.started", seq: 2, data: { title: "workspace" } }],
    };
    const events = (body: unknown) => api("POST", `/agents/${aid}/events`, 200, body, a);
    assert.equal((await events(batch)).value.accepted, 1);
    assert.equal((await events(batch)).value.duplicate, 1);
    assert.deepEqual(
      (await events({ events: batch.events.map((e) => ({ ...e, seq: 5 })) })).value.accepted,
      0,
    );
    db.prepare("UPDATE machine_sessions SET expires_ms=0 WHERE agent_id=?").run(bid);
    await hb(bid, b, 1, 401);
    const snap = await api("GET", "/offices/core/snapshot", 200, undefined, "", cookie);
    assert.ok(Array.isArray(snap.value.agents));
    assert.equal(
      snap.value.agents.filter((v: { id: string }) => [aid, bid].includes(v.id)).length,
      2,
    );
    assert.ok(!JSON.stringify(snap.value).includes(producer));
    db.close();
    db = await openDb(file);
    app = boot();
    const resume = (p: string, old: string, fresh: string, status: number) =>
      api(
        "POST",
        `/machine/sessions/${aid}/resume`,
        status,
        { writer_token: old, next_writer_token: fresh },
        p,
      );
    const revealed = await admin("GET", "/join-key", 200);
    assert.equal(revealed.str("token"), join);
    assert.equal(revealed.headers.get("cache-control"), "no-store");
    await resume(trustedToken, a, next, 401);
    const resumed = await resume(producer, a, next, 200);
    assert.equal(resumed.value.last_seq, 2);
    assert.equal(resumed.value.generation, 2);
    assert.equal(resumed.value.inbox, false);
    await resume(producer, a, secret("writer"), 401);
    await resume(producer, next, a, 409);
    assert.equal((await open(producer, "alpha", next, 200)).value.generation, 2);
    await hb(aid, a, 3, 401);
    await hb(aid, next, 2, 409);
    await hb(aid, next, 3, 200);
    const rotate = (await admin("POST", "/join-key", 201, {})).str("token");
    await enroll(join, secret("producer"), 401);
    await hb(aid, next, 4, 200);
    await admin("PUT", "/admission", 200, { mode: "closed" });
    await enroll(rotate, secret("producer"), 401);
    await hb(aid, next, 5, 200);
    assert.equal((await admin("GET", "/join-key", 200)).str("token"), rotate);
    const initialWriter = secret("writer"), tw = secret("writer");
    const opened = await open(trustedToken, "alpha", initialWriter, 201);
    const tid = opened.str("agent_id");
    assert.equal(opened.value.inbox, true);
    assert.equal((await open(trustedToken, "alpha", initialWriter, 200)).value.inbox, true);
    const rotated = await api('POST', `/machine/sessions/${tid}/resume`, 200, {writer_token:initialWriter,next_writer_token:tw}, trustedToken);
    assert.equal(rotated.value.inbox, true);
    await hb(tid, tw, 1, 200);
    await api("GET", `/agents/${tid}/inbox`, 200, undefined, tw);
    await api("GET", `/agents/${bid}/inbox`, 401, undefined, tw);
    const ungranted = await admin("POST", "/trusted", 201, {});
    const quiet = secret("writer");
    const quietVisit = await open(ungranted.str("token"), "one", quiet, 201);
    const qid = quietVisit.str("agent_id");
    assert.equal(quietVisit.value.inbox, false);
    await api("GET", `/agents/${qid}/inbox`, 403, undefined, quiet);
    await api('POST','/offices/core/agents',404,{name:'fixed'},'',cookie);
    await admin("DELETE", `/producers/${trusted.str("producer_id")}`, 204);
    assert.ok(!db.prepare('SELECT id FROM agents WHERE id=?').get(tid));
    assert.ok(db.prepare('SELECT id FROM agents WHERE id=?').get(qid));
    await hb(tid, tw, 2, 401);
    await open(trustedToken, "gamma", secret("writer"), 401);
    await admin("PUT", "/admission", 200, { mode: "open" });
    await enroll(rotate, secret("producer"), 201);
    await hb(aid, next, 5, 409);
    const latest = secret("writer");
    await resume(producer, next, latest, 200);
    await hb(aid, latest, 6, 200);
    await api("DELETE", `/machine/sessions/${aid}`, 204, undefined, producer, "", {
      "X-Writer-Token": latest,
    });
    await hb(aid, latest, 6, 401);
    await open(producer, "alpha", latest, 409);
    await resume(producer, latest, secret("writer"), 401);
    // The archived sibling is not a live session; closing the last General session revokes its grant.
    await api('DELETE',`/machine/sessions/${bid}`,204,undefined,producer,'',{'X-Writer-Token':b});
    await open(producer,'new-session',secret('writer'),401);
    await enroll(rotate,producer,401);
    const newKey = (await admin("POST", "/join-key", 201, {})).str("token");
    const replacement = secret("producer");
    const generalId=(await enroll(newKey,replacement,201)).str('producer_id');
    const replacementWriter=secret('writer'), rid=(await open(replacement,'alpha',replacementWriter,201)).str('agent_id');
    assert.notEqual(rid,aid);
    await admin('DELETE',`/producers/${generalId}`,204);
    assert.ok(!db.prepare('SELECT id FROM agents WHERE id=?').get(rid)); await hb(rid,replacementWriter,1,401);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
