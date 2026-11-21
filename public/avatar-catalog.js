// Pools describe visual styles, not agent identity. Most pieces intentionally have no filter.
const haircuts = ['crop','side-part','bob','shoulder','ponytail','bun','curls','braid','twists','mohawk','waves','buzz','twin buns','afro','swept'];
const tops = ['shirt','cardigan','tunic','jacket','hoodie','denim','striped tee','vest','polo','overalls','scarf sweater'];
const bottoms = ['straight','cuffed','cargo','wide','shorts'];
const shirts = ['#528f9a','#cf8264','#8b7fb5','#719566','#d4aa58','#637eb3','#bc7191','#4a9b88','#db6258','#525576','#f1dbbf','#337782','#9b583f','#835378','#5b7082','#91adbc'];
const pants = ['#354052','#59616b','#47574d','#a28766','#805a51','#657ca4','#c6b79f','#51455c'];
const skin = ['#f5dbca','#f1cdba','#e8bd96','#d9a580','#c18a63','#ac7756','#976548','#81543e','#694431','#56392e'];
const hair = ['#282527','#46342c','#674737','#875736','#a36c4f','#c59059','#d8b67e','#acb3b2','#e5d9cb','#55384b','#424868','#853e3c'];
function mix(n) {
  n = Math.imul(n ^ n >>> 16, 0x21f0aaad);
  n = Math.imul(n ^ n >>> 15, 0x735a2d97);
  return (n ^ n >>> 15) >>> 0;
}
export function catalogueLook(seed) {
  const pick = options => { seed = (seed + 0x9e3779b9) >>> 0; return options[mix(seed) % options.length]; };
  const presentation = pick(['masculine','feminine','androgynous']);
  const outfit = pick(presentation==='masculine' ? [...tops,'waistcoat'] : presentation==='feminine' ? [...tops,'wrap blouse'] : tops);
  return {presentation, outfit, hairStyle:pick(haircuts), shirt:pick(shirts), trim:pick(shirts), skin:pick(skin), hair:pick(hair),
    bottom:pick(presentation==='feminine' && outfit!=='overalls' ? [...bottoms,'skirt','pleated skirt'] : bottoms), pants:pick(pants),
    face:pick(['round','oval','broad','long']), nose:pick(['button','straight','wide']), eyes:pick(['round','almond','narrow']), brows:pick(['soft','arched','straight']),
    facialHair:presentation==='masculine' ? pick(['none','none','none','moustache','goatee','beard']) : 'none',
    eyewear:pick(['none','none','none','square','round','visor']), earwear:pick(['none','none','earrings','studs','headphones']),
    shoes:pick(['sneakers','boots','loafers']), leather:pick(['#f2e8d6','#473d38','#a77355','#29394b'])};
}

export function silhouette(style) { return `${style.hairStyle}/${style.outfit}/${style.bottom}`; }
// Choose a fresh seed, not a second stored property. The same seed reconstructs the entire look.
export function drawVariation(id, filter, recent, styleOf) {
  const start = Math.floor(Math.random()*2147483647);
  for(let i=0;i<2147483647;i++) {
    const n=1+(start+i)%2147483647, style=styleOf(id,n);
    if ((filter==='random' || style.presentation===filter) && !recent.includes(silhouette(style))) return n;
  }
  throw Error('No matching appearance');
}
