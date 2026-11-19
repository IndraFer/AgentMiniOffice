// Only load Three.js when someone opens agent details, not for every roster row.
export function avatarPanel(h, agent, canEdit, persist) {
  let saved = agent.avatar_variation ?? null, draft = saved, busy = false, painter;
  const canvas = h('canvas',{width:288,height:288,role:'img',hidden:true});
  const placeholder = h('span',{class:'tiny muted'},'Loading portrait…');
  const status = h('p',{class:'small muted',role:'status'});
  const button = (text, action, primary=false) => h('button',{
    type:'button',class:`btn ${primary ? '' : 'btn-quiet'} btn-sm`,onclick:action,disabled:true,
  },text);
  const shuffle = button('Randomize',()=>show(painter.anotherLook(agent.id,draft)));
  const reset = button('Use default',()=>show(null));
  const discard = button('Discard',()=>show(saved));
  const save = button('Save',async()=>{
    if (busy || draft === saved) return;
    busy = true; controls(); status.textContent = 'Saving appearance…';
    try {
      await persist(draft);
      saved = draft;
      status.textContent = 'Saved. This appearance is now visible in the office.';
    } catch (error) { status.textContent = error.message || 'Could not save. Please try again.'; }
    finally { busy = false; controls(); }
  },true);
  function controls() {
    const locked = busy || !painter;
    shuffle.disabled = locked;
    reset.disabled = locked || draft === null;
    discard.disabled = save.disabled = locked || draft === saved;
  }
  function show(value) {
    try {
      const description = painter.drawPortrait(canvas,agent.id,value);
      draft = value;
      canvas.setAttribute('aria-label',`${agent.name}: ${description}`);
      canvas.hidden = false; placeholder.hidden = true;
      status.textContent = draft !== saved ? 'Preview only · not saved' : saved === null ? 'Default appearance for this visit' : 'Custom appearance for this visit';
    } catch { unavailable(); }
    controls();
  }
  function unavailable() {
    painter = null; canvas.hidden = true; placeholder.hidden = false;
    placeholder.textContent = 'No preview';
    status.textContent = '3D preview unavailable. Check WebGL and reload to try again. Your saved appearance is unchanged.';
    controls();
  }
  const panel = h('section',{class:'avatar-panel','aria-label':'Avatar appearance'},
    h('div',{class:'avatar-portrait'},canvas,placeholder),h('div',{class:'avatar-options'},
      h('h4',{},'Avatar appearance'),status,
      canEdit ? h('div',{class:'avatar-actions'},shuffle,reset,discard,save) : null));
  import('./avatar-portrait.js').then(module=>{
    if (!panel.isConnected) return;
    painter = module; show(saved);
  }).catch(unavailable);
  return panel;
}
