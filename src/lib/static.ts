import fs from "node:fs";
import path from "node:path";
import { type Context, Hono } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the UI from public/, with client routes falling back to the shell.
 *
 * Hand rolled on node:fs instead of a static middleware, because middleware static handlers tend to
 * be runtime specific and the dual runtime rule is not worth weakening for a convenience.
 *
 * Routing rules, in order:
 *   /api/*            JSON 404, so an API typo never returns HTML
 *   an existing file  served with its content type
 *   a path without an extension  the shell (/ , /dashboard , /<slug>)
 *   anything else     JSON 404
 */
export function staticRoutes(publicDir: string): Hono {
  const root = path.resolve(publicDir);
  const indexFile = path.join(root, "index.html");
  const app = new Hono();

  function servePage(c: Context, file: string) {
    // Use only the request origin, never the office slug, query string or proxy-supplied host.
    const url = new URL(c.req.url);
    if (c.req.header('x-forwarded-proto') === 'https') url.protocol = 'https:';
    const origin = url.origin.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const html = fs.readFileSync(file, 'utf8').replaceAll('__PUBLIC_ORIGIN__', () => origin);
    return c.html(html, 200, { 'cache-control': 'no-store' });
  }

  const jsonNotFound = (c: Context, pathname: string) =>
    c.json({ error: { code: "not_found", message: `GET ${pathname} does not exist` } }, 404);

  app.get("*", (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("bad request", 400);
    }

    if (pathname.startsWith("/api/")) return jsonNotFound(c, pathname);

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const resolved = path.resolve(root, relative);

    // Traversal guard. Anything that escapes public/ is not found, not served.
    if (!resolved.startsWith(`${root}${path.sep}`)) return c.text("not found", 404);

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(resolved);
    } catch {
      stat = null;
    }

    if (stat?.isFile()) {
      const extension = path.extname(resolved).toLowerCase();
      if (extension === '.html') return servePage(c, resolved);
      return new Response(fs.readFileSync(resolved), {
        headers: {
          "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
          "cache-control": relative.startsWith("downloads/") ? "no-store" : "public, max-age=60",
        },
      });
    }

    // Client routes: /dashboard and /<slug> both render the same shell.
    if (path.extname(pathname) === "") return servePage(c, indexFile);

    return jsonNotFound(c, pathname);
  });

  return app;
}
