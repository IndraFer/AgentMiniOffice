export function embedControls(h, slug) {
  const url = new URL(`/embed/${encodeURIComponent(slug)}`,location.origin).href;
  const picker = h('select',{'aria-label':'Embed aspect ratio'},
    h('option',{value:'16/9'},'16:9 · Wide'),h('option',{value:'4/3'},'4:3 · Standard'),h('option',{value:'1/1'},'1:1 · Square'));
  const code = h('textarea',{readonly:true,rows:4,'aria-label':'Embed HTML',spellcheck:false});
  const feedback = h('small',{role:'status'});
  const preview = h('div',{class:'embed-sample'});
  const link = h('details',{class:'guide-topic'},h('summary',{},'Embed 3D Office'),
    h('div',{class:'guide-topic-body stack'}, h('label',{},'Aspect ratio ',picker),preview,code,
      h('button',{class:'btn btn-quiet btn-sm',type:'button',onclick:async()=>{
        try {await navigator.clipboard.writeText(code.value);feedback.textContent='Embed HTML copied.';}
        catch {code.focus();code.select();feedback.textContent='HTML selected. Copy it manually.';}
      }},'Copy HTML'),feedback,
      h('small',{class:'muted'},'Public View only. The frame fills its container; set the container width in your layout. If your site uses CSP, allow ',location.origin,' in frame-src. On the office host, allow your site in frame-ancestors for /embed/ and avoid conflicting X-Frame-Options on that route.')));
  function update() {
    // Build both the snippet and preview from one element. No private link or query is accepted.
    const frame=h('iframe',{src:url,title:'Live 3D office',loading:'lazy',referrerpolicy:'no-referrer',style:`display:block;width:100%;aspect-ratio:${picker.value};border:0;`});
    code.value=frame.outerHTML;feedback.textContent='';
    if (!link.open || link.hidden) preview.replaceChildren();
    else if(preview.firstChild) preview.firstChild.style.aspectRatio=picker.value;
    else preview.replaceChildren(frame);
  }
  picker.addEventListener('change',update);link.addEventListener('toggle',update);
  return {element:link,enable(on){link.hidden=!on;if(!on)link.open=false;update();}};
}
