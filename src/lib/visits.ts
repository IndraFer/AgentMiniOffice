import type { Db } from './db';
import type { Live } from './live';

interface Candidate { producer_id:string|null; id:string; created_at:string; dedicated:number; archived_at:string|null; dormant:number }
// A long-lived grant is not a writer lease, a simulator or a name convention.
const candidates = `SELECT s.producer_id,a.id,a.created_at,a.archived_at,d.agent_id IS NOT NULL AS dormant,
  (a.simulator=0 AND s.agent_id IS NULL AND EXISTS(SELECT 1 FROM agent_tokens t WHERE t.org_id=a.org_id AND t.agent_id=a.id AND t.revoked_at IS NULL AND t.prefix='amo_agen')) AS dedicated
  FROM agents a LEFT JOIN machine_sessions s ON s.agent_id=a.id LEFT JOIN dormant_dedicated d ON d.agent_id=a.id WHERE a.org_id=?`;

function transaction(db:Db, fn:()=>void) {
  db.exec('BEGIN IMMEDIATE');
  try { fn(); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; }
}

/** Call inside the transaction that removes or closes a specific connector session.
 * An offline sibling still owns a session; an archived (closed) one does not. */
export function revokeIfLastSession(db:Db, org:string, producer:string) {
  db.prepare(`UPDATE machine_producers SET revoked_at=? WHERE id=? AND org_id=? AND revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM machine_sessions s JOIN agents a ON a.id=s.agent_id
      WHERE s.producer_id=machine_producers.id AND a.archived_at IS NULL)`).run(new Date().toISOString(),producer,org);
}

function remove(db:Db, live:Live, org:string, row:Candidate) {
  // Do not follow a cascading run FK into another worker's history.
  db.prepare('UPDATE runs SET parent_run_id=NULL WHERE agent_id<>? AND parent_run_id IN (SELECT id FROM runs WHERE agent_id=?)').run(row.id,row.id);
  if (!row.dedicated || row.archived_at) {
    db.prepare('DELETE FROM agents WHERE org_id=? AND id=?').run(org,row.id);
    if(row.producer_id) revokeIfLastSession(db,org,row.producer_id);
    return;
  }
  // Keep the credential anchor, scopes and replay watermark, but no roster entry or workload.
  db.prepare('INSERT INTO dormant_dedicated(agent_id,last_seq) VALUES(?,?)').run(row.id,live.store.lastSeq(row.id));
  db.prepare('UPDATE agents SET archived_at=? WHERE org_id=? AND id=?').run(new Date().toISOString(),org,row.id);
  for (const sql of ['DELETE FROM tasks WHERE agent_id=?','DELETE FROM events WHERE agent_id=?',
    'DELETE FROM runs WHERE agent_id=?','DELETE FROM daily_aggregates WHERE agent_id=?',
    'DELETE FROM agent_presence WHERE agent_id=?','DELETE FROM visit_labels WHERE agent_id=?']) db.prepare(sql).run(row.id);
}

function notify(live:Live,org:string,rows:Candidate[]) {
  for (const row of rows) live.store.forget(row.id);
  if (rows.length) { live.bus.publish({event:'roster',data:{org_id:org}}); live.countersFor(org); }
}

export function deleteOffline(db:Db,live:Live,org:string,id:string) {
  const row=db.prepare(candidates+' AND a.id=? AND a.archived_at IS NULL').get<Candidate>(org,id);
  if (!row) return 'missing';
  if (!(live.store.offlineAt(id,row.created_at)<=Date.now())) return 'not_offline';
  transaction(db,()=>remove(db,live,org,row)); notify(live,org,[row]); return 'deleted';
}

export function pruneOffline(db:Db,live:Live,org:string,minutes:number,dedicatedMinutes:number,now=Date.now()) {
  const expired=db.prepare(candidates).all<Candidate>(org).filter(row=> {
    if (row.dormant) return !row.dedicated; // final grant was revoked
    const offline=live.store.offlineAt(row.id,row.created_at);
    return now>=offline+(row.dedicated?dedicatedMinutes:minutes)*60000;
  });
  if (expired.length) transaction(db,()=>{for(const row of expired) remove(db,live,org,row);});
  // Also retire abandoned disposable enrollments that never opened a session.
  db.prepare(`UPDATE machine_producers SET revoked_at=? WHERE org_id=? AND revoked_at IS NULL AND id IN (SELECT producer_id FROM visit_enrollments WHERE created_ms<=?) AND NOT EXISTS(SELECT 1 FROM machine_sessions WHERE producer_id=machine_producers.id)`).run(new Date(now).toISOString(),org,now-minutes*60000);
  notify(live,org,expired);
}

export function revokeProducer(db:Db,live:Live,org:string,id:string) {
  const rows=db.prepare(candidates+' AND s.producer_id=?').all<Candidate>(org,id);
  let changed=false;
  transaction(db,()=>{
    changed=!!db.prepare('UPDATE machine_producers SET revoked_at=? WHERE org_id=? AND id=? AND revoked_at IS NULL').run(new Date().toISOString(),org,id).changes;
    if(changed) for(const row of rows) remove(db,live,org,row);
  });
  if(changed) notify(live,org,rows);
  return changed;
}

/** Called synchronously only after heartbeat authentication, scope and sequence checks. */
export function wakeDedicated(db:Db,org:string,id:string,seq:number) {
  transaction(db,()=>{
    // Preserve replay protection across a restart before the next presence flush.
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO agent_presence(agent_id,org_id,state,room,last_seq,last_seen_at,online_since,updated_at) VALUES(?,?,'online','desk',?,?,?,?)`).run(id,org,seq,now,now,now);
    db.prepare('UPDATE agents SET archived_at=NULL WHERE org_id=? AND id=? AND EXISTS(SELECT 1 FROM dormant_dedicated WHERE agent_id=agents.id)').run(org,id);
    db.prepare('DELETE FROM dormant_dedicated WHERE agent_id=?').run(id);
  });
}
