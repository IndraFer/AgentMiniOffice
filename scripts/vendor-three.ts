/**
 * Download three.js so the panel can run without any external request.
 *
 * The default is a pinned CDN import map, which is simpler and always current. This script
 * is the escape hatch for intranets, air gapped machines, and anyone who does not want a
 * third party in their trust boundary.
 *
 *   bun run vendor:three
 *
 * Then point the import map at /vendor/three/three.module.js.
 */
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { three?: string };
const version = process.env.THREE_VERSION ?? pkg.three ?? "0.187.0";

const files = [
  ["build/three.module.js", "three.module.js"],
  ["build/three.core.js", "three.core.js"],
] as const;

const target = path.resolve("public/vendor/three");
fs.mkdirSync(target, { recursive: true });

for (const [remote, local] of files) {
  const url = `https://cdn.jsdelivr.net/npm/three@${version}/${remote}`;
  process.stdout.write(`${url} -> ${local} ... `);
  const response = await fetch(url);
  if (!response.ok) {
    console.log(`failed (${response.status})`);
    continue;
  }
  const body = await response.text();
  fs.writeFileSync(path.join(target, local), body);
  console.log(`${Math.round(body.length / 1024)} KB`);
}

console.log(`\nthree@${version} vendored into ${target}`);
console.log("Update the import map in public/index.html to serve from /vendor/three/.");
