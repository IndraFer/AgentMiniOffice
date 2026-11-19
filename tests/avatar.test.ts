import { expect, test } from 'bun:test';
import { createSession } from '../src/lib/sessions';
import { uuidv7 } from '../src/lib/uuid';
import { createOffice } from './helpers';

test('only the same-office Owner can save or reset a visit appearance; readers see the saved variation', async () => {
  const o = await createOffice();
  const other = uuidv7(), now = new Date().toISOString();
  o.db.prepare('INSERT INTO organizations(id,name,slug,created_at) VALUES(?,?,?,?)').run(other,'Other','other',now);
  function member(role:string, org=o.orgId) {
    const id=uuidv7();
    o.db.prepare('INSERT INTO members(id,org_id,email,display_name,role,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(id,org,id+'@example.test','Fixture',role,'unused',now);
    return `amo_session=${createSession(o.db,id,org,60000)}`;
  }
  const owner=member('owner');
  const put=(variation:unknown,cookie=owner,id=o.agentId)=>o.app.request(`/api/v1/offices/test-office/agents/${id}/appearance`,{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({variation})});
  const saved=async()=>(await (await o.snapshot()).json() as {agents:{avatar_variation:number|null}[]}).agents[0]?.avatar_variation;
  try {
    expect(await saved()).toBeNull();
    for(const role of ['viewer','admin']) expect((await put(15,member(role))).status).toBe(403);
    expect((await put(15,member('owner',other))).status).toBe(403);
    expect((await put(15,'')).status).toBe(401);
    for(const invalid of [-1,0,2147483648,1.5,'15']) expect((await put(invalid)).status).toBe(400);
    const foreignId=uuidv7();
    o.db.prepare('INSERT INTO agents(id,org_id,name,kind,created_at) VALUES(?,?,?,?,?)').run(foreignId,other,'pi-test','pi',now);
    expect((await put(15,owner,foreignId)).status).toBe(404);
    expect((await put(15,owner,uuidv7())).status).toBe(404);
    expect((await put(15)).status).toBe(200); expect(await saved()).toBe(15);
    expect((await put(null)).status).toBe(200); expect(await saved()).toBeNull();
    await put(42);
    o.store.heartbeat(o.agentId,o.orgId,{seq:1},Date.now()-91000);
    expect(await saved()).toBe(42); // offline is not removal
    expect((await o.app.request(`/api/v1/offices/test-office/agents/${o.agentId}`,{method:'DELETE',headers:{cookie:owner}})).status).toBe(204);
    expect((await o.heartbeat({seq:2})).status).toBe(200); // a dedicated credential can wake the removed visit
    expect(await saved()).toBeNull();
    await put(42); o.db.prepare('DELETE FROM agents WHERE id=?').run(o.agentId);
    o.db.prepare('INSERT INTO agents(id,org_id,name,kind,created_at) VALUES(?,?,?,?,?)').run(uuidv7(),o.orgId,'pi-test','pi',now);
    expect(await saved()).toBeNull();
  } finally {o.db.close();}
});
