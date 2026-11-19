// Spatial truth shared by rendering, routing and interaction slots. No DOM or Three.js.
import { workVariants, atStation } from './office-variants.js';
import { standbyEligible, stationActivity } from "./office-activity.js";
export function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

export function avatarStyle(agentId, variation = null) {
  const id = variation == null ? agentId : `${agentId}:look:${variation}`;
  const n = hash(id);
  // Visual presentation only: no gender identity is inferred from a name or harness.
  const presentation = ["feminine", "masculine", "androgynous"][hash(`${id}:presentation`) % 3];
  const hairstyles = {
    feminine: ["bob", "shoulder", "ponytail", "bun", "curls"],
    masculine: ["crop", "side-part", "curls", "ponytail"],
    androgynous: ["bob", "crop", "bun", "shoulder", "side-part"],
  }[presentation];
  return {
    presentation,
    hairStyle: hairstyles[hash(`${id}:hair`) % hairstyles.length],
    outfit: ["shirt", "cardigan", "tunic", "jacket"][hash(`${id}:outfit`) % 4],
    shirt: ["#528f9a", "#cf8264", "#8b7fb5", "#719566", "#d4aa58", "#637eb3", "#bc7191", "#4a9b88"][
      n % 8
    ],
    skin: ["#edc5a2", "#c58e67", "#945d43", "#f4d7ba"][(n >>> 4) % 4],
    hair: ["#322c31", "#6f4631", "#bc8b51", "#413c55"][(n >>> 8) % 4],
    accessory: (n >>> 16) % 3,
  };
}

export function createLayout() {
  const furniture = [];
  const slots = [];
  const add = (id, kind, x, z, w, d, extra = {}) => {
    const item = { id, kind, x, z, w, d, ...extra };
    furniture.push(item);
    return item;
  };
  const slot = (id, room, x, z, rot = Math.PI, pose = "standing", object = null) =>
    slots.push({ id, room, x, z, rot, pose, object });
  for (const x of [3.2, 6.5, 9.8]) {
    for (const side of [-1, 1]) {
      const id = `desk-${slots.length}`;
      const z = 6.15 + side * 0.6;
      add(id, "desk", x, z, 2.3, 1.1, { rotation: side < 0 ? Math.PI : 0 });
      slot(id, "desk", x, z + side * 0.9, side < 0 ? 0 : Math.PI, "seated", id);
    }
    add(`divider-${x}`, "desk-divider", x, 6.15, 2.3, 0.12);
  }
  add("tv", "tv", 19.65, 3.2, 0.4, 1.7);
  add("meeting-table", "meeting-table", 16.5, 3.2, 3.1, 1.25);
  for (const x of [15.5, 17.5]) {
    slot(`meeting-n-${x}`, "meeting", x, 1.75, 0, "seated", "meeting-table");
    slots.at(-1).attentionSeat = true;
    slot(`meeting-s-${x}`, "meeting", x, 4.65, Math.PI, "seated", "meeting-table");
  }
  for (const [i, [x, z]] of [
    [14.2, 4.9],
    [16.5, 5.4],
    [19.45, 5.45], // keep the aisle to the window seats open when this spot is occupied
    [16.5, 1],
    [14.1, 1.75],
    [19.2, 1.65], // clear the adjacent chair's side-entry portal
  ].entries()) {
    slot(`attention-${i}`, "meeting", x, z, 0, "standing", "meeting-table");
    slots.at(-1).attentionOnly = true;
  }
  // Sofa cushions are docking surfaces; only its back and arms block approach.
  add("sofa", "sofa", 16.6, 9.3, 3.9, 1.1, { docking: true });
  slot("lounge-a", "pantry", 15.6, 9.55, 0, "seated", "sofa");
  slot("lounge-b", "pantry", 17.6, 9.55, 0, "seated", "sofa");
  add("coffee-table", "coffee-table", 16.6, 11.8, 2.0, 0.8);
  const coffee = add("coffee", "coffee", 19, 7.6, 1.1, 1.7);
  slot("coffee", "pantry", coffee.x - 1.2, coffee.z, Math.PI / 2, "standing", coffee.id);
  add("water", "water", 19, 11.9, 0.65, 0.65);
  slot("water", "pantry", 17.95, 11.9, Math.PI / 2, "standing", "water");
  add("aquarium", "aquarium", 14.1, 12.9, 1.7, 0.65);
  slot("aquarium", "aquarium", 14.1, 12, 0, "standing", "aquarium");
  const archiveZ = 11.25;
  add("archive", "archive", 0.7, archiveZ, 1.2, 0.65, {
    rotation: Math.PI / 2,
    clearance: { x: 0.95, z: archiveZ, w: 1.2, d: 1.3 },
  });
  slot("archive", "library", 1.9, archiveZ, -Math.PI / 2, "standing", "archive");
  // One physical reservation for both reference lookup and staging output files.
  add("archive-east", "archive", 8.85, 0.69, 1.2, 0.65);
  slot("archive-east", "library", 8.85, 1.65, Math.PI, "standing", "archive-east");
  slots.at(-1).alsoServes = "print-room";
  // Keep the existing watering station ID; approach from the front, outside the coffee aisle.
  const loungePlant = add("plant-14-8", "plant", 13.9, 9.3, 0.65, 0.65);
  slot("ambient-plant", "plant", loungePlant.x, loungePlant.z + 0.9, Math.PI, "standing", loungePlant.id);
  add("whiteboard", "whiteboard", 3.2, 0.9, 3.2, 0.1, {
    clearance: { x: 3.2, z: 0.9, w: 3.2, d: 0.5 },
  });
  slot("whiteboard", "whiteboard", 3.2, 1.59, Math.PI, "standing", "whiteboard");
  // Viewing and overflow spots have no work prop or machine reservation.
  slot("board-view", "board-view", 4.7, 2.45, -2.4, "standing", "board-view");
  slot("board-writing", "work-visit", 4.35, 1.62, Math.PI, "standing", "whiteboard");
  slot("printer-side", "writing-overflow", 11.4, 2.4, -0.35);
  slot("library-side", "writing-overflow", 5.6, 2.45, 0.35);
  add("library", "library", 7, 0.65, 2.5, 0.7);
  slot("library", "library", 7, 1.85, Math.PI, "standing", "library");
  add("printer", "printer", 10.2, 0.85, 1.5, 0.9);
  slot("printer", "print-room", 10.2, 2.1, Math.PI, "standing", "printer");
  const bench = add("workshop", "workshop", 0.65, 4.24, 0.8, 2.5);
  slot("workshop", "workshop", bench.x + 1, bench.z, -Math.PI / 2, "standing", bench.id);
  const cart = add("tool-cart", "tool-cart", 0.69, 2.19, 0.72, 0.85);
  slot(cart.id, "workshop", cart.x + 0.87, cart.z, -Math.PI / 2, "standing", cart.id);
  // Decorative objects still reserve floor clearance; neither is an activity station.
  add("extinguisher", "extinguisher", 0.32, 6.42, 0.46, 0.50);
  add("waste-bin", "waste-bin", 0.52, 7.42, 0.62, 0.62);
  add("phone", "phone", 0.65, 9.2, 0.8, 1.8);
  slot("phone", "phone-booth", 1.65, 9.2, -Math.PI / 2, "standing", "phone");
  add("intern", "desk", 10, 12.1, 2.3, 1.1);
  slot("intern", "intern-desk", 10, 13, Math.PI, "seated", "intern");
  for (const [x, z] of [
    [0.65, 0.65],
    [0.7, 13.0],
    [12, 0.65],
    [19.2, 0.65],
    [19, 13],
  ])
    add(`plant-${x}-${z}`, "plant", x, z, 0.65, 0.65);
  const partitions = [
    { x: 13, z: 2.15, w: 0.12, d: 4.3 },
    { x: 13, z: 6.05, w: 0.12, d: 0.3 },
    { x: 16.5, z: 6.2, w: 7, d: 0.12 },
  ];
  for (let i = 0; i < 8; i++)
    slot(`waiting-${i}`, "lobby", 3.9 + (i % 4) * 1.5, 10.35 + Math.floor(i / 4) * 1.55, 0);
  // Each cushion has a front-only entry and stays reserved until its occupant clears it.
  const cushions = slots.filter(s=>s.object==='sofa').map(s=>{
    s.chairId=`cushion-${s.id}`;
    s.approach={x:s.x,z:s.z+.85};
    return {id:s.chairId,x:s.x,z:9.3,w:1.9,d:1.1};
  });
  const chairs = slots
    .filter((s) => s.pose === "seated" && s.object !== "sofa")
    .map((s) => {
      s.chairId = `chair-${s.id}`;
      s.approach = { x: s.x + 0.85, z: s.z };
      return { id: s.chairId, x: s.x, z: s.z, w: 0.7, d: 0.72 };
    });
  return {
    width: 20,
    chairs,
    depth: 14,
    entrance: { x: 7.8, z: 13.2 },
    furniture,
    partitions,
    slots,
    obstacles: [
      ...furniture.flatMap((item) =>
        item.docking
          ? [
              { x: item.x, z: item.z - 0.42, w: item.w, d: 0.25 },
              { x: item.x - 1.85, z: item.z, w: 0.2, d: item.d },
              { x: item.x + 1.85, z: item.z, w: 0.2, d: item.d },
            ]
          : [item.clearance ?? item],
      ),
      ...partitions,
      ...cushions,
      ...chairs,
    ],
    rugs: [
      { x: 6.5, z: 6.8, w: 10.7, d: 7.1, color: "#a5b7ad", label: "WORKSPACE" },
      { x: 16.5, z: 3.1, w: 6.5, d: 5.9, color: "#b6b4cc", label: "MEETING" },
      { x: 16.7, z: 10.7, w: 5.4, d: 4.5, color: "#d0aa87", label: "LOUNGE" },
    ],
  };
}

const BODY_GAP = 0.68;
function clearsBody(a, b, p) {
  const x=b.x-a.x, z=b.z-a.z, length=x*x+z*z;
  const t=length ? Math.max(0,Math.min(1,((p.x-a.x)*x+(p.z-a.z)*z)/length)) : 0;
  return (a.x+t*x-p.x)**2 + (a.z+t*z-p.z)**2 >= BODY_GAP**2;
}
export function createNavigator(layout, radius = 0.27) {
  const spacing = 0.25;
  const cols = Math.round(layout.width / spacing) + 1;
  const rows = Math.round(layout.depth / spacing) + 1;
  const isOpen = (p, except = null) =>
    p.x >= radius &&
    p.z >= radius &&
    p.x <= layout.width - radius &&
    p.z <= layout.depth - radius &&
    !layout.obstacles.some(
      (o) =>
        o.id !== except &&
        Math.abs(p.x - o.x) <= o.w / 2 + radius &&
        Math.abs(p.z - o.z) <= o.d / 2 + radius,
    );
  function clear(a, b, except = null) {
    if (!isOpen(a, except) || !isOpen(b, except)) return false;
    // Exact segment/AABB intersection: sampling can miss a clipped furniture corner.
    return !layout.obstacles.some((o) => {
      if (o.id === except) return false;
      let near = 0,
        far = 1;
      for (const [axis, size] of [
        ["x", "w"],
        ["z", "d"],
      ]) {
        const low = o[axis] - o[size] / 2 - radius;
        const high = o[axis] + o[size] / 2 + radius;
        const delta = b[axis] - a[axis];
        if (Math.abs(delta) < 1e-9) {
          if (a[axis] < low || a[axis] > high) return false;
        } else {
          const t1 = (low - a[axis]) / delta,
            t2 = (high - a[axis]) / delta;
          near = Math.max(near, Math.min(t1, t2));
          far = Math.min(far, Math.max(t1, t2));
          if (near > far) return false;
        }
      }
      return near <= far;
    });
  }
  const point = (i) => ({ x: (i % cols) * spacing, z: Math.floor(i / cols) * spacing });
  const open = Array.from({ length: cols * rows }, (_, i) => isOpen(point(i)));
  function connector(p, passable) {
    const cx = Math.round(p.x / spacing),
      cz = Math.round(p.z / spacing);
    const candidates = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx,
          z = cz + dz,
          i = z * cols + x;
        if (x >= 0 && x < cols && z >= 0 && z < rows && open[i] && passable(p, point(i)))
          candidates.push(i);
      }
    return candidates.sort(
      (a, b) =>
        Math.hypot(point(a).x - p.x, point(a).z - p.z) -
        Math.hypot(point(b).x - p.x, point(b).z - p.z),
    )[0];
  }
  function transitRoute(from, to, bodies) {
    const passable = bodies?.length ? (a,b) => bodies.every(p=>clearsBody(a,b,p)) && clear(a,b) : clear;
    if (!to || !isOpen(from) || !isOpen(to) || !passable(to,to)) return null;
    if (passable(from, to)) return [{ x: to.x, z: to.z }];
    const start = connector(from, passable),
      end = connector(to, passable);
    if (start === undefined || end === undefined) return null;
    const frontier = new Set([start]),
      visited = new Set();
    const costs = new Map([[start, 0]]),
      parents = new Map();
    const heuristic = (i) => Math.hypot(point(i).x - to.x, point(i).z - to.z);
    while (frontier.size) {
      let current,
        best = Infinity;
      for (const i of frontier) {
        const score = costs.get(i) + heuristic(i);
        if (score < best) {
          current = i;
          best = score;
        }
      }
      if (current === end) {
        const raw = [{ x: to.x, z: to.z }];
        let i = end;
        while (i !== undefined) {
          raw.unshift(point(i));
          i = parents.get(i);
        }
        const smooth = [];
        let anchor = from,
          next = 0;
        while (next < raw.length) {
          let farthest = next;
          for (let j = next; j < raw.length && passable(anchor, raw[j]); j++) farthest = j;
          smooth.push(raw[farthest]);
          anchor = raw[farthest];
          next = farthest + 1;
        }
        return smooth;
      }
      frontier.delete(current);
      visited.add(current);
      const cx = current % cols,
        cz = Math.floor(current / cols);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const x = cx + dx,
            z = cz + dz,
            i = z * cols + x;
          if (
            x < 0 ||
            x >= cols ||
            z < 0 ||
            z >= rows ||
            !open[i] ||
            visited.has(i) ||
            !passable(point(current), point(i))
          )
            continue;
          const cost = costs.get(current) + Math.hypot(dx, dz) * spacing;
          if (cost >= (costs.get(i) ?? Infinity)) continue;
          costs.set(i, cost);
          parents.set(i, current);
          frontier.add(i);
        }
    }
    return null;
  }
  const docks = new Map(
    layout.slots.filter((slot) => slot.approach).map((slot) => [slot.id, slot]),
  );
  function clearDock(a, b, seat) {
    const slot = docks.get(seat?.id);
    if (!slot) return false;
    const onAccess = (p) => slot.object==='sofa'
      ? Math.abs(p.x-slot.x)<1e-6 && p.z>=slot.z-1e-6 && p.z<=slot.approach.z+1e-6
      : Math.abs(p.z - slot.z) < 1e-6 && p.x >= slot.x - 1e-6 && p.x <= slot.approach.x + 1e-6;
    return onAccess(a) && onAccess(b) && clear(a, b, slot.chairId);
  }
  function route(from, to, departure = null, bodies = null) {
    const entry = to?.approach ? docks.get(to.id) : null,
      exit = docks.get(departure?.id);
    if (departure && (!exit || !clearDock(from, exit.approach, exit))) return null;
    if (entry && !clearDock(entry.approach, entry, entry)) return null;
    const path = transitRoute(exit?.approach ?? from, entry?.approach ?? to, bodies);
    if (!path) return null;
    if (exit) path.unshift({ ...exit.approach, dock: exit.id, releaseDock: true });
    if (entry) {
      path.at(-1).portal = true;
      path.push({ x: entry.x, z: entry.z, dock: entry.id });
    }
    return path;
  }
  const clearStep = (from, point) =>
    point.dock ? clearDock(from, point, docks.get(point.dock)) : clear(from, point);
  return { isOpen: (p) => isOpen(p), clear: (a, b) => clear(a, b), clearDock, clearStep, route };
}

const neutralStops = ['board-view','ambient-plant','aquarium'];
export function servesRoom(slot, room) {
  return !!slot && (slot.room === room || slot.alsoServes === room || (room === 'other' && neutralStops.includes(slot.id)));
}

export function createSimulation(layout = createLayout(), allowWorkTrips = () => true) {
  const navigator = createNavigator(layout);
  const actors = new Map();
  const bodiesExcept = actor => [...actors.values()].filter(a=>a!==actor).map(a=>a.position);
  // Spread a simultaneous snapshot around the entrance instead of stacking models in one pixel.
  function spawnPosition() {
    const bodies=bodiesExcept(null), start=layout.entrance;
    for(let ring=0; ring<Math.ceil(Math.max(layout.width,layout.depth)/.8);ring++) {
      for(let z=-ring;z<=ring;z++) for(let x=-ring;x<=ring;x++) {
        if(Math.max(Math.abs(x),Math.abs(z))!==ring) continue;
        const p={x:start.x+x*.8,z:start.z+z*.8};
        if(navigator.isOpen(p) && bodies.every(b=>clearsBody(p,p,b)) && !layout.slots.some(s=>Math.hypot(s.x-p.x,s.z-p.z)<BODY_GAP || s.approach && Math.hypot(s.approach.x-p.x,s.approach.z-p.z)<BODY_GAP)) return p;
      }
    }
    return null;
  }
  const childDesk = a => a.data.actorKind==='subagent' && a.room==='intern-desk' && a.target?.room==='desk';
  const toolStop = a => a.data.signal?.action==='use_tools' && !a.data.signal.variant && ['library','printer'].includes(a.target?.id);
  let elapsed = 0;
  let viewpoint = { x: 10, z: 40 };
  const facesView = (slot) => {
    const dx = viewpoint.x - slot.x,
      dz = viewpoint.z - slot.z;
    return (Math.sin(slot.rot) * dx + Math.cos(slot.rot) * dz) / Math.hypot(dx, dz) > 0.35;
  };
  function syncAttention(actor, data) {
    const waiting =
      stationActivity(data).action === "human-waiting" ||
      (data.presence?.state !== "online" &&
        actor.attention &&
        data.signal?.type === "human.waiting");
    if (Boolean(actor.attention) === Boolean(waiting)) return false;
    if (!waiting) actor.attention = null;
    else {
      const seed = hash(`${data.id}:${data.signal?.id ?? data.signal?.seq ?? "waiting"}`);
      actor.attention = { seed, standing: ((seed >>> 16) & 1) === 0 };
    }
    return true;
  }
  const wantedRoom = (data) => {
    if (standbyEligible(data)) return "pantry";
    // An explicit idle report may retain the last work room. Do not keep that station reserved.
    if (stationActivity(data).action === "waiting") return data.actorKind==='subagent' && data.runs?.some(r=>r.state==='active') ? 'intern-desk' : 'lobby';
    if (stationActivity(data).action==='human-waiting') return 'meeting';
    if (stationActivity(data).action==='other') return 'other';
    const room = data.presence?.room ?? "lobby";
    return ["barber", "away"].includes(room) ? "lobby" : room;
  };
  const fileLookup = data => data.signal?.action === 'lookup_file';
  function assign(actor) {
    const taken = new Set(
      [...actors.values()].filter((a) => a !== actor).flatMap((a) => [a.target?.id, a.dock?.id]),
    );
    const room = actor.room;
    const available = layout.slots.filter((s) => !taken.has(s.id));
    const group = !actor.ambient && workVariants(actor.data);
    const rules = group?.room === room ? group : null;
    let target;
    if (actor.attention && room === "meeting") {
      const seats = available.filter((s) => s.attentionSeat && facesView(s));
      const standing = available.filter((s) => s.attentionOnly);
      const candidates = !actor.attention.standing && seats.length ? seats : standing;
      target = candidates.includes(actor.target)
        ? actor.target
        : candidates[(actor.attention.seed >>> 2) % candidates.length];
      if (target?.attentionOnly) actor.attention.standing = true;
    } else if (rules) {
      const selected = actor.data.signal.variant;
      const candidates = selected ? rules.selections.get(selected) ?? [] : rules.working;
      const pick = list => {
        for (const rule of list) {
          if (rule.room === 'whiteboard' && room !== 'whiteboard' &&
            (boardNeeded(actor) || taken.has(rule.pose === 'writing' ? 'whiteboard' : 'board-writing'))) continue;
          if (!selected && rule.object === 'tablet' && elapsed - actor.roomSince < 3) continue;
          const slot = rule.room === 'desk' && room !== 'desk' ? spareLaptop() :
            available.includes(actor.target) && rule.matches(actor.target) ? actor.target : available.find(rule.matches);
          if (slot) return slot;
        }
      };
      target = pick(candidates) ?? (!selected ? pick(rules.overflow) : null);
      if (!target && !selected && actor.data.signal.action==='use_tools') target=available.find(s=>['library','printer'].includes(s.id) && !needsStation(actor,s.room));
    } else if (room === 'library' && actor.data.signal?.action === 'compact_context') {
      target = available.find(s => s.room === room && s.object?.startsWith('archive'));
    } else if (room === 'other') {
      const start = hash(actor.data.signal.id) % neutralStops.length;
      for(let i=0; i<neutralStops.length && !target; i++) target=available.find(s=>s.id===neutralStops[(start+i)%neutralStops.length]);
    } else {
      const regular = available.filter(s => !s.attentionOnly);
      target =
        regular.find((s) => s.id === actor.ambientTarget) ??
        (room === 'library' && fileLookup(actor.data) ? regular.find(s => s.room === room && s.object?.startsWith('archive')) : null) ??
        regular.find((s) => s.room === room && !s.object?.startsWith("archive")) ??
        regular.find((s) => s.room === room) ??
        regular.find((s) => s.alsoServes === room);
      if(!target && room==='intern-desk' && actor.data.actorKind==='subagent') target=spareLaptop();
      // A full pantry is not a work queue. Take an unreserved observation spot until
      // the next ambient trip; keep tool stations free and the reported room unchanged.
      if (!target && actor.ambient && room === 'pantry') {
        const stops = regular.filter(s => neutralStops.includes(s.id));
        if (stops.length) {
          target = stops[hash(actor.data.id) % stops.length];
          actor.ambientTarget = target.id;
          actor.ambientUntil = elapsed + 24;
          actor.room = target.room;
        }
      }
    }
    // Borrow a laptop only after native workshop stations fill. Reserve enough seats for
    // actual desk work, including visitors who are still walking or waiting to be seated.
    function spareLaptop() {
      const deskUsers = [...actors.values()].filter(a => !a.leaving && a.room === 'desk');
      const reserved = new Set(deskUsers.flatMap(a => a.target?.room === 'desk' ? [a.target.id] : []));
      const spare = layout.slots.filter(s => s.room === 'desk' && !reserved.has(s.id))
        .slice(Math.max(0,deskUsers.length - reserved.size)).filter(s => !taken.has(s.id));
      return spare.includes(actor.target) ? actor.target : spare.at(-1);
    }
    target ??= available.find((s) => s.room === "lobby");
    if (!target) {
      actor.target = null;
      actor.path = [];
      actor.mode = "waiting";
      actor.blocked = false;
      return;
    }
    if (
      actor.target === target &&
      (actor.path.length ||
        Math.hypot(actor.position.x - target.x, actor.position.z - target.z) < 0.001)
    )
      return;
    actor.target = target;
    const path = navigator.route(actor.position, target, actor.dock);
    actor.path = path ?? [];
    actor.blocked = path === null;
  }
  // A final response is a one-shot visual overlay, not a presence state or a task.
  const needsStation = (actor, room) => [...actors.values()].some(a => a !== actor &&
    a.data.presence?.state === 'online' && wantedRoom(a.data) === room);
  // A planner who requested a desk and has secured it does not reserve an empty board as well.
  const boardNeeded = visitor => [...actors.values()].some(a => {
    if (a === visitor || a.leaving || a.room !== 'whiteboard') return false;
    const preferred = workVariants(a.data)?.selections.get(a.data.signal?.variant)?.[0];
    return !preferred || preferred.room === 'whiteboard' || !a.target || !preferred.matches(a.target);
  });
  function endFinal(actor, data) {
    actor.finalStop = null;
    actor.ambient = standbyEligible(data);
    actor.ambientTarget = null;
    actor.nextAmbient = elapsed + 35;
    actor.room = wantedRoom(data);
    actor.roomSince = elapsed;
    actor.holdingIntent = false;
    actor.data = data;
    syncAttention(actor, data);
    assign(actor);
  }
  function syncFinal(actor, data, visible) {
    const s = data.signal;
    const recent = ['final_response','final_print','final_call'].includes(s?.action) && s.id &&
      Math.abs(Date.now() - Date.parse(s.at)) < 20000;
    if (visible && recent && s.id !== actor.data.signal?.id) actor.pendingFinal = s.id;
    if (!visible || !recent || actor.pendingFinal !== s?.id) actor.pendingFinal = null;
    if (actor.finalStop) {
      if (visible && recent && s.id === actor.data.signal?.id && standbyEligible(data)) {
        actor.data = data;
        return true;
      }
      endFinal(actor, data);
    }
    if (!actor.pendingFinal) return false;
    if (!standbyEligible(data)) {
      // The note can reach SSE just before its idle heartbeat. A newer non-idle state wins.
      if (data.presence?.last_seq > s.seq) actor.pendingFinal = null;
      return false;
    }
    actor.pendingFinal = null;
    const stops = s.action === 'final_call' ? ['phone'] : s.action === 'final_print' ? ['printer'] : actor.lastFinal === 'printer' ? ['phone','printer'] : ['printer','phone'];
    for (const id of stops) {
      const target = layout.slots.find(slot => slot.id === id);
      if (!target || needsStation(actor,target.room) || [...actors.values()].some(a => a !== actor && (a.target === target || a.dock === target))) continue;
      const path = navigator.route(actor.position,target,actor.dock);
      if (!path) continue;
      Object.assign(actor,{data, finalStop:id, lastFinal:id, finalDwell:0, finalUntil:Date.now()+20000,
        room:target.room, target, path, blocked:false, ambient:false, ambientTarget:null, attention:null, holdingIntent:false});
      return true;
    }
    return false;
  }
  function update(list, animateExit=true) {
    const visible = list.filter(a=>a.presence?.state!=='offline');
    const ids = new Set(visible.map(data=>data.id));
    for(const [id,a] of actors){
      if(ids.has(id)) continue;
      if(!animateExit || a.data.actorKind==='subagent'){actors.delete(id);continue;}
      if(a.leaving) continue;
      const path=navigator.route(a.position,layout.entrance,a.dock);
      if(!path){actors.delete(id);continue;}
      a.finalStop=null;a.pendingFinal=null;
      a.leaving=true;a.data={...a.data,presence:{...a.data.presence,state:'offline'}};a.ambient=false;a.attention=null;a.holdingIntent=false;a.target=null;a.path=path;
    }
    for (const data of [...visible].sort((a, b) => a.id.localeCompare(b.id))) {
      let actor = actors.get(data.id);
      if (!actor) {
        const position=spawnPosition();
        if(!position) continue;
        actor = {
          data,
          position,
          angle: Math.PI,
          target: null,
          dock: null,
          path: [],
          mode: "standing",
          blocked: false,
          roomSince: elapsed,
          room: wantedRoom(data),
          ambient: standbyEligible(data),
          ambientTarget: null,
          ambientUntil: 0,
          nextAmbient: elapsed + 25 + (hash(data.id) % 35),
          ambientCycle: hash(data.id) % 5,
          recentStops: [],
          lastExplore: null,
          attention: null,
          holdingIntent: false,
        };
        actors.set(data.id, actor);
        syncAttention(actor, data);
        assign(actor);
      } else {
        if(actor.leaving){actor.leaving=false;actor.path=[];actor.target=null;actor.room=wantedRoom(data);assign(actor);}
        if (syncFinal(actor, data, animateExit && allowWorkTrips())) continue;
        const idle = standbyEligible(data);
        const interruptAmbient = actor.ambient && !idle;
        if (idle && !actor.ambient) actor.nextAmbient = elapsed + 25 + (hash(data.id) % 35);
        actor.ambient = idle;
        if (!idle) actor.ambientTarget = null;
        const desired =
          layout.slots.find((slot) => slot.id === actor.ambientTarget)?.room ?? wantedRoom(data);
        const changedNeutral = desired === 'other' && data.signal?.id !== actor.data.signal?.id;
        const changedCabinet = (data.signal?.action === 'compact_context') !== (actor.data.signal?.action === 'compact_context');
        const selectionChanged = data.signal?.variant !== actor.data.signal?.variant ||
          (data.signal?.variant && data.signal.action !== actor.data.signal?.action);
        if (selectionChanged) { actor.tripTarget=null; actor.workSignal=null; actor.workReturning=false; }
        if (desired !== actor.room || changedNeutral || selectionChanged || (desired === 'library' && (changedCabinet || fileLookup(data) !== fileLookup(actor.data)))) {
          actor.room = desired;
          actor.roomSince = elapsed;
          actor.path = [];
          actor.holdingIntent = true;
        }
        actor.data = data;
        const attentionChanged = syncAttention(actor, data);
        // Ending attention alone (for example an error at the same station) is not travel intent.
        if (interruptAmbient || (attentionChanged && actor.attention)) {
          actor.holdingIntent = false;
          assign(actor);
        }
      }
    }
  }
  function meetingInUse(visitor) {
    return [...actors.values()].some(a => a !== visitor &&
      (a.room === 'meeting' || a.target?.room === 'meeting' || a.dock?.room === 'meeting' ||
       (a.position.x > 13 && a.position.z < 6.2)));
  }
  function nextIdleStop(actor, seed) {
    const free = slot => ![...actors.values()].some(a => a !== actor && (a.target === slot || a.dock === slot));
    if (actor.ambientCycle % 5 === 0) {
      const meeting = !meetingInUse(actor) && layout.slots.find(s => s.room === 'meeting' && s.pose === 'seated' && free(s));
      const board = layout.slots.find(s => s.id === 'board-view' && free(s));
      const spot = actor.lastExplore === 'board-view' ? meeting || board : board || meeting;
      if (spot) {actor.lastExplore = spot.room; return spot;}
    }
    const local = layout.slots.filter(s => ['coffee','water','aquarium','ambient-plant'].includes(s.id) && free(s));
    // Prefer the least recently visited available destination. Seed only breaks ties.
    const age = s => actor.recentStops.indexOf(s.id);
    const oldest = Math.min(...local.map(age));
    const choices = local.filter(s => age(s) === oldest);
    const spot = choices[(seed >>> 8) % choices.length];
    if (spot) actor.recentStops = [...actor.recentStops.filter(id => id !== spot.id), spot.id];
    return spot;
  }
  // Cosmetic travel never mutates the signal, reported room, or task. Count only settled time.
  function workTrip(actor, dt) {
    const {signal, presence} = actor.data;
    const trips = !signal?.variant && workVariants(actor.data)?.work_trip;
    const trip = trips?.length && signal?.type === 'tool.start' && signal.id && allowWorkTrips() &&
      !actor.ambient && !actor.attention && !actor.holdingIntent && actor.room === presence?.room &&
      trips[hash(actor.data.id + signal.id) % trips.length];
    const tools=trip && signal.action==='use_tools';
    const circuit=['tool-cart','library','printer'];
    const freeToolStop = () => {
      for(let i=0;i<circuit.length;i++) {
        const id=circuit[((actor.toolVisit ?? 0)+i)%circuit.length];
        const slot=layout.slots.find(s=>s.id===id);
        if(slot && slot!==actor.target && (slot.room==='workshop' || !needsStation(actor,slot.room)) &&
          ![...actors.values()].some(a=>a!==actor && (a.target===slot || a.dock===slot))) return slot;
      }
    };
    const destination = trip && (actor.tripTarget ?? (tools ? freeToolStop() : layout.slots.find(trip.matches)));
    const place = destination?.id;
    const onTrip = !!actor.tripTarget && actor.target === actor.tripTarget;
    if (!onTrip) actor.tripTarget = null;
    const eligible = place && !['waiting','standby','inactive','none','human-waiting','error'].includes(stationActivity(actor.data).action) && actor.data.signal?.type === 'tool.start';
    if (!eligible || actor.workSignal !== signal?.id) {
      actor.workDwell = 0;
      actor.workSignal = eligible ? signal.id : null;
      actor.workReturning = false;
      actor.tripTarget = null;
      if (onTrip) assign(actor);
      return;
    }
    const boardBusy = place === 'board-writing' && (boardNeeded(actor) || [...actors.values()].some(a => a !== actor && a.target?.id === 'whiteboard'));
    if (onTrip && (boardBusy || (tools && destination.room!=='workshop' && needsStation(actor,destination.room)))) { actor.tripTarget = null; actor.workDwell = 0; actor.workReturning = true; assign(actor); return; }
    if (actor.path.length || actor.blocked || !['standing','seated'].includes(actor.mode)) return;
    if (!onTrip && !servesRoom(actor.target, actor.room)) return;
    actor.workReturning = false;
    actor.workDwell += dt;
    const dwell = onTrip ? 12 : tools ? 10 + hash(actor.data.id) % 7 : 50 + hash(actor.data.id) % 16;
    if (actor.workDwell < dwell) return;
    actor.workDwell = 0;
    if (onTrip) { actor.tripTarget = null; actor.workReturning = true; assign(actor); return; }
    if (boardBusy || [...actors.values()].some(a => a.target?.id === place || a.dock?.id === place)) return;
    const path = navigator.route(actor.position, destination, actor.dock);
    if (path && destination !== actor.target) { actor.target = actor.tripTarget = destination; actor.path = path; if(tools) actor.toolVisit=circuit.indexOf(place)+1; }
  }
  function step(delta) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    elapsed += dt;
    for (const actor of actors.values()) {
      const state = actor.data.presence?.state;
      if(!actor.leaving){
      if (state !== "online") {
        actor.workSignal = null;
        actor.mode = state === "stale" ? "stale" : "offline";
        continue;
      }
      if (
        actor.attention &&
        !actor.attention.standing &&
        actor.target?.attentionSeat &&
        !facesView(actor.target)
      ) {
        // Once standing, do not chase the camera between seats during this waiting episode.
        actor.attention.standing = true;
        actor.holdingIntent = false;
        assign(actor);
      }
      if (actor.finalStop) {
        if (!actor.path.length && actor.mode === 'standing') actor.finalDwell += dt;
        if (actor.finalDwell >= 2 || Date.now() >= actor.finalUntil || !allowWorkTrips() || needsStation(actor,actor.room)) endFinal(actor,actor.data);
      }
      if (actor.ambient && actor.ambientTarget && (elapsed >= actor.ambientUntil || (actor.room === 'meeting' && meetingInUse(actor)))) {
        actor.ambientTarget = null;
        actor.room = "pantry";
        actor.holdingIntent = false;
        assign(actor);
      } else if (actor.ambient && !actor.ambientTarget && elapsed >= actor.nextAmbient) {
        const seed = hash(`${actor.data.id}:${actor.ambientCycle++}`);
        actor.nextAmbient = elapsed + 35 + (seed % 45);
        const slot = nextIdleStop(actor, seed);
        if (slot) {
          actor.ambientTarget = slot.id;
          actor.ambientUntil = elapsed + 18 + (seed % 8);
          actor.room = slot.room;
          actor.holdingIntent = false;
          assign(actor);
        }
      }
      // Keep latest intent immediately, but do not start a journey for each short tool burst.
      if (actor.holdingIntent) {
        if (elapsed - actor.roomSince < 3) {
          actor.mode =
            actor.dock &&
            Math.hypot(actor.position.x - actor.dock.x, actor.position.z - actor.dock.z) < 0.001
              ? "seated"
              : "standing";
          continue;
        }
        actor.holdingIntent = false;
        assign(actor);
      }
      workTrip(actor, dt);
      const selected = !actor.ambient && !actor.attention && actor.data.signal?.variant && workVariants(actor.data)?.room === actor.room;
      if (selected) {
        // Reclaim a released preferred station, and yield borrowed equipment to native work.
        if (elapsed >= (actor.nextChoiceCheck ?? 0)) { assign(actor); actor.nextChoiceCheck=elapsed+0.45; }
      } else if (elapsed - actor.roomSince >= 0.42 && actor.target?.room !== 'work-visit' && !actor.tripTarget && !servesRoom(actor.target, actor.room) && elapsed >= (actor.nextRetry ?? 0)) { assign(actor); actor.nextRetry=elapsed+.45; }
      }
      // Waiting actors can take released seats without restarting the intent debounce.
      let budget = 2.4 * dt;
      let walking = false, yielding = false;
      while (actor.path.length && budget > 0) {
        const next = actor.path[0];
        if (next.dock) actor.dock = layout.slots.find((s) => s.id === next.dock);
        const dx = next.x - actor.position.x,
          dz = next.z - actor.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.001) {
          actor.path.shift();
          if (next.releaseDock) actor.dock = null;
          if (next.dock || next.portal) break;
          continue;
        }
        const travel = Math.min(distance, budget);
        const stepTo={x:actor.position.x+(dx/distance)*travel,z:actor.position.z+(dz/distance)*travel};
        const bodies=bodiesExcept(actor);
        if (!bodies.every(p=>clearsBody(actor.position,stepTo,p))) {
          yielding=true;
          if(elapsed >= (actor.replanAt ?? 0)) {
            actor.replanAt=elapsed+.45+(hash(actor.data.id)%9)*.04;
            const detour=navigator.route(actor.position,actor.leaving ? layout.entrance : actor.target,actor.dock,bodies);
            if(detour) actor.path=detour;
          }
          break;
        }
        Object.assign(actor.position,stepTo);
        actor.heading = Math.atan2(dx, dz);
        budget -= travel;
        walking = true;
        if (travel >= distance) {
          actor.path.shift();
          if (next.releaseDock) actor.dock = null;
          // Preserve the validated route corner in the rendered trajectory. Combining two
          // clear segments in one frame can cut through a chair's clearance boundary.
          break;
        }
      }
      if(actor.leaving && !actor.path.length){actors.delete(actor.data.id);continue;}
      actor.mode = walking
        ? "walking"
        : yielding ? 'yielding' : actor.blocked
          ? "blocked"
          : !servesRoom(actor.target, actor.room) && actor.target?.room !== 'writing-overflow' && actor.target?.room !== 'work-visit'
              && !childDesk(actor) && !toolStop(actor) && !atStation(workVariants(actor.data)?.overflow,actor.target)
            ? "waiting"
            : actor.target.pose;
      const heading = walking ? actor.heading : (actor.target?.rot ?? actor.angle);
      const turn = Math.atan2(Math.sin(heading - actor.angle), Math.cos(heading - actor.angle));
      actor.angle += turn * Math.min(1, dt * 9);
    }
  }
  return {
    actors,
    update,
    step,
    navigator,
    setViewpoint: (point) => {
      viewpoint = { x: point.x, z: point.z };
    },
  };
}

// Stylized local-time cycle, not astronomical sunrise or weather data.
// Explicit dawn/dusk keys prevent an all-night fade toward midday brightness.
const MOOD_KEYS = [
  // hour, sky, horizon, sun, fill, lamps, stars, daylight, twilight, light colour
  [0, [8, 14, 30], [24, 38, 61], 0.28, 0.72, 1, 1, 0, 0, [157, 188, 238]],
  [5, [20, 29, 55], [83, 69, 102], 0.3, 0.8, 1, 0.8, 0, 0.1, [165, 183, 229]],
  [6, [105, 119, 171], [250, 170, 116], 1, 1.2, 0.65, 0.12, 0.95, 1, [255, 184, 126]],
  [8, [121, 182, 212], [245, 224, 192], 2.1, 2, 0.12, 0, 1, 0.2, [255, 231, 190]],
  [12, [84, 157, 204], [208, 232, 240], 2.6, 2.3, 0, 0, 1, 0, [255, 245, 223]],
  [17, [126, 132, 183], [245, 190, 135], 1.6, 1.65, 0.35, 0, 1, 0.6, [255, 204, 146]],
  [18, [98, 91, 143], [232, 145, 106], 0.9, 1.2, 0.75, 0.08, 0.85, 1, [255, 176, 117]],
  [19.5, [19, 28, 56], [58, 55, 85], 0.3, 0.8, 1, 0.7, 0, 0.1, [169, 184, 232]],
  [21, [8, 14, 30], [24, 38, 61], 0.28, 0.72, 1, 1, 0, 0, [157, 188, 238]],
  [24, [8, 14, 30], [24, 38, 61], 0.28, 0.72, 1, 1, 0, 0, [157, 188, 238]],
].map(([hour, sky, horizon, sun, fill, lamps, stars, daylight, twilight, lightColor]) => ({
  hour,
  sky,
  horizon,
  sun,
  fill,
  lamps,
  stars,
  daylight,
  twilight,
  lightColor,
}));
export function moodAt(hours) {
  const hour = ((hours % 24) + 24) % 24;
  const index = MOOD_KEYS.findIndex((key) => key.hour > hour);
  const a = MOOD_KEYS[index - 1],
    b = MOOD_KEYS[index];
  const t = (hour - a.hour) / (b.hour - a.hour);
  const mix = (x, y) => x + (y - x) * t;
  return {
    label:
      hour >= 6 && hour < 12
        ? "Morning"
        : hour >= 12 && hour < 17
          ? "Afternoon"
          : hour >= 17 && hour < 20
            ? "Evening"
            : "Night",
    sky: a.sky.map((v, i) => Math.round(mix(v, b.sky[i]))),
    horizon: a.horizon.map((v, i) => Math.round(mix(v, b.horizon[i]))),
    sun: mix(a.sun, b.sun),
    fill: mix(a.fill, b.fill),
    lamps: mix(a.lamps, b.lamps),
    stars: mix(a.stars, b.stars),
    daylight: mix(a.daylight, b.daylight),
    twilight: mix(a.twilight, b.twilight),
    lightColor: a.lightColor.map((v, i) => Math.round(mix(v, b.lightColor[i]))),
    discX: 12 + Math.max(0, Math.min(1, (hour - 6) / 12)) * 76,
    discY: 29 - Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)) * 19,
    sunX: 10 + Math.cos(((hour - 6) / 12) * Math.PI) * 18,
    sunY: 12 + Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)) * 14,
  };
}
