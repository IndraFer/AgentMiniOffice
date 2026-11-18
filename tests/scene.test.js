import { describe, expect, test } from "bun:test";
import {
  avatarStyle,
  createLayout,
  createNavigator,
  createSimulation,
  moodAt,
} from "../public/office-model.js";

const layout = createLayout();
const nav = createNavigator(layout);
const agent = (id, room = "desk", task = "Draft") => ({
  id,
  name: id,
  presence: { state: "online", room, task, activity: "Working" },
});

describe("office navigation", () => {
  test("transit routes go behind or around chairs instead of through their seats", () => {
    const from = { x: 1.9, z: 4.65 },
      to = { x: 11.3, z: 4.65 };
    expect(nav.clear(from, to)).toBe(false);
    const route = nav.route(from, to);
    expect(route).not.toBeNull();
    let previous = from;
    for (const point of route) {
      expect(nav.clear(previous, point)).toBe(true);
      previous = point;
    }
    expect(layout.chairs).toHaveLength(11);
  });
  test("seat entry and exit use only that chair's open-side docking segment", () => {
    const seat = layout.slots.find((slot) => slot.id === "desk-0");
    expect(nav.isOpen(seat)).toBe(false);
    const entering = nav.route(layout.entrance, seat);
    expect(entering.at(-1).dock).toBe(seat.id);
    expect(entering.at(-2)).toMatchObject(seat.approach);
    expect(nav.clearDock(seat.approach, seat, seat)).toBe(true);
    expect(nav.clearDock({ x: seat.x, z: seat.z - 0.85 }, seat, seat)).toBe(false);
    const exiting = nav.route(seat, layout.entrance, seat);
    expect(exiting[0]).toMatchObject({ ...seat.approach, dock: seat.id, releaseDock: true });
    expect(nav.route(seat, layout.entrance)).toBeNull();
  });
  test("desk pairs face each other across low shared partitions, with reachable close seats", () => {
    const desks = layout.furniture.filter((item) => item.kind === "desk" && item.id !== "intern");
    expect(desks).toHaveLength(6);
    for (const x of [3.2, 6.5, 9.8]) {
      const pair = desks.filter((item) => item.x === x).sort((a, b) => a.z - b.z);
      const seats = pair.map((item) => layout.slots.find((slot) => slot.object === item.id));
      expect(seats[0].rot).toBe(0);
      expect(seats[1].rot).toBe(Math.PI);
      expect(seats[0].z).toBeLessThan(pair[0].z);
      expect(seats[1].z).toBeGreaterThan(pair[1].z);
      expect(Math.abs(seats[0].z - pair[0].z)).toBeLessThan(1);
      expect(pair[0].rotation).toBe(Math.PI);
      expect(pair[1].rotation).toBe(0);
      expect(layout.furniture.some((item) => item.kind === "desk-divider" && item.x === x)).toBe(
        true,
      );
    }
  });
  test("every interaction slot is reachable from the entrance without crossing furniture", () => {
    for (const slot of layout.slots) {
      expect(nav.isOpen(slot.approach ?? slot)).toBe(true);
      const route = nav.route(layout.entrance, slot);
      expect(route).not.toBeNull();
      let previous = layout.entrance;
      for (const point of route ?? []) {
        expect(nav.clearStep(previous, point)).toBe(true);
        previous = point;
      }
      expect(previous).toMatchObject({ x: slot.x, z: slot.z });
    }
  });
  test("meeting routes pass through the doorway, not glass or the table", () => {
    const target = layout.slots.find((s) => s.room === "meeting");
    const route = nav.route({ x: 11.5, z: 2 }, target);
    expect(route).not.toBeNull();
    expect(route?.length).toBeGreaterThan(1);
    expect(nav.clear({ x: 11.5, z: 2 }, target)).toBe(false);
  });
  test("blocked destinations and disconnected spaces never get a straight-line fallback", () => {
    expect(
      nav.route(
        layout.entrance,
        layout.furniture.find((item) => item.id === "desk-0"),
      ),
    ).toBeNull();
    const closed = createNavigator({
      ...layout,
      obstacles: [...layout.obstacles, { x: 10, z: 7, w: 1, d: 14 }],
    });
    expect(closed.route({ x: 2, z: 12 }, { x: 18, z: 12 })).toBeNull();
  });
});

describe("office state", () => {
  test("human waiting mixes stable standing and window-seat choices without heartbeat rerolls", () => {
    const sim = createSimulation(layout);
    const list = Array.from({ length: 8 }, (_, i) => ({
      ...agent(`wait-${i}`, "meeting"),
      signal: { id: `attention-${i}`, type: "human.waiting" },
    }));
    sim.update(list);
    const before = [...sim.actors.values()].map((a) => a.target.id);
    const seats = [...sim.actors.values()].filter((a) => a.target.pose === "seated");
    expect(seats.length).toBeGreaterThan(0);
    expect(seats.length).toBeLessThanOrEqual(2);
    for (const actor of seats) expect(actor.target.id.startsWith("meeting-n-")).toBe(true);
    expect([...sim.actors.values()].some((a) => a.target.attentionOnly)).toBe(true);
    sim.update(
      list.toReversed().map((a) => ({
        ...a,
        signal: { ...a.signal, id: `${a.signal.id}-repeated` },
        presence: { ...a.presence, last_seq: 500 },
      })),
    );
    expect([...sim.actors.values()].map((a) => a.target.id)).toEqual(before);
  });
  test("an error cancels an attention gesture without inventing a new journey", () => {
    const sim = createSimulation(layout);
    sim.update(
      Array.from({ length: 4 }, (_, i) => ({
        ...agent(`wait-${i}`, "meeting"),
        signal: { id: `attention-${i}`, type: "human.waiting" },
      })),
    );
    for (let i = 0; i < 400; i++) sim.step(0.05);
    const actor = [...sim.actors.values()].find((a) => a.target.attentionOnly);
    const position = { ...actor.position };
    sim.update([{ ...actor.data, signal: { id: "reported-error", type: "error" } }]);
    for (let i = 0; i < 100; i++) sim.step(0.05);
    expect(actor.position).toEqual(position);
    expect(actor.attention).toBeNull();
  });
  test("moving the camera behind a waiting seat undocks to standing once, without teleporting", () => {
    const sim = createSimulation(layout);
    sim.update(
      Array.from({ length: 4 }, (_, i) => ({
        ...agent(`wait-${i}`, "meeting"),
        signal: { id: `attention-${i}`, type: "human.waiting" },
      })),
    );
    for (let i = 0; i < 400; i++) sim.step(0.05);
    const actor = [...sim.actors.values()].find((a) => a.mode === "seated");
    expect(actor).toBeDefined();
    const before = { ...actor.position };
    sim.setViewpoint({ x: 16.5, z: -30 });
    sim.step(0.05);
    expect(
      Math.hypot(actor.position.x - before.x, actor.position.z - before.z),
    ).toBeLessThanOrEqual(0.120001);
    for (let i = 0; i < 400; i++) sim.step(0.05);
    expect(actor.mode).toBe("standing");
    expect(actor.target.attentionOnly).toBe(true);
    const target = actor.target;
    sim.setViewpoint({ x: 16.5, z: 40 });
    for (let i = 0; i < 100; i++) sim.step(0.05);
    expect(actor.target).toBe(target);
  });
  test('lobby slots stay clear of the occupied cabinet and the entrance', () => {
    const cabinet = layout.slots.find(s => s.id === 'archive');
    for (const slot of layout.slots.filter(s => s.room === 'lobby')) {
      expect(Math.hypot(slot.x-cabinet.x, slot.z-cabinet.z)).toBeGreaterThanOrEqual(1.6);
      expect(Math.hypot(slot.x-layout.entrance.x, slot.z-layout.entrance.z)).toBeGreaterThanOrEqual(1);
      expect(nav.route(layout.entrance, slot)).not.toBeNull();
    }
  });
  test('standby uses free pantry fixtures then a neutral stop without taking the tool cart', () => {
    const sim = createSimulation(layout), visitors = Array.from({length:5}, (_,i) => ({...agent(`idle-${i}`, 'pantry'), presence:{state:'online',room:'pantry',heartbeat_state:'idle'}}));
    sim.update(visitors);
    for (let i=0;i<180;i++) sim.step(.1);
    const visitorsAtRest=[...sim.actors.values()];
    expect(visitorsAtRest.slice(0,4).map(a=>a.target.id).sort()).toEqual(['coffee','lounge-a','lounge-b','water']);
    expect(['ambient-plant','board-view','aquarium']).toContain(visitorsAtRest[4].target.id);
    expect(visitorsAtRest.every(a=>a.mode==='standing' || a.mode==='seated')).toBe(true);
  });
  test('tool cart is a second work station even without cosmetic trips, and a solo tool user visits it',()=>{
    const worker=id=>({...agent(id,'workshop'),signal:{id:`call-${id}`,type:'tool.start',action:'use_tools'}});
    const pair=createSimulation(layout,()=>false);pair.update([worker('bench'),worker('cart'),worker('queue')]);
    for(let i=0;i<300;i++) pair.step(.1);
    expect([...pair.actors.values()].map(a=>[a.target.object,a.mode]).slice(0,2)).toEqual([['workshop','standing'],['tool-cart','standing']]);
    const overflow=pair.actors.get('queue');expect(overflow.mode).toBe('seated');expect(overflow.target.room).toBe('desk');
    expect(overflow.data.signal.action).toBe('use_tools');expect(overflow.data.presence.room).toBe('workshop');
    const desks=Array.from({length:6},(_,i)=>agent(`writer-${i}`));
    pair.update([worker('bench'),worker('cart'),worker('queue'),...desks]);
    for(let i=0;i<300;i++) pair.step(.1);
    expect(overflow.mode).toBe('waiting');expect(desks.every(d=>pair.actors.get(d.id).mode==='seated')).toBe(true);
    pair.update([worker('bench'),worker('queue'),...desks]);for(let i=0;i<250;i++)pair.step(.1);
    expect([overflow.mode,overflow.target.id]).toEqual(['standing','tool-cart']);
    const solo=createSimulation(layout);solo.update([worker('solo')]);const stops=new Set();
    for(let i=0;i<330;i++){solo.step(.1);const a=solo.actors.get('solo');if(a.mode==='standing') stops.add(a.target.object);}
    expect([...stops]).toEqual(['workshop','tool-cart']);
  });
  test("short room bursts update intent without starting a trip", () => {
    const sim = createSimulation(layout);
    sim.update([agent("burst")]);
    for (let i = 0; i < 500; i++) sim.step(0.1);
    const actor = sim.actors.get("burst"),
      position = { ...actor.position };
    for (const room of ["library", "workshop", "print-room"]) {
      sim.update([agent("burst", room)]);
      for (let i = 0; i < 12; i++) sim.step(0.1);
      expect(actor.position).toEqual(position);
    }
    sim.update([agent("burst", "desk")]);
    for (let i = 0; i < 40; i++) sim.step(0.1);
    expect(actor.position).toEqual(position);
    expect(actor.mode).toBe("seated");
  });
  test("idle session takes ambient trips, interrupted by work and departure", () => {
    const sim = createSimulation(layout);
    const idle = {
      ...agent("ambient"),
      lifecycle: "session",
      runs: [],
      presence: { state: "online", room: "desk", heartbeat_state: "idle", last_seq: 1 },
    };
    sim.update([idle]);
    const actor = sim.actors.get("ambient");
    let sawTrip = false;
    for (let i = 0; i < 6000; i++) {
      const previous = { ...actor.position }, dockBefore = actor.dock;
      sim.step(0.1);
      if (actor.ambientTarget) sawTrip = true;
      // Quiet meeting seats use the same reserved side-entry segment as working seats.
      expect(nav.clear(previous, actor.position) || nav.clearDock(previous, actor.position, actor.dock ?? dockBefore)).toBe(true);
    }
    expect(sawTrip).toBe(true);
    expect(actor.ambient).toBe(true);
    sim.update([{ ...idle, presence: { ...idle.presence, heartbeat_state: "working" } }]);
    sim.step(0.1);
    expect(actor.ambient).toBe(false);
    expect(actor.target.room).toBe("desk");
    sim.update([{ ...idle, presence: { ...idle.presence, state: "offline" } }]);
    expect(actor.leaving).toBe(true);
    for(let i=0;i<200;i++) sim.step(0.1);
    expect(sim.actors.has(idle.id)).toBe(false);
  });

  test("document stations share reservations, keep a useful fallback and promote without another report", () => {
    const sim = createSimulation(layout);
    const crew = [
      agent("a", "library"),
      agent("b", "library"),
      agent("c", "library"),
      agent("d", "library"),
    ];
    sim.update(crew);
    const tick = () => {
      for (let n = 0; n < 220; n++) sim.step(0.1);
    };
    tick();
    const target = (id) => sim.actors.get(id).target.id;
    expect(new Set(crew.slice(0, 3).map((a) => target(a.id)))).toEqual(
      new Set(["library", "archive", "archive-east"]),
    );
    expect(sim.actors.get("d").mode).toBe("waiting");
    const fallback = target("b");
    // Only the occupant reports idle; its last reported room is still the library.
    sim.update([
      { ...crew[0], presence: { ...crew[0].presence, heartbeat_state: "idle", last_seq: 2 } },
      ...crew.slice(1),
    ]);
    tick();
    expect(sim.actors.get("a").target.room).toBe("pantry");
    expect(target("b")).toBe(fallback);
    expect(target("d")).toBe("library");
    sim.update([agent("e", "print-room"), agent("f", "print-room")]);
    tick();
    expect(target("e")).toBe("printer");
    expect(target("f")).toBe("archive-east");
    expect(sim.actors.get("f").mode).toBe("standing");
  });

  test("slots remain stable under reordering and content updates are not dropped", () => {
    const sim = createSimulation(layout);
    sim.update([agent("a"), agent("b")]);
    const a = sim.actors.get("a");
    const target = a.target;
    sim.update([agent("b"), agent("a", "desk", "Revised task")]);
    expect(sim.actors.get("a")).toBe(a);
    expect(a.target).toBe(target);
    expect(a.data.presence.task).toBe("Revised task");
  });
  test("movement is bounded and obstacle-safe; rapid room changes do not teleport", () => {
    const sim = createSimulation(layout);
    sim.update([agent("a")]);
    for (let i = 0; i < 500; i++) sim.step(1 / 30);
    const a = sim.actors.get("a");
    expect(a.mode).toBe("seated");
    sim.update([agent("a", "meeting")]);
    const old = { ...a.position };
    sim.step(0.1);
    expect(a.position).toEqual(old);
    for (let i = 0; i < 600; i++) {
      const previous = { ...a.position },
        dockBefore = a.dock;
      sim.step(1 / 30);
      expect(Math.hypot(a.position.x - previous.x, a.position.z - previous.z)).toBeLessThanOrEqual(
        2.4 / 30 + 0.00001,
      );
      expect(
        nav.clear(previous, a.position) ||
          nav.clearDock(previous, a.position, a.dock ?? dockBefore),
      ).toBe(true);
    }
    expect(a.mode).toBe("seated");
    expect(a.target.room).toBe("meeting");
  });
  test("interrupting seat entry exits through the side and keeps the chair reserved until clear", () => {
    const sim = createSimulation(layout);
    sim.update([agent("a")]);
    const actor = sim.actors.get("a");
    for (let i = 0; i < 1000 && !actor.dock; i++) sim.step(0.05);
    const occupied = actor.dock;
    expect(occupied).not.toBeNull();
    sim.update([agent("a", "library"), agent("b")]);
    expect(sim.actors.get("b").target.id).not.toBe(occupied.id);
    for (let i = 0; i < 600; i++) {
      const previous = { ...actor.position },
        dockBefore = actor.dock;
      sim.step(0.05);
      expect(
        nav.clear(previous, actor.position) ||
          nav.clearDock(previous, actor.position, actor.dock ?? dockBefore),
      ).toBe(true);
      expect(
        Math.hypot(actor.position.x - previous.x, actor.position.z - previous.z),
      ).toBeLessThanOrEqual(0.120001);
    }
    expect(actor.dock).toBeNull();
    expect(actor.mode).toBe("standing");
    expect(actor.target.room).toBe("library");
  });
  test("lobby intent changes obey debounce and can be cancelled", () => {
    const sim = createSimulation(layout);
    sim.update([agent("a", "lobby")]);
    for (let i = 0; i < 200; i++) sim.step(0.1);
    const actor = sim.actors.get("a");
    const target = actor.target;
    const position = { ...actor.position };
    sim.update([agent("a", "desk")]);
    sim.step(1 / 30);
    expect(actor.target).toBe(target);
    expect(actor.position).toEqual(position);
    sim.update([agent("a", "lobby")]);
    for (let i = 0; i < 10; i++) sim.step(0.1);
    expect(actor.target).toBe(target);
    expect(actor.position).toEqual(position);
  });
  test("overflow uses distinct waiting slots, then fills released seats", () => {
    const sim = createSimulation(layout);
    sim.update(Array.from({ length: 8 }, (_, i) => agent(String(i))));
    const targets = [...sim.actors.values()].map((a) => a.target.id);
    expect(new Set(targets).size).toBe(8);
    expect([...sim.actors.values()].filter((a) => a.target.room === "desk")).toHaveLength(6);
    sim.update(Array.from({ length: 6 }, (_, i) => agent(String(i + 2))));
    for (let i = 0; i < 5; i++) sim.step(0.1);
    expect([...sim.actors.values()].filter((a) => a.target.room === "desk")).toHaveLength(6);
  });
  test('catalogue variants let a web search borrow a laptop without changing its action, then release it',()=>{
    const sim=createSimulation(layout,()=>false);
    const readers=Array.from({length:3},(_,i)=>agent(`a${i}`,'library'));
    const web={...agent('z-web','library'),signal:{id:'s',type:'tool.start',action:'search_web'}};
    sim.update([...readers,web]);const actor=sim.actors.get(web.id);
    for(let i=0;i<220;i++)sim.step(.1);
    expect(actor.target.room).toBe('desk');expect(actor.mode).toBe('seated');expect(actor.data.signal.action).toBe('search_web');expect(actor.room).toBe('library');
    sim.update([web]);for(let i=0;i<220;i++)sim.step(.1);
    expect(actor.target.id).toBe('library');expect(actor.mode).toBe('standing');
  });
  test('a sustained write visits the board, returns, and yields to a real planner',()=>{
    const sim=createSimulation(layout), writer={...agent('writer'),signal:{id:'write-start',type:'tool.start',action:'write',detail:'unknown'}};
    sim.update([writer]);const actor=sim.actors.get('writer');
    const until=ready=>{for(let i=0;i<1200 && !ready();i++)sim.step(.1);expect(ready()).toBe(true);};
    until(()=>actor.target.id==='board-writing');until(()=>actor.target.room==='desk');
    until(()=>actor.target.id==='board-writing');sim.update([writer,agent('planner','whiteboard')]);
    sim.step(.1);expect(actor.target.room).toBe('desk');
  });
  test("writing visits use free overflow spots after three seconds and return to a released desk", () => {
    const sim = createSimulation(layout);
    const crew = Array.from({length:8}, (_,i)=>({...agent(String(i)), signal:{type:'tool.start',action:'write',detail:i%2?'edit':'write'}}));
    sim.update(crew);
    const tick = n => {for(let i=0;i<n;i++) sim.step(0.1);};
    tick(28); expect(sim.actors.get('6').target.room).toBe('lobby');
    tick(150); const extras=['6','7'].map(id=>sim.actors.get(id));
    expect(extras.every(a=>a.target.room==='writing-overflow' && a.mode==='standing')).toBe(true);
    expect(extras[0].target).not.toBe(extras[1].target);
    sim.update(crew.slice(1),false);tick(150);expect(extras.some(a=>a.target.room==='desk' && a.mode==='seated')).toBe(true);
  });
  test('idle visits rotate local stops and yield their rare meeting visit to real work',()=>{
    const sim=createSimulation(layout); const idle={...agent('wanderer'),presence:{state:'online',room:'desk',heartbeat_state:'idle'}};
    sim.update([idle]);const a=sim.actors.get(idle.id), stops=[];let last=null;
    for(let i=0;i<16000;i++){
      sim.step(.1); if(a.ambientTarget && a.ambientTarget!==last){stops.push(a.ambientTarget);if(a.target.room==='meeting'){
        sim.update([idle,agent('meeting-worker','meeting')]);sim.step(.1);expect(a.room).not.toBe('meeting');sim.update([idle],false);
      }}last=a.ambientTarget;
      if(stops.length===15) break;
    }
    expect(stops).toHaveLength(15);expect(stops.filter(s=>s==='board-view'||s.startsWith('meeting-'))).toHaveLength(3);
    for(const id of ['coffee','water','aquarium','ambient-plant','board-view']) expect(stops).toContain(id);
    expect(stops.some(s=>s.startsWith('meeting-'))).toBe(true);
    expect(stops.every((s,i)=>i===0||stops[i-1]!==s)).toBe(true);
  });
  test("only a visible visitor exits, undocks and walks to the door before removal", () => {
    const sim = createSimulation(layout);
    sim.update([agent("a")]);
    const a = sim.actors.get("a");
    for(let i=0;i<250;i++) sim.step(.1);
    expect(a.mode).toBe('seated');
    const offline={...agent('a'),presence:{state:'offline',room:'desk'}};
    sim.update([offline]);
    sim.update([]); // The prune snapshot must not cancel the exit path.
    expect(sim.actors.has('a')).toBe(true);
    for(let i=0;i<250;i++) sim.step(.1);
    expect(a.position.x).toBeCloseTo(layout.entrance.x);expect(a.position.z).toBeCloseTo(layout.entrance.z);
    sim.update([offline]);expect(sim.actors.size).toBe(0);
  });
});

describe("local mood and identity", () => {
  test("mood cycles continuously, including midnight, regardless of UI theme", () => {
    expect(moodAt(7).label).toBe("Morning");
    expect(moodAt(13).label).toBe("Afternoon");
    expect(moodAt(18).label).toBe("Evening");
    expect(moodAt(22).label).toBe("Night");
    expect(moodAt(0)).toEqual(moodAt(24));
    expect(Math.abs(moodAt(11.999).sun - moodAt(12.001).sun)).toBeLessThan(0.002);
  });
  test("night exposes moon and stars while warm lamps replace daylight", () => {
    const night = moodAt(23);
    const noon = moodAt(12);
    expect(night.stars).toBe(1);
    expect(night.daylight).toBe(0);
    expect(noon.stars).toBe(0);
    expect(noon.daylight).toBe(1);
    expect(night.fill).toBeLessThan(noon.fill / 3);
    expect(night.lamps).toBeGreaterThan(noon.lamps);
    expect(night.horizon.reduce((a, b) => a + b)).toBeLessThan(150);
    expect(moodAt(6).twilight).toBeGreaterThan(0.8);
  });
  test("sky and light values remain bounded and continuous around every transition", () => {
    for (let hour = 0; hour < 24; hour += 0.05) {
      const mood = moodAt(hour);
      for (const key of ["stars", "daylight", "twilight", "lamps"]) {
        expect(mood[key]).toBeGreaterThanOrEqual(0);
        expect(mood[key]).toBeLessThanOrEqual(1);
      }
    }
    for (const hour of [0, 5, 6, 8, 12, 17, 18, 19.5, 21, 24]) {
      const before = moodAt(hour - 0.001),
        after = moodAt(hour + 0.001);
      for (const key of ["sun", "fill", "lamps", "daylight", "stars", "twilight"]) {
        expect(Math.abs(before[key] - after[key])).toBeLessThan(0.01);
      }
    }
  });
  test("avatar palettes and features are deterministic but varied", () => {
    expect(avatarStyle("a")).toEqual(avatarStyle("a"));
    const styles = Array.from({ length: 16 }, (_, i) => JSON.stringify(avatarStyle(`agent-${i}`)));
    expect(new Set(styles).size).toBeGreaterThan(8);
    const population = Array.from({ length: 96 }, (_, i) => avatarStyle(`agent-${i}`));
    expect(new Set(population.map((style) => style.presentation))).toEqual(
      new Set(["feminine", "masculine", "androgynous"]),
    );
    expect(new Set(population.map((style) => style.hairStyle)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(population.map((style) => style.outfit)).size).toBe(4);
  });
});
