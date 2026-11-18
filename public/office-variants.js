// Only catalogue entries with a renderer binding can reserve a physical station.
import schema from './schemas/action-v1.json' with {type:'json'};
const desk = s => s.room === 'desk' && s.pose === 'seated';
const cabinet = s => s.object?.startsWith('archive');
const bindings = {
  'desk/laptop/typing': desk,
  'desk/laptop/mouse': desk,
  'desk/documents/arranging': desk,
  'whiteboard/whiteboard/inspecting': s => s.id === 'whiteboard',
  'whiteboard/whiteboard/writing': s => s.id === 'board-writing',
  'whiteboard/whiteboard/planning': s => s.id === 'whiteboard',
  'library/tablet/portable': s => s.id === 'library-side',
  'print-room/tablet/portable': s => s.id === 'printer-side',
  'library/bookshelf/reading': s => s.id === 'library',
  'library/cabinet/output': cabinet,
  'library/cabinet/sorting': cabinet,
  'library/cabinet/reading': cabinet,
  'workshop/bench/tools': s => s.id === 'workshop',
  'workshop/tool-cart/tools': s => s.id === 'tool-cart',
  'print-room/printer/output': s => s.id === 'printer',
  'print-room/cabinet/output': s => s.id === 'archive-east',
  'phone-booth/phone/communication': s => s.id === 'phone',
  'meeting/meeting-table/meeting': s => s.room === 'meeting' && s.pose === 'seated',
};
const accents = new Set(['lean','glance','nod','tilt','scan','mouse','reach','adjust']);
const groups = new Map();
for (const [id, entry] of Object.entries(schema['x-actions'])) {
  if (!Array.isArray(entry.variants)) continue;
  const group = {room:entry.room, working:[], overflow:[], work_trip:[], selections:new Map()};
  const byId=new Map();
  for (const v of entry.variants) {
    const pose=v.poses[0], matches=bindings[`${v.room}/${v.object}/${pose}`];
    if (!matches) continue;
    const rule={...v, pose, matches, accents:v.poses.slice(1).filter(p=>accents.has(p))};
    group[v.when].push(rule);
    byId.set(v.id,rule);
  }
  for (const v of entry.variants) {
    // Cosmetic trips are candidates only when requested or explicitly listed.
    const ids = new Set([v.id,...v.fallback??[],...group.working.map(r=>r.id),...group.overflow.map(r=>r.id)]);
    group.selections.set(v.id, [...ids].map(k=>byId.get(k)).filter(Boolean));
  }
  groups.set(id,group);
}
export function workVariants(data) {
  const group=groups.get(data.signal?.action);
  return group && data.presence?.state==='online' && group.room===data.presence.room ? group : null;
}
export function atStation(rules, slot, offset=0) {
  if (!slot || !rules) return;
  // Rotate only automatic pose choices. Requested/fallback order uses offset zero.
  for (let i=0;i<rules.length;i++) {
    const v=rules[(offset+i)%rules.length];
    if (v.matches(slot)) return v;
  }
}
