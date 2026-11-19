import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createOffice } from "./helpers";

describe("static files", () => {
  test("serves the panel shell at the root", async () => {
    const office = await createOffice();
    const res = await office.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("AgentMiniOffice");
    expect(body).toContain("/app.js");
    // The shell must never be cached, or a stale UI outlives a deploy.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test('social cards are available before JavaScript and never echo a share link', async () => {
    const { app } = await createOffice();
    for (const route of ['/', '/dashboard', '/test-office?share=private-preview-token', '/guides/integrations.html']) {
      const html = await (await app.request(`http://office.example${route}`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'untrusted.example' } })).text();
      const image = html.match(/property="og:image" content="([^"]+)"/)?.[1];
      expect(image).toBe('https://office.example/img/virtual-office-og.jpg');
      expect(html).toContain(`name="twitter:image" content="${image}"`);
      expect(html).toContain('name="description"');
      expect(html).toContain('rel="apple-touch-icon"');
      expect(html).toContain(`property="og:url" content="https://office.example${route.startsWith('/guides/') ? route : '/'}"`);
      expect(html).not.toContain('private-preview-token');
    }
    for (const [asset, mime] of [['/img/virtual-office-og.jpg', 'image/jpeg'], ['/favicon.ico', 'image/x-icon']] as const) {
      const response = await app.request(asset);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(mime);
    }
  });

  test("serves assets with the right content type", async () => {
    const office = await createOffice();
    const css = await office.app.request("/styles.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const js = await office.app.request("/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
  });

  test('the guide downloads the canonical Pi extension without caching an old build',async()=>{
    const {app}=await createOffice(); const guide=await (await app.request('/guides/integrations.html')).text();
    const url=guide.match(/download="agent-mini-office\.ts" href="([^"]+)"/)?.[1];
    expect(url).toBe('/downloads/agent-mini-office.ts'); const file=await app.request(url!);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(fs.readFileSync('public/downloads/agent-mini-office.ts'))).toBe(true);
    expect(file.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/downloads/agentminioffice.ts')).status).toBe(404);
  });

  test('official docs expose the folder install and readable examples without JavaScript', async () => {
    const {app}=await createOffice();
    const guide=await (await app.request('/guides/integrations.html')).text();
    expect(guide).toContain('download="agent-mini-office.zip"');
    const archive=await app.request('/downloads/agent-mini-office.zip');
    expect(archive.status).toBe(200);expect(archive.headers.get('cache-control')).toBe('no-store');
    expect(archive.headers.get('content-type')).toBe('application/zip');
    for (const [,url,text] of guide.matchAll(/data-example="([^"]+)"><code>([\s\S]*?)<\/code>/g)) {
      const file=await app.request(url!);expect(file.status).toBe(200);
      expect(JSON.parse(text!)).toEqual(await file.json());
    }
    expect(guide.match(/data-example=/g)?.length).toBeGreaterThanOrEqual(4);
    expect(guide.match(/<a\b(?![^>]*\bdownload\b)[^>]*href="[^"]+\.json"/g) ?? []).toEqual([]);
  });

  test("the API wins over the static fallback", async () => {
    const office = await createOffice();
    const res = await office.app.request(`/api/v1/snapshot?share=${office.shareToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const missing = await office.app.request("/api/v1/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  });

  test("never leaks a file from outside the public directory", async () => {
    const office = await createOffice();
    for (const attempt of [
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/../../package.json",
      "/%2e%2e/package.json",
    ]) {
      const res = await office.app.request(attempt);
      const body = await res.text();

      // The URL parser normalises dot segments away, so the only two acceptable answers are a
      // 404 or the app shell for a client route. Never file contents from outside public/.
      expect(body).not.toContain("root:");
      expect(body).not.toContain('"name": "agentminioffice"');
      if (res.status === 200) expect(body.toLowerCase()).toContain("<!doctype html>");
      else expect(res.status).toBe(404);
    }
  });

  test("missing asset is a JSON 404, not an HTML error page", async () => {
    const office = await createOffice();
    const res = await office.app.request("/nope.css");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("ui safety", () => {
  test("the panel builds text nodes instead of injecting HTML", () => {
    const source = fs.readFileSync(path.resolve("public/app.js"), "utf8");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
    expect(source).not.toContain("document.write");
  });

  test("the client script parses", () => {
    // A syntax error here once shipped because tests only read the file as text.
    const source = fs.readFileSync(path.resolve("public/app.js"), "utf8");
    // Parse as ESM: the panel now shares a pure projection module with the scene tests.
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(source)).not.toThrow();
  });

  test("every request goes through one helper, with no absolute origin", () => {
    const source = fs.readFileSync(path.resolve("public/app.js"), "utf8");

    // One fetch, inside api(). Anything else would bypass the cookie and error handling.
    expect(source.match(/fetch\(/g) ?? []).toHaveLength(1);
    expect(source).toContain("async function api(");

    // Office pages read snapshot and stream only.
    expect(source).toContain("/snapshot");
    expect(source).toContain("/stream");
    expect(source).toContain("/api/v1/offices/");

    // Never build a request against a hardcoded origin. The SVG XML namespace is not a network URL.
    const withoutSvgNamespace = source.replace(/"http:\/\/www\.w3\.org\/2000\/svg"/g, '""');
    expect(withoutSvgNamespace).not.toMatch(/"https?:\/\//);
  });

  test("the shell references three and nothing else external", () => {
    const html = fs.readFileSync(path.resolve("public/index.html"), "utf8");
    const urls = html.match(/https?:\/\/[^"'\s]+/g) ?? [];
    const allowed = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.\d+\.\d+\//;

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(allowed);

    // A floating version would break on the next minor.
    expect(html).not.toMatch(/three@latest/);
  });

  test("the 3D module stays vanilla and dependency free", () => {
    const source = fs.readFileSync(path.resolve("public/scene3d.js"), "utf8");
    expect(source).toContain('from "three"');
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
    expect(source).toContain("prefers-reduced-motion");
    expect(source).toContain("dispose");
  });
});
