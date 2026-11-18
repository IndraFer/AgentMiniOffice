import {expect,test} from 'bun:test';
import {createOffice,event} from './helpers.ts';
import {createSimulation,hash} from '../public/office-model.js';
import {stationActivity} from '../public/office-activity.js';

test('explicit variants survive REST and broadcast; busy stations use same-action catalogue fallbacks and reclaim the preferred slot',async()=>{
  const o=await createOffice(), signals=[];const off=o.live.bus.subscribe(e=>{if(e.event==='signal')signals.push(e.data.signal)});
  try {
    await o.heartbeat({seq:1,state:'working'});
    for(const data of [{variant:'laptop_typing'},{action:'read',variant:'bench_tools'},{action:'search_web',variant:null}]) {
      const r=await (await o.events([event(2,'note',data)])).json(); expect(r.rejected[0]?.code).toBe('invalid_variant');
    }
    const sim=createSimulation();const advance=()=>{for(let i=0;i<800;i++)sim.step(.1)};
    async function send(seq,variant){const r=await (await o.events([event(seq,'tool.start',{action:'search_web',variant})])).json();expect(r.accepted).toBe(1);
      const a=(await (await o.snapshot()).json()).agents[0];expect(a.signal.variant).toBe(variant);expect(a.signal).toEqual(signals.at(-1));return a;}
    let a=await send(2,'laptop_typing');sim.update([a]);advance();const actor=sim.actors.get(a.id);
    expect(actor.target.room).toBe('desk');expect(actor.mode).toBe('seated');expect(actor.room).toBe('library');
    const desks=Array.from({length:6},(_,i)=>({...a,id:`desk-${i}`,presence:{...a.presence,room:'desk'},signal:{action:'write'}}));
    sim.update([a,...desks]);advance();expect(actor.target.id).toBe('library');expect(actor.data.signal.variant).toBe('laptop_typing');
    const readers=Array.from({length:3},(_,i)=>({...a,id:`reader-${i}`,signal:{action:'read'}}));
    sim.update([...desks,...readers],false);advance();sim.update([...desks,...readers,a]);advance();
    const queued=sim.actors.get(a.id);expect(queued.mode).toBe('waiting');expect(queued.target.room).toBe('lobby');
    sim.update([a],false);advance();expect(queued.mode).toBe('seated');expect(queued.target.room).toBe('desk');
    a=await send(3,'shelf_reading');const shelf={...a,id:'reader',signal:{action:'read'}};sim.update([shelf],false);advance();sim.update([shelf,a]);advance();
    expect(sim.actors.get(a.id).target.object).toStartWith('archive');
    sim.update([a],false);advance();expect(sim.actors.get(a.id).target.id).toBe('library');
    a=await send(4,'laptop_typing');sim.update([a]);advance();expect(sim.actors.get(a.id).target.room).toBe('desk');
  } finally {off();o.db.close();}
});

test('a plain REST sender controls the action; unknown actions use a stable neutral object', async()=>{
  const o=await createOffice(); const signals=[]; const off=o.live.bus.subscribe(e=>{if(e.event==='signal') signals.push(e.data.signal);});
  try {
    await o.heartbeat({seq:1,state:'working'});
    const sim=createSimulation(), run=async(seq,data,extra={})=>{
      const reply=await (await o.events([event(seq,'note',data,extra)])).json();expect(reply.accepted).toBe(1);
      const a=(await (await o.snapshot()).json()).agents[0];expect(signals.at(-1)).toEqual(a.signal);
      sim.update([a]);for(let n=0;n<220;n++)sim.step(.1);return {a,actor:sim.actors.get(a.id)};
    };
    let {a,actor}=await run(2,{action:'lookup_file',tool:'bash'},{room:'desk'});
    expect(a.signal.action).toBe('lookup_file');expect(a.presence.room).toBe('library');expect(actor.target.object).toStartWith('archive');
    ({a,actor}=await run(3,{action:'search_content',tool:'ls'}));expect(actor.target.id).toBe('library');
    ({a,actor}=await run(4,{action:'custom_operation',tool:'export'}));expect(a.signal.action).toBe('other');expect(stationActivity(a).label).toBe('Other Activity');
    const target=actor.target;expect(['board-view','ambient-plant','aquarium']).toContain(target.id);sim.update([a]);sim.step(.1);expect(actor.target).toBe(target);
    // A new observation may choose a different object; repeated snapshots must not reroll it.
    let id;do {id=event(5,'note',{}).event_id;} while(hash(id)%3===hash(a.signal.id)%3);
    ({actor}=await run(5,{action:'custom_operation'},{event_id:id}));expect(actor.target.id).not.toBe(target.id);
    const unsupported=await (await o.events([event(6,'plan.start',{action:'plan'})])).json();expect(unsupported.rejected[0].code).toBe('invalid_action');
    for(const bad of [3,{},'has spaces','', 'a'.repeat(49)]){const reply=await (await o.events([event(6,'note',{action:bad})])).json();expect(reply.rejected[0].code).toBe('invalid_action');}
    const legacy=await (await o.events([event(6,'tool.call',{tool:'bash'})])).json();expect(legacy.accepted).toBe(1);expect(signals.at(-1).action).toBe('use_tools');
    for(const [i,[tool,expected,extra]] of [['rg','search_content',{}],['ls','lookup_file',{}],['ffgrep','other',{}],['subagent','other',{}],['bash',undefined,{room:'meeting'}]].entries()) {
      expect((await (await o.events([event(7+i,'tool.start',{tool},extra)])).json()).accepted).toBe(1);
      const a=(await (await o.snapshot()).json()).agents[0];expect(a.signal).toEqual(signals.at(-1));expect(a.signal.action).toBe(expected);expect(a.signal.action_origin).toBe(expected?'default':undefined);
      expect(a.presence.room).toBe(extra.room??(expected==='other'?'lobby':'library'));
    }
    for(const [type,data] of [['human.waiting',{options:['PRIVATE_CHOICE']}],['human.waiting',{options:['yes','yes']}],['human.waiting',{title:'PRIVATE_PROMPT'}],['human.resumed',{answer:'PRIVATE_ANSWER'}]]) {
      expect((await (await o.events([event(12,type,data)])).json()).rejected).toHaveLength(1);
    }
  } finally {off();o.db.close();}
});
