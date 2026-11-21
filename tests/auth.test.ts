import { describe, expect, test } from "bun:test";
import { hashPassword } from "../src/lib/passwords";
import { uuidv7 } from "../src/lib/uuid";
import { createOffice } from "./helpers";

interface ErrorBody {
  error: { code: string };
}

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery";

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function officeWithOwner(options: Parameters<typeof createOffice>[0] = {}) {
  const office = await createOffice(options);
  office.db
    .prepare(
      `INSERT INTO members (id, org_id, email, display_name, role, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      uuidv7(),
      office.orgId,
      EMAIL,
      "Owner",
      "owner",
      hashPassword(PASSWORD),
      new Date().toISOString(),
    );
  return office;
}

function jsonRes(body: unknown) {
  return { "content-type": "application/json", body: JSON.stringify(body) };
}

async function signIn(office: Awaited<ReturnType<typeof createOffice>>, password = PASSWORD) {
  return office.app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
}

test("rename changes only the display name and requires this office's Owner", async () => {
  const office = await officeWithOwner();
  try {
    const cookie = cookieOf(await signIn(office));
    const rename = (body: unknown, slug = "test-office", session = cookie) =>
      office.app.request(`/api/v1/offices/${slug}`, {
        method: "PATCH",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await rename({ name: "No" }, "test-office", "")).status).toBe(401);
    office.db
      .prepare("INSERT INTO organizations (id,name,slug,created_at) VALUES (?,?,?,?)")
      .run(uuidv7(), "Other", "other", new Date().toISOString());
    expect((await rename({ name: "No" }, "other")).status).toBe(403);
    for (const body of [
      { name: "  " },
      { name: "x".repeat(33) },
      { name: 7 },
      { name: "OK", slug: "changed" },
    ])
      expect((await rename(body)).status).toBe(400);
    expect((await rename({ name: "  KoiN Studio  " })).status).toBe(200);
    for (const role of ["admin", "viewer"]) {
      office.db.prepare("UPDATE members SET role = ? WHERE email = ?").run(role, EMAIL);
      expect((await rename({ name: "Denied" })).status).toBe(403);
    }
    const response = await office.app.request(
      `/api/v1/offices/test-office/snapshot?share=${office.shareToken}`,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { org: { name: string } }).org.name).toBe("KoiN Studio");
  } finally {
    office.db.close();
  }
});

test.each(["/setup", "/auth/register"])(
  "%s rejects 33 characters without truncation and accepts 32",
  async (route) => {
    const office = await createOffice({ allowRegistration: true });
    try {
      const create = (length: number) =>
        office.app.request(`/api/v1${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: EMAIL,
            password: PASSWORD,
            name: "Owner",
            office: "X".repeat(length),
          }),
        });
      expect((await create(33)).status).toBe(400);
      expect((await create(32)).status).toBe(201);
    } finally {
      office.db.close();
    }
  },
);

describe("first run setup", () => {
  test("config reports needs_setup only while no account exists", async () => {
    const fresh = await createOffice();
    const a = (await (await fresh.app.request("/api/v1/config")).json()) as {
      needs_setup: boolean;
    };
    expect(a.needs_setup).toBe(true);

    const withOwner = await officeWithOwner();
    const b = (await (await withOwner.app.request("/api/v1/config")).json()) as {
      needs_setup: boolean;
    };
    expect(b.needs_setup).toBe(false);
  });

  test("creates the first administrator and signs them in", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Indra",
        email: "first@example.com",
        password: "kopi-susu-1234",
        office: "KoiN Studio",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { office: { slug: string }; member: { role: string } };
    expect(body.office.slug).toBe("koin-studio");
    expect(body.member.role).toBe("owner");

    const cookie = cookieOf(res);
    const me = await office.app.request("/api/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);

    const again = (await (await office.app.request("/api/v1/config")).json()) as {
      needs_setup: boolean;
    };
    expect(again.needs_setup).toBe(false);
  });

  test("closes permanently once an administrator exists", async () => {
    const office = await createOffice();
    const payload = {
      name: "One",
      email: "one@example.com",
      password: "kopi-susu-1234",
      office: "One Office",
    };

    expect(
      (
        await office.app.request("/api/v1/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
    ).toBe(201);

    const second = await office.app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, email: "two@example.com", office: "Two Office" }),
    });
    expect(second.status).toBe(403);
    expect(((await second.json()) as ErrorBody).error.code).toBe("forbidden");
  });

  test("rejects a weak password without creating anything", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Weak",
        email: "weak@example.com",
        password: "short",
        office: "Weak Office",
      }),
    });

    expect(res.status).toBe(400);
    const config = (await (await office.app.request("/api/v1/config")).json()) as {
      needs_setup: boolean;
    };
    expect(config.needs_setup).toBe(true);
  });
});

describe("config", () => {
  test("reports whether registration is open", async () => {
    const closed = await createOffice();
    const a = (await (await closed.app.request("/api/v1/config")).json()) as {
      allow_registration: boolean;
    };
    expect(a.allow_registration).toBe(false);

    const open = await createOffice({ allowRegistration: true });
    const b = (await (await open.app.request("/api/v1/config")).json()) as {
      allow_registration: boolean;
    };
    expect(b.allow_registration).toBe(true);
  });
});

describe("login", () => {
  test("signs in and returns the office", async () => {
    const office = await officeWithOwner();
    const res = await signIn(office);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { member: { email: string }; office: { slug: string } };
    expect(body.member.email).toBe(EMAIL);
    expect(body.office.slug).toBe("test-office");
    expect(cookieOf(res)).toContain("amo_session=");
  });

  test("rejects a wrong password and an unknown email with the same answer", async () => {
    const office = await officeWithOwner();
    const wrong = await signIn(office, "nope-nope-nope");
    expect(wrong.status).toBe(401);

    const unknown = await office.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ghost@example.com", password: PASSWORD }),
    });
    expect(unknown.status).toBe(401);

    const a = (await wrong.json()) as { error: { message: string } };
    const b = (await unknown.json()) as { error: { message: string } };
    expect(a.error.message).toBe(b.error.message);
  });

  test("throttles repeated failures with a growing wait", async () => {
    const office = await officeWithOwner();

    // A dedicated account, so this test cannot throttle the others that share EMAIL.
    const throttled = "throttle@example.com";
    office.db
      .prepare(
        `INSERT INTO members (id, org_id, email, display_name, role, password_hash, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        uuidv7(),
        office.orgId,
        throttled,
        "Throttled",
        "owner",
        hashPassword(PASSWORD),
        new Date().toISOString(),
      );

    const attempt = (password: string) =>
      office.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: throttled, password }),
      });

    for (let index = 0; index < 5; index++) {
      expect((await attempt("definitely-wrong")).status).toBe(401);
    }

    // Sixth attempt is refused before the password is even checked.
    const blocked = await attempt("definitely-wrong");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // The correct password is refused too while the throttle is active.
    expect((await attempt(PASSWORD)).status).toBe(429);
  });

  test("me works with the session cookie and fails without it", async () => {
    const office = await officeWithOwner();
    const login = await signIn(office);
    const cookie = cookieOf(login);

    const me = await office.app.request("/api/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);

    const anonymous = await office.app.request("/api/v1/auth/me");
    expect(anonymous.status).toBe(401);
  });

  test("logout revokes the session server side", async () => {
    const office = await officeWithOwner();
    const cookie = cookieOf(await signIn(office));

    await office.app.request("/api/v1/auth/logout", { method: "POST", headers: { cookie } });

    const me = await office.app.request("/api/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});

describe("registration", () => {
  test("is closed by default", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "new@example.com",
        password: "a-long-password",
        name: "New",
        office: "New Office",
      }),
    });
    expect(res.status).toBe(403);
  });

  test("creates an office and a session when allowed", async () => {
    const office = await createOffice({ allowRegistration: true });
    const res = await office.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "new@example.com",
        password: "a-long-password",
        name: "New Person",
        office: "Studio Satu",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { office: { slug: string } };
    expect(body.office.slug).toBe("studio-satu");

    const me = await office.app.request("/api/v1/auth/me", {
      headers: { cookie: cookieOf(res) },
    });
    expect(me.status).toBe(200);
  });

  test("refuses a short password and a duplicate email", async () => {
    const office = await createOffice({ allowRegistration: true });
    const short = await office.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "short", name: "A", office: "A" }),
    });
    expect(short.status).toBe(400);

    const first = await office.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "dup@example.com",
        password: "a-long-password",
        name: "Dup",
        office: "One",
      }),
    });
    expect(first.status).toBe(201);

    const duplicate = await office.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "dup@example.com",
        password: "a-long-password",
        name: "Dup",
        office: "Two",
      }),
    });
    expect(duplicate.status).toBe(409);
  });
});

describe("office view access", () => {
  test("a private office needs a session or a share link", async () => {
    const office = await officeWithOwner();
    const slug = "test-office";

    expect((await office.app.request(`/api/v1/offices/${slug}/snapshot`)).status).toBe(401);

    const cookie = cookieOf(await signIn(office));
    for (const path of ['snapshot','stream']) {
      const embedded = await office.app.request(`/api/v1/offices/${slug}/${path}?view=embed&share=${office.shareToken}`, {headers:{cookie}});
      expect(embedded.status).toBe(401);
    }
    const shell = await office.app.request(`/embed/${slug}?share=${office.shareToken}`, {headers:{cookie}});
    expect(shell.status).toBe(404);
    expect(await shell.text()).not.toContain('pi-test');
    const asMember = await office.app.request(`/api/v1/offices/${slug}/snapshot`, {
      headers: { cookie },
    });
    expect(asMember.status).toBe(200);

    const viaShare = await office.app.request(
      `/api/v1/offices/${slug}/snapshot?share=${office.shareToken}`,
    );
    expect(viaShare.status).toBe(200);
  });

  test('only an Owner can toggle Public View; Off cuts an open guest stream but keeps private links', async () => {
    const office = await officeWithOwner(), cookie = cookieOf(await signIn(office));
    const base = '/api/v1/offices/test-office';
    const toggle = (enabled: boolean, signedIn = true) => office.app.request(`${base}/public-view`, {
      method:'PUT', headers:{'content-type':'application/json', ...(signedIn ? {cookie} : {})}, body:JSON.stringify({enabled})});
    expect((await toggle(true,false)).status).toBe(401);
    for (const role of ['admin','viewer']) {
      office.db.prepare('UPDATE members SET role=? WHERE email=?').run(role,EMAIL);
      expect((await toggle(true)).status).toBe(403);
    }
    office.db.prepare("UPDATE members SET role='owner' WHERE email=?").run(EMAIL);
    expect((await toggle(true)).status).toBe(200);
    expect((await office.app.request(`${base}/snapshot`)).status).toBe(200);
    const guest=(await office.app.request(`${base}/stream`)).body!.getReader();
    const embed=(await office.app.request(`${base}/stream?view=embed&share=${office.shareToken}`,{headers:{cookie}})).body!.getReader();
    const shared=(await office.app.request(`${base}/stream?share=${office.shareToken}`)).body!.getReader();
    try {
      await guest.read(); await shared.read(); await embed.read();
      const page=await office.app.request('/embed/test-office');
      expect(page.headers.get('cache-control')).toContain('no-store');
      const html=await page.text(); expect(html).toContain('/embed.js'); expect(html).not.toContain('/app.js');
      expect((await toggle(false)).status).toBe(200);
      office.live.bus.publish({event:'roster',data:{org_id:office.orgId,fixture:'post-disable'}});
      expect(new TextDecoder().decode((await guest.read()).value)).toContain('access-revoked');
      expect((await guest.read()).done).toBe(true);
      expect(new TextDecoder().decode((await embed.read()).value)).toContain('access-revoked');
      expect((await embed.read()).done).toBe(true);
      expect(new TextDecoder().decode((await shared.read()).value)).toContain('post-disable');
      expect((await office.app.request(`${base}/snapshot`)).status).toBe(401);
      expect((await office.app.request(`${base}/stream`)).status).toBe(401);
      expect((await office.app.request(`${base}/snapshot?share=${office.shareToken}`)).status).toBe(200);
    } finally { await guest.cancel(); await shared.cancel(); await embed.cancel(); }
  });

  test("an unknown slug is a 404, not a 401", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/offices/nope/snapshot");
    expect(res.status).toBe(404);
  });

  test("an agent token cannot read the office view", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/offices/test-office/snapshot", {
      headers: { authorization: `Bearer ${office.agentToken}` },
    });
    expect(res.status).toBe(401);
  });
});

test("even an Owner cannot register a permanent agent",async()=>{
  const office=await officeWithOwner();const cookie=cookieOf(await signIn(office));
  expect((await office.app.request('/api/v1/offices/test-office/agents',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({name:'fixed'})})).status).toBe(404);
});

describe("routes", () => {
  test("/dashboard and /<slug> serve the shell", async () => {
    const office = await createOffice();
    for (const path of ["/dashboard", "/test-office"]) {
      const res = await office.app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("AgentMiniOffice");
    }
  });

  test("an unknown api path stays JSON", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/offices/test-office/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
