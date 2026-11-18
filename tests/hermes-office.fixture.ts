// Disposable loopback collector for the Python connector. No host config or database.
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../src/lib/auth';
import { createTask } from '../src/lib/tasks';
import { uuidv7 } from '../src/lib/uuid';
import { createOffice } from './helpers';
const office = await createOffice({leaseSeconds:2});
const token = 'amo_producer_' + randomBytes(32).toString('base64url');
office.db.prepare("INSERT INTO machine_producers(id,org_id,kind,token_hash,inbox) VALUES(?,?,'trusted',?,1)").run(uuidv7(),office.orgId,hashToken(token));
let ackRequests = 0;
const server = Bun.serve({hostname:'127.0.0.1', port:0, async fetch(req) {
  const response = await office.app.fetch(req);
  if (new URL(req.url).pathname.endsWith('/ack') && response.ok && ++ackRequests === 1)
    return new Response('Synthetic lost reply after commit', {status:503});
  return response;
}});
console.log(JSON.stringify({url:server.url.origin,token}));
for await (const line of createInterface({input:process.stdin})) {
  const {op,agent,id} = JSON.parse(line);
  const result = op==='agent' ? office.db.prepare('SELECT agent_id FROM machine_sessions LIMIT 1').get<{agent_id:string}>()?.agent_id
    : op==='task' ? createTask(office.db,office.orgId,agent,'Fixture task','Fixture brief',0).task?.id
    : op==='labels' ? office.db.prepare('SELECT v.name,a.project FROM visit_labels v JOIN agents a ON a.id=v.agent_id WHERE a.id=?').get(agent)
    : op==='acks' ? ackRequests
    : op==='status' ? office.db.prepare('SELECT status FROM tasks WHERE id=?').get<{status:string}>(id)?.status
    : office.db.prepare('SELECT type,data FROM events').all();
  console.log(JSON.stringify(result ?? null));
}
server.stop(true);
