import * as THREE from "three";

// Both renderers use the same meshes, dimensions, materials and body proportions.
export function createShapes(materials, geometries) {
  const material = (color, extra = {}) => {
    const key = `${color}:${JSON.stringify(extra)}`;
    if (!materials.has(key))
      materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra }));
    return materials.get(key);
  };
  function mesh(geometry, mat, parent, x, y, z) {
    geometries.add(geometry);
    const object = new THREE.Mesh(geometry, mat);
    object.position.set(x, y, z);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
  function box(parent, x, y, z, w, h, d, color, extra) {
    const object = mesh(cubeGeometry, material(color, extra), parent, x, y, z);
    object.scale.set(w, h, d);
    return object;
  }
  const sphereGeometry = new THREE.SphereGeometry(1, 12, 8);
  function oval(parent, x, y, z, sx, sy, sz, color) {
    const object = mesh(sphereGeometry, material(color), parent, x, y, z);
    object.scale.set(sx, sy, sz);
    return object;
  }
  const cylinders = new Map();
  function cylinder(parent, x, y, z, radius, height, color, top = radius) {
    const key = `${top}:${radius}:${height}`;
    if (!cylinders.has(key))
      cylinders.set(key, new THREE.CylinderGeometry(top, radius, height, 12));
    return mesh(cylinders.get(key), material(color), parent, x, y, z);
  }
  function group(parent, x = 0, y = 0, z = 0, angle = 0) {
    const object = new THREE.Group();
    object.position.set(x, y, z);
    object.rotation.y = angle;
    parent.add(object);
    return object;
  }
  return { mesh, material, group, box, cylinder, oval, cubeGeometry, sphereGeometry };
}

export function buildFigure(body, style, {group, oval, box, cylinder}) {
  function makeHead(body, style) {
    const head = group(body, 0, 1.57, 0);
    const [width,height] = {round:[1.02,.96],oval:[.94,1.04],broad:[1.11,.96],long:[.91,1.10]}[style.face];
    head.scale.set(width,height,1);
    oval(head, 0, 0, 0, 0.36, 0.36, 0.31, style.skin);
    oval(head, 0, 0.21, -0.03, 0.37, 0.2, 0.31, style.hair);
    const hair = style.hairStyle;
    if (['crop','bob'].includes(hair)) oval(head, -0.16, 0.18, 0.22, 0.22, 0.12, 0.13, style.hair);
    if (hair==='side-part' || hair==='swept') oval(head,-.10,.24,.18,hair==='swept'?.33:.26,hair==='swept'?.16:.10,.17,style.hair).rotation.z=.29;
    if (hair==='twin buns') for(const side of [-1,1]) oval(head,.28*side,.34,-.07,.16,.16,.15,style.hair);
    if (hair==='mohawk') for(let i=0;i<4;i++) oval(head,0,.34,-.22+i*.13,.086,.16,.13,style.hair);
    if (hair==='afro') oval(head,0,.23,-.09,.45,.34,.37,style.hair);
    if (hair==='waves' || hair==='twists') for(const side of [-1,1]) {
      for(let i=0;i<3;i++) oval(head,side*(.25+i*.035),.17-i*.11,.11-i*.075,.11,hair==='waves'?.21:.29,.12,style.hair).rotation.z=side*.18;
    }
    if (hair==='braid') for(let i=0;i<5;i++) oval(head,.27+(i%2)*.05,.12-i*.115,-.10+i*.08,.105-i*.009,.12,.11,style.hair);
    if (["bob", "shoulder"].includes(hair)) {
      const length = hair === "bob" ? 0.29 : 0.43;
      oval(head, 0, -0.05, -0.24, 0.34, length, 0.15, style.hair);
      for (const side of [-1, 1])
        oval(head, side * 0.3, -0.055, 0.025, 0.105, length, 0.24, style.hair);
    }
    if (hair === "ponytail") {
      oval(head, 0, 0.14, -0.32, 0.13, 0.12, 0.12, style.shirt);
      oval(head, 0, -0.08, -0.4, 0.17, 0.37, 0.18, style.hair);
    }
    if (hair === "bun") oval(head, 0.04, 0.4, -0.13, 0.18, 0.17, 0.17, style.hair);
    if (hair === "curls")
      for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * Math.PI * 2;
        oval(
          head,
          Math.cos(angle) * 0.27,
          0.2 + (i % 2) * 0.08,
          Math.sin(angle) * 0.2,
          0.17,
          0.17,
          0.17,
          style.hair,
        );
      }
    for (const side of [-1, 1]) {
      oval(head,side*.12,0,.287,style.eyes==='round'?.04:.047,style.eyes==='narrow'?.025:style.eyes==='almond'?.035:.05,.022,'#302f34');
      const brow=oval(head,side*.12,.081,.284,.061,style.brows==='soft'?.012:.018,.018,style.hair);
      if(style.brows==='arched') brow.rotation.z=side*.22;
      oval(head, side * 0.22, -0.11, 0.25, 0.055, 0.025, 0.015, "#d39683");
      if (style.eyewear === 'square')
        box(head, side * 0.13, 0.01, 0.32, 0.19, 0.14, 0.035, "#4b565b", {
          transparent: true,
          opacity: 0.5,
        });
      if(style.eyewear==='round') oval(head,side*.13,.01,.314,.11,.09,.025,'#6e8d95');
      if(style.earwear==='headphones') oval(head,side*.36,.04,-.02,.075,.14,.13,style.trim);
      if(style.earwear==='studs' || style.earwear==='earrings') {
        oval(head,side*.35,-.085,.055,.043,.047,.035,'#e6bf77');
        if(style.earwear==='earrings') oval(head,side*.355,-.156,.061,.033,.060,.026,'#d8a95d');
      }
    }
    if(style.eyewear==='visor') box(head,0,.012,.295,.46,.108,.065,'#454963');
    if(style.eyewear==='round' || style.eyewear==='square') box(head,0,.016,.326,.10,.025,.023,'#526369');
    oval(head,0,-.062,.309,style.nose==='wide'?.069:.043,style.nose==='straight'?.071:.042,.046,style.skin);
    if(style.facialHair==='beard') oval(head,0,-.212,.105,.25,.15,.19,style.hair);
    if(style.facialHair==='goatee') oval(head,0,-.215,.23,.086,.092,.056,style.hair);
    if(style.facialHair==='moustache') for(const side of [-1,1]) oval(head,side*.046,-.111,.299,.061,.021,.027,style.hair).rotation.z=side*-.16;
    const mouth = box(head, 0, -0.14, 0.29, 0.09, 0.025, 0.02, "#9a6253");
    return { head, mouth };
  }

  function dressBody(body, style) {
    oval(body, 0, 0.96, 0, 0.29, 0.38, 0.2, style.shirt);
    if (style.outfit === "tunic") {
      box(body, 0, 0.73, 0, 0.46, 0.27, 0.32, style.shirt);
      for (const side of [-1, 1]) oval(body, side * 0.22, 0.72, 0, 0.11, 0.15, 0.17, style.shirt);
    }
    if(style.outfit==='hoodie') {
      oval(body,0,1.22,-.10,.30,.21,.23,style.shirt);
      box(body,0,.87,.178,.28,.13,.044,style.trim);
      for(const s of [-1,1]) cylinder(body,s*.064,1.10,.19,.013,.15,'#f1e8d6');
    }
    if(style.outfit==='striped tee') for(const y of [.91,1.04,1.15]) oval(body,0,y,.013,.282,.038,.198,style.trim);
    if(style.outfit==='denim' || style.outfit==='overalls') {
      box(body,0,.95,.176,style.outfit==='denim'?.38:.27,.31,.045,style.outfit==='denim'?style.shirt:style.pants);
      for(const s of [-1,1]) box(body,s*.11,1.14,.171,.055,.21,.047,style.outfit==='denim'?style.trim:style.pants);
      box(body,0,.961,.208,.13,.081,.02,style.trim);
    }
    if(style.outfit==='scarf sweater') {
      oval(body,0,1.24,.01,.23,.079,.18,style.trim);
      box(body,.10,1.08,.204,.102,.28,.044,style.trim).rotation.z=-.13;
    }
    if(style.outfit==='wrap blouse') box(body,0,1.02,.183,.084,.46,.037,style.trim).rotation.z=-.55;
    if(style.outfit==='vest' || style.outfit==='waistcoat') for(const s of [-1,1]) {
      const panel=box(body,s*.115,1.01,.174,.165,.37,.065,style.trim);panel.rotation.z=s*.09;
      if(style.outfit==='waistcoat') oval(body,s*.076,.94,.216,.014,.014,.012,'#efe3c4');
    }
    if(style.outfit==='polo') for(const s of [-1,1]) box(body,s*.065,1.21,.145,.10,.12,.055,style.trim).rotation.z=s*.38;
    if(style.outfit==='jacket') box(body,0,.79,0,.48,.11,.31,style.trim);
    if (["cardigan", "jacket"].includes(style.outfit)) {
      box(body, 0, 1.02, 0.19, 0.12, 0.4, 0.025, "#f1e8d6");
      for (const side of [-1, 1]) {
        const collar = box(body, side * 0.07, 1.18, 0.19, 0.08, 0.15, 0.04, style.shirt);
        collar.rotation.z = side * 0.4;
      }
    }
  }


  dressBody(body, style);
  cylinder(body, 0, 1.26, 0, 0.09, 0.16, style.skin);
  const { head, mouth } = makeHead(body, style);
  if(style.bottom.includes('skirt')) {
    cylinder(body,0,.655,0,.335,.29,style.pants,.226);
    if(style.bottom==='pleated skirt') for(let i=0;i<10;i++) {
      const a=i*Math.PI/5;
      oval(body,Math.sin(a)*.284,.612,Math.cos(a)*.284,.044,.105,.044,style.pants);
    }
  }
  const arms = [],
    legs = [],
    knees = [];
  for (const side of [-1, 1]) {
    const arm = group(body, side * 0.32, 1.12, 0);
    oval(arm, 0, -0.14, 0, 0.1, 0.23, 0.1, style.shirt);
    oval(arm, 0, -0.34, 0, 0.09, 0.1, 0.09, style.skin);
    arms.push(arm);
    const leg = group(body, side * 0.13, 0.68, 0);
    const wide=style.bottom==='wide', bare=style.bottom==='shorts'||style.bottom.includes('skirt');
    box(leg,0,-.15,0,wide?.23:.17,.30,wide?.23:.19,style.pants);
    if(style.bottom==='cargo') box(leg,side*.087,-.18,.014,.052,.13,.15,style.pants);
    const knee = group(leg, 0, -0.3, 0);
    box(knee,0,-.13,0,wide?.22:.16,.26,wide?.22:.18,bare?style.skin:style.pants);
    if(style.bottom==='cuffed') box(knee,0,-.21,0,.184,.066,.204,style.trim);
    if(style.shoes==='boots') cylinder(knee,0,-.19,0,.10,.17,style.leather);
    oval(knee,0,-.26,.06,.12,style.shoes==='loafers'?.057:.074,.19,style.leather);
    if(style.shoes==='sneakers') box(knee,0,-.30,.056,.18,.034,.30,'#eee7db');
    legs.push(leg);
    knees.push(knee);
  }
  return {head, mouth, arms, legs, knees};
}
