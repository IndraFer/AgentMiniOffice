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
export function staticRoutes(
  publicDir: string,
  publicOfficeName?: (slug: string) => string | undefined,
  embedFrameAncestors = "*",
): Hono {
  const root = path.resolve(publicDir);
  const indexFile = path.join(root, "index.html");
  const app = new Hono();

  function servePage(c: Context, file: string, slug?: string) {
    // Use public metadata only, even when the requester has a member session or share token.
    const url = new URL(c.req.url);
    if (c.req.header('x-forwarded-proto') === 'https') url.protocol = 'https:';
    const name = slug ? publicOfficeName?.(slug) : undefined;
    const values: Record<string, string> = {
      __PUBLIC_ORIGIN__: url.origin,
      __PREVIEW_URL__: `${url.origin}/${name && slug ? encodeURIComponent(slug) : ''}`,
      __PREVIEW_TITLE__: name ? `${name} · Agent Mini Office` : 'Agent Mini Office — a virtual office for coding agents',
    };
    const html = fs.readFileSync(file, 'utf8').replace(/__(?:PUBLIC_ORIGIN|PREVIEW_URL|PREVIEW_TITLE)__/g, key =>
      values[key]!.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
    return c.html(html, 200, { 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'self'" });
  }

  const jsonNotFound = (c: Context, pathname: string) =>
    c.json({ error: { code: "not_found", message: `GET ${pathname} does not exist` } }, 404);

  app.get('/embed/:slug', (c) => {
    c.header('Cache-Control','private, no-store');
    c.header('Referrer-Policy','no-referrer');
    // Public embeds are meant for other sites. A frame-ancestors policy also overrides an
    // X-Frame-Options header added by a reverse proxy, which would otherwise block the frame.
    c.header('Content-Security-Policy', `frame-ancestors ${embedFrameAncestors}`);
    const slug = c.req.param('slug');
    const promotion = '<a class="embed-promo" href="https://github.com/IndraFer/AgentMiniOffice" target="_blank" rel="noopener noreferrer">Get your own Agent Mini Office ↗</a>';
    const embedHead = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Agent Mini Office · Live 3D</title><link rel="stylesheet" href="/styles.css">';
    // Always ship the same empty set, never an image of the last live frame.
    const placeholder = (message: string) => `<div class="embed-message"><img src="/img/empty-office.webp" width="1200" height="760" alt=""><div class="embed-message-card"><p role="status">${message}</p>${promotion}</div></div>`;
    if (!publicOfficeName?.(slug)) return c.html(`<!doctype html><html lang="en"><head>${embedHead}</head><body class="office-embed"><main>${placeholder('Office is private or unavailable.')}</main></body></html>`,404);
    // Use the host's Three.js import map, including any self-hosted vendor override.
    const map = fs.readFileSync(indexFile,'utf8').match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0] ?? '';
    return c.html(`<!doctype html><html lang="en"><head>${embedHead}${map}</head><body class="office-embed"><main class="stage" aria-label="Live virtual office"></main>${placeholder('Loading office…')}<a class="embed-credit" href="/${encodeURIComponent(slug)}" target="_blank" rel="noopener noreferrer" aria-label="Open the public office in Agent Mini Office (new tab)">Agent Mini Office ↗</a><script type="module" src="/embed.js"></script></body></html>`);
  });

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
    if (path.extname(pathname) === "") {
      const slug = /^\/([^/]+)\/?$/.exec(pathname)?.[1];
      return servePage(c, indexFile, slug === 'dashboard' ? undefined : slug);
    }

    return jsonNotFound(c, pathname);
  });

  return app;
}
