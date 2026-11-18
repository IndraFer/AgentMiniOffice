import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPiZip } from './pi-package-fixture.js';
import { readFile } from 'node:fs/promises';
import { createOffice } from './helpers.ts';
import { hashToken } from '../src/lib/auth.ts';
import { uuidv7 } from '../src/lib/uuid.ts';
import { sceneEntities, stationActivity } from '../public/office-activity.js';
import { createSimulation } from '../public/office-model.js';

test('only the same visit writer can refresh a stale display name without changing the project or ID', async () => {
  const office=await createOffice(), notices=[];
  const unsubscribe=office.live.bus.subscribe(e=>{if(e.event==='roster') notices.push(e.data);});
  try {
    const secret=kind=>`amo_${kind}_${randomBytes(32).toString('base64url')}`;
    const producer=secret('producer'),writer=secret('writer'),external=uuidv7();
    office.db.prepare("INSERT INTO machine_producers(id,org_id,kind,token_hash,inbox) VALUES(?,?,'trusted',?,0)").run(uuidv7(),office.orgId,hashToken(producer));
    const open=(name,writer_token=writer)=>office.app.request('/api/v1/machine/sessions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${producer}`},body:JSON.stringify({visit:true,name,writer_token,harness:'pi',external_session_id:external,project:'Release Notes'})});
    const initial=await open('Pi Session');expect(initial.status).toBe(201);
    const {agent_id}=await initial.json();
    const visit=async()=>(await (await office.snapshot()).json()).agents.find(a=>a.id===agent_id);
    expect((await open('Unrelated',secret('writer'))).status).toBe(409);
    expect((await visit()).name).toBe('Pi Session');
    notices.length=0;
    const reported='project';
    for(let i=0;i<2;i++) expect((await (await open(reported)).json()).agent_id).toBe(agent_id);
    expect(await visit()).toMatchObject({name:reported, project:'Release Notes'});
    expect(notices).toHaveLength(1);expect(notices[0].org_id).toBe(office.orgId);
  } finally { unsubscribe();office.db.close(); }
});

test.each([false,true])('panel task delivery follows the token inbox grant (%s)', async inbox=>{
  const office=await createOffice(), root=await mkdtemp(path.join(tmpdir(),'amo-inbox-'));
  let gets=0; const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{if(r.method==='GET' && r.url.endsWith('/inbox')) gets++;return office.app.fetch(r);}});
  const hooks={}, prompts=[]; let idle=true;
  const ctx={isIdle:()=>idle,hasPendingMessages:()=>false,cwd:root,hasUI:false};
  const origin=`http://127.0.0.1:${server.port}`;
  try {
    const dir=await installPiZip(origin,root), token='amo_producer_'+randomBytes(32).toString('base64url');
    office.db.prepare("INSERT INTO machine_producers(id,org_id,kind,token_hash,inbox) VALUES(?,?,'trusted',?,?)").run(uuidv7(),office.orgId,hashToken(token),Number(inbox));
    await writeFile(path.join(root,'agent-mini-office.json'),JSON.stringify({enabled:true,panelUrl:origin,token,maxRetries:0}),{mode:0o600});
    (await import(pathToFileURL(path.join(dir,'index.ts')).href)).default({on:(k,v)=>hooks[k]=v,registerCommand(){},getSessionName:()=>undefined,sendUserMessage:(p,o)=>{prompts.push(p);expect(o.expandPromptTemplates).toBe(false);}});
    await hooks.session_start({},ctx);
    const agent=office.db.prepare('SELECT agent_id FROM visit_labels').get().agent_id;
    const {createTask}=await import('../src/lib/tasks.ts');
    const add=()=>createTask(office.db,office.orgId,agent,'PRIVATE_TITLE','PRIVATE_BRIEF',0).task.id;
    const state=id=>office.db.prepare('SELECT status,result FROM tasks WHERE id=?').get(id);
    const id=add();idle=false;await hooks.agent_start({},ctx);await hooks.ui_prompt_start({kind:'confirm'},ctx);
    idle=true;await hooks.agent_settled({aborted:false},ctx);expect(state(id).status).toBe('pending');
    await hooks.ui_prompt_end({},ctx);await hooks.session_info_changed({name:'Test'},ctx);
    if(!inbox){expect(gets).toBe(0);expect(prompts).toHaveLength(0);return;}
    expect(state(id).status).toBe('claimed');expect(prompts).toHaveLength(1);expect(prompts[0]).toContain('PRIVATE_BRIEF');
    const finish=async(task,prompt,reply,aborted)=>{
      await hooks.before_agent_start({messageType:'user',prompt},ctx);idle=false;await hooks.agent_start({},ctx);
      await hooks.session_info_changed({name:'Test'},ctx); // no duplicate delivery while active
      await hooks.agent_end({messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:reply}]}]},ctx);
      idle=true;await hooks.agent_settled({aborted},ctx);return state(task).status;
    };
    expect(await finish(id,prompts[0],`PRIVATE_REPLY\nPANEL-TASK-DONE ${id}`,false)).toBe('acked');
    for(const [reply,aborted,foreign] of [['ordinary reply',false,false],['',true,false],['',false,true]]){
      const next=add();await hooks.session_info_changed({name:'Test'},ctx);
      expect(await finish(next,foreign?'unrelated prompt':prompts.at(-1),reply || `PANEL-TASK-DONE ${next}`,aborted)).toBe('failed');
    }
    expect(prompts).toHaveLength(4);expect(JSON.stringify(office.db.prepare('SELECT data FROM events').all())).not.toContain('PRIVATE_');
    expect(JSON.stringify(state(id))).not.toContain('PRIVATE_REPLY');
  }finally{await hooks.session_shutdown?.({},ctx);server.stop(true);office.db.close();await rm(root,{recursive:true,force:true});}
});

test.each(['folder','flat'])('downloaded %s Pi connector maps registered hooks without exposing inputs', async (form) => {
  const office = await createOffice();
  const server = Bun.serve({hostname:'127.0.0.1', port:0, fetch:office.app.fetch});
  const root = await mkdtemp(path.join(tmpdir(),'amo-pi-actions-'));
  const hooks = {}, registry = new Map();
  let latestSignal;
  const unsubscribe=office.live.bus.subscribe(e=>{if(e.event==='signal')latestSignal=e.data.signal;});
  const ctx = {cwd:root,isIdle:()=>false,hasUI:false,sessionManager:{getSessionFile:()=>'/private/session',getSessionId:()=>'fallback'}};
  try {
    const token = 'amo_producer_'+randomBytes(32).toString('base64url');
    office.db.prepare("INSERT INTO machine_producers(id,org_id,kind,token_hash,inbox) VALUES(?,?,'trusted',?,0)").run(uuidv7(),office.orgId,hashToken(token));
    const origin = `http://127.0.0.1:${server.port}`;
    const folder = form === 'folder';
    let ext, mapPath;
    if (folder) {
      const dir = await installPiZip(origin, root);
      ext = path.join(dir,'index.ts'); mapPath = path.join(dir,'actions.json');
    } else {
      ext = path.join(root,'extensions','agent-mini-office.ts');
      mapPath = path.join(root,'agent-mini-office.actions.json');
      await mkdir(path.dirname(ext));
      const download = await fetch(origin+'/downloads/agent-mini-office.ts');
      expect(download.status).toBe(200);
      await writeFile(ext,await download.text());
      await writeFile(path.join(root,'action-v1.json'),await (await fetch(origin+'/schemas/action-v1.json')).text());
    }
    await writeFile(path.join(root,'agent-mini-office.json'),JSON.stringify({enabled:true,panelUrl:`http://127.0.0.1:${server.port}`,token,maxRetries:0}),{mode:0o600});
    const map = folder ? JSON.parse(await readFile(mapPath,'utf8')) : {version:1,tools:{extension:{}}};
    map.tools.extension.web_search={action:'search_web',variant:'laptop_typing'};
    map.tools.extension.private_lookup='lookup_file'; map.tools.sdk={read:'plan'};
    await writeFile(mapPath,JSON.stringify(map));
    if(folder) await writeFile(path.join(root,'agent-mini-office.actions.json'), JSON.stringify({version:1,tools:{builtin:{read:'plan'}}}));
    const {default:init}=await import(pathToFileURL(ext).href);
    const bus = new Map();
    const api={events:{on:(k,v)=>{bus.set(k,v);return ()=>bus.delete(k);}},on:(k,v)=>hooks[k]=v,registerCommand(){},getSessionName:()=>undefined,getAllTools:()=>[...registry.values()]};
    init(api);
    await hooks.session_start({},ctx);
    const sim=createSimulation();
    const currentVisit=async()=>(await (await office.snapshot()).json()).agents.find(a=>a.project==='Renamed Project');
    await hooks.session_info_changed({name:'Renamed Project'},ctx);
    expect((await currentVisit()).name).toBe(path.basename(root));
    const actions={read:'read',ls:'lookup_file',grep:'search_content',find:'lookup_file',powershell:'use_tools',bash:'use_tools',edit:'write',write:'write',ffgrep:'search_content',fffind:'lookup_file',update_plan:'plan',document_screenshot:'print',other:'other'};
    for(const [name,source,expected,room,target,custom] of [
      ['read','builtin','read','library','library'], ['ls','builtin','ls','library','archive'],
      ['grep','builtin','grep','library','library'], ['find','builtin','find','library','archive'],
      ['powershell','builtin','powershell','workshop','workshop'],['bash','builtin','bash','workshop','workshop'],
      ['edit','builtin','edit','desk'],['write','builtin','write','desk'],
      ['ffgrep','local','ffgrep','library','library'],['fffind','local','fffind','library','archive'],
      ['update_plan','local','update_plan','whiteboard','whiteboard'], ['document_screenshot','local','document_screenshot','print-room','printer'],
      ['web_search','local','other','library',null,'search_web'],
      ['read','local','other','lobby'],['private_skill_name','sdk','other','lobby'],
      ['private_lookup','local','other','library','archive','lookup_file'],['read','sdk','other','whiteboard','whiteboard','plan'],
    ]){
      registry.set(name,{name,sourceInfo:{source,path:source==='builtin'?`builtin:${name}`:'/private/plugin.ts'}});
      const event={toolName:name,args:{path:'/private/data',text:'PRIVATE_INPUT'},result:{content:'PRIVATE_RESULT'},isError:false};
      await hooks.tool_execution_start(event,ctx);await hooks.tool_execution_end(event,ctx);
      const rows=office.db.prepare('SELECT agent_id,type,data FROM events ORDER BY rowid DESC LIMIT 2').all();
      const origin=source==='local'?'extension':source;
      for(const [i,row] of rows.entries()){
        expect(row.type).toBe(i===0?'tool.call':'tool.start');
        expect(JSON.parse(row.data)).toEqual({tool:expected,tool_source:origin,action:custom??actions[expected],...(name==='web_search'?{variant:'laptop_typing'}:{}),...(i===0?{ok:true}:{})});
      }
      const snapshot=await (await office.snapshot()).json();const visitor=snapshot.agents.find(a=>a.id===rows[0].agent_id);
      expect(visitor.signal).toEqual(latestSignal);expect(visitor.signal.action).toBe(custom??actions[expected]);
      expect(visitor.signal.tool_source).toBe(origin);
      expect(visitor.presence.room).toBe(room);sim.update([visitor]);for(let j=0;j<180;j++)sim.step(.1);
      if(target)expect(sim.actors.get(visitor.id).target.id).toBe(target);
      if(name==='web_search') {expect(visitor.signal.variant).toBe('laptop_typing');expect(sim.actors.get(visitor.id).target.room).toBe('desk');}
    }
    const idleCtx={...ctx,isIdle:()=>true};
    await hooks.agent_settled({aborted:false},idleCtx);
    await hooks.session_before_compact({get preparation(){throw Error('Private context read');}},idleCtx);
    const compact=await currentVisit();expect(compact.signal.action).toBe('compact_context');expect(compact.presence.heartbeat_state).toBe('working');
    sim.update([compact]);for(let t=0;t<600;t++)sim.step(.1);
    expect(sim.actors.get(compact.id).target.object).toStartWith('archive');
    // Pi emits manual success before clearing isCompacting; there need not be an agent_settled hook.
    let released=false;
    await hooks.session_compact({summary:'PRIVATE_SUMMARY'},{...ctx,isIdle:()=>released});
    released=true;
    for(let n=0;n<25 && (await currentVisit()).presence.heartbeat_state!=='idle';n++)await Bun.sleep(5);
    const settled=await currentVisit();sim.update([settled]);expect(settled.presence.heartbeat_state).toBe('idle');expect(sim.actors.get(compact.id).ambient).toBe(true);
    const note=office.db.prepare('SELECT type,data FROM events ORDER BY rowid DESC LIMIT 1').get();
    expect(note.type).toBe('note');expect(JSON.parse(note.data)).toEqual({kind:'context-compacted'});
    for (const aborted of [false,true]) {
      await hooks.session_before_compact({},idleCtx);
      await hooks.session_compact_failed({aborted,errorMessage:'PRIVATE_ERROR'},idleCtx);
      const ended=await currentVisit();expect(ended.signal.action).toBeUndefined();expect(ended.presence.heartbeat_state).toBe('idle');
      const row=office.db.prepare('SELECT data FROM events ORDER BY rowid DESC LIMIT 1').get();
      expect(JSON.parse(row.data)).toEqual({kind:aborted?'context-compaction-cancelled':'context-compaction-failed'});
    }
    await hooks.session_before_compact({},idleCtx);
    await hooks.agent_start({},ctx);
    const busy=await currentVisit();expect(busy.signal.action).toBeUndefined();expect(busy.presence.heartbeat_state).toBe('working');
    await hooks.tool_execution_start({toolName:'write'},ctx);
    const writing=await currentVisit();expect(writing.signal.action).toBe('write');sim.update([writing]);
    for(let t=0;t<180;t++)sim.step(.1);expect(sim.actors.get(busy.id).target.room).toBe('desk');
    const replies=()=>office.db.prepare("SELECT data FROM events WHERE type='note' AND json_extract(data,'$.kind')='final-response'").all();
    const visitor=currentVisit;
    const text={type:'text',get text(){throw Error('Response content accessed');}};
    for(const [stopReason,aborted,content] of [['toolUse',false,[text]],['error',false,[text]],['stop',true,[text]],['length',false,[text]],['stop',false,[{type:'thinking'}]]]){
      await hooks.agent_start({},ctx);await hooks.agent_end({messages:[{role:'assistant',stopReason,content}]},ctx);
      await hooks.agent_settled({aborted},{...ctx,isIdle:()=>true});
    }
    expect(replies()).toHaveLength(0);
    const stations=[];
    for(let n=0;n<2;n++){
      await hooks.agent_start({},ctx);sim.update([await visitor()]);
      await hooks.agent_end({messages:[{role:'assistant',stopReason:'stop',content:[text]}]},ctx);
      await hooks.agent_settled({aborted:false},{...ctx,isIdle:()=>true});
      const v=await visitor();expect(v.presence.heartbeat_state).toBe('idle');expect(v.signal.detail).toBe('final-response');
      sim.update([v]); const actor=sim.actors.get(v.id);
      for(let i=0;i<220 && !(actor.mode==='standing' && !actor.path.length && actor.finalStop);i++)sim.step(.1);
      expect(actor.target?.id).toBe(actor.finalStop);stations.push(actor.finalStop);
      if(n===0){for(let i=0;i<100;i++)sim.step(.1);sim.update([v]);expect(actor.ambient).toBe(true);}
      else {await hooks.agent_start({},ctx);sim.update([await visitor()]);expect(actor.finalStop).toBeFalsy();expect(actor.ambient).toBe(false);}
    }
    expect(stations.sort()).toEqual(['phone','printer']);
    expect(replies().map(row=>JSON.parse(row.data))).toEqual(Array(2).fill({kind:'final-response',action:'final_response'}));
    await hooks.ui_prompt_start({kind:'confirm',title:'PRIVATE_PROMPT',options:['PRIVATE_OPTION']},ctx);
    expect(stationActivity(await currentVisit()).label).toBe('Waiting for Human · Yes / No');
    await hooks.ui_prompt_end({kind:'confirm',answer:'PRIVATE_ANSWER'},ctx);
    expect((await currentVisit()).signal.options).toBeUndefined();
    const launch = {id:'opaque-child',sessionId:'/private/session',mode:'single',agent:'scout',task:'PRIVATE_TASK'};
    const start = bus.get('subagent:async-started'), end = bus.get('subagent:async-complete');
    await start({...launch,sessionId:'elsewhere'});await start({...launch,mode:'chain'});
    expect((await currentVisit()).runs).toHaveLength(0);
    await start(launch);await start(launch);
    await hooks.tool_execution_end({toolName:'subagent'},ctx);
    const child=sceneEntities([await currentVisit()]).find(a=>a.actorKind==='subagent');
    expect(child.name).toBe(`Sub · ${path.basename(root)}`);expect(child.presence.task).toBe('Delegated work');
    const complete={runId:launch.id,sessionId:launch.sessionId,state:'complete',summary:'PRIVATE_RESULT'};
    await end({...complete,state:'paused'});await end({...complete,sessionId:'elsewhere'});
    expect((await currentVisit()).runs).toHaveLength(2);
    await end(complete);await end(complete);await start(launch);expect((await currentVisit()).runs).toHaveLength(0);
    expect(JSON.stringify(office.db.prepare('SELECT data FROM events').all())).not.toMatch(/PRIVATE_|opaque-child|\/private\/session/);
    // A malformed entry rejects the whole local file, including valid-looking overrides.
    await hooks.session_shutdown({},ctx);
    await writeFile(mapPath,JSON.stringify({version:1,tools:{builtin:{read:'plan',write:'PRIVATE ERROR'}}}));
    init(api);await hooks.session_start({},ctx);registry.set('read',{name:'read',sourceInfo:{source:'builtin',path:'builtin:read'}});
    await hooks.tool_execution_start({toolName:'read'},ctx);expect(latestSignal.action).toBe(folder?'other':'read');
    if(folder){
      await hooks.session_shutdown({},ctx); await rm(mapPath);
      init(api);await hooks.session_start({},ctx);await hooks.tool_execution_start({toolName:'read'},ctx);
      expect(latestSignal.action).toBe('other');
    }
  } finally {
    unsubscribe();await hooks.session_shutdown?.({},ctx); server.stop(true);office.db.close();await rm(root,{recursive:true,force:true});
  }
});
