// Standalone public reader. Never propagate a parent query, token, or dashboard state.
import { sceneEntities } from './office-activity.js';
const slug = encodeURIComponent(decodeURIComponent(location.pathname.split('/')[2]));
const endpoint = `/api/v1/offices/${slug}`;
const stage = document.querySelector('main'), status = document.querySelector('[role=status]');
let stream, scene, snapshot, revision = 0, refresh, drawTimer, revoked = false;
function clear(message) {
  ++revision;
  clearTimeout(refresh); clearTimeout(drawTimer); refresh = null; drawTimer = null;
  snapshot = null;
  scene?.dispose(); scene = null; stage.replaceChildren();
  status.textContent = message; status.hidden = false;
}
function stop(message) { stream?.close(); stream = null; clear(message); }
async function draw() {
  const stamp = revision;
  try {
    if (!scene) {
      const {createOfficeScene} = await import('./scene3d.js');
      if (stamp !== revision || !snapshot) return;
      scene ??= createOfficeScene({container:stage});
      scene.setActive(true);
    }
    scene.update(sceneEntities(snapshot.agents), snapshot.org.name);
    status.hidden = true;
  } catch { if (stamp === revision) stop('3D view unavailable. Check WebGL and reload to try again.'); }
}
function redraw() {
  if (!drawTimer) drawTimer = setTimeout(()=>{drawTimer=null;void draw();},100);
}
function deny() { revoked = true; stop('Office is private or unavailable.'); }
function sync() {
  if (refresh) return;
  const stamp=revision;
  refresh=setTimeout(async()=>{
    refresh=null;
    try {
      const res=await fetch(`${endpoint}/snapshot?view=embed`,{credentials:'omit',cache:'no-store'});
      if (stamp!==revision) return;
      if (res.status===401 || res.status===404) return deny();
      if (!res.ok) throw Error();
      const value=await res.json();
      if (stamp===revision) {snapshot=value;redraw();}
    } catch { if(stamp===revision) { stop('Office connection interrupted.'); start(); } }
  },300);
}
function start() {
  if (stream || revoked || document.hidden) return;
  const source=new EventSource(`${endpoint}/stream?view=embed`);
  stream=source;
  source.addEventListener('snapshot',e=>{snapshot=JSON.parse(e.data);redraw();});
  for(const key of ['presence','signal']) source.addEventListener(key,e=>{
    const patch=JSON.parse(e.data), agent=snapshot?.agents.find(a=>a.id===patch.agent_id);
    if (!agent) return sync();
    agent[key]=key==='signal' ? patch.signal : {...agent.presence,...patch};redraw();
  });
  for(const key of ['roster','run','task','project']) source.addEventListener(key,sync);
  source.addEventListener('access-revoked',deny);
  source.onerror=()=>clear('Office is private or the connection was interrupted.');
}
document.addEventListener('visibilitychange',()=>document.hidden ? stop('Office paused.') : start());
window.addEventListener('pagehide',()=>stop('Office paused.'));
window.addEventListener('pageshow',start);
start();
