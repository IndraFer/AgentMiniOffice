// Install only the archive linked by the served guide, in the caller's disposable Pi root.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function installPiZip(origin, root) {
  const guide = await (await fetch(`${origin}/guides/integrations.html`)).text();
  const href = guide.match(/download="agent-mini-office.zip" href="([^"]+)"/)?.[1];
  assert.equal(href, '/downloads/agent-mini-office.zip');
  const res = await fetch(origin + href);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert(bytes.equals(await readFile('public/downloads/agent-mini-office.zip')));
  const extensions = path.join(root, 'extensions'), archive = path.join(root, 'download.zip');
  await mkdir(extensions, {recursive:true});
  await writeFile(archive, bytes);
  const files = {
    'index.ts': 'integrations/pi/agent-mini-office/index.ts',
    'actions.json': 'integrations/pi/agent-mini-office/actions.json',
    'actions.example.json': 'public/downloads/examples/pi-tool-map.json',
    'actions.schema.json': 'public/schemas/pi-action-map-v1.json',
    'action-v1.json': 'public/schemas/action-v1.json',
  };
  assert.deepEqual(execFileSync('unzip', ['-Z1', archive], {encoding:'utf8'}).trim().split('\n').sort(), Object.keys(files).map(n=>`agent-mini-office/${n}`).sort());
  execFileSync('unzip', ['-q', archive, '-d', extensions]);
  const dir = path.join(extensions, 'agent-mini-office');
  for (const [name, source] of Object.entries(files)) assert((await readFile(path.join(dir,name))).equals(await readFile(source)), `stale ZIP entry: ${name}`);
  return dir;
}
