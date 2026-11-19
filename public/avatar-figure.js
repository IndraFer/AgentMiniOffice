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
    oval(head, 0, 0, 0, 0.36, 0.36, 0.31, style.skin);
    oval(head, 0, 0.21, -0.03, 0.37, 0.2, 0.31, style.hair);
    const hair = style.hairStyle;
    if (["crop", "side-part", "bob"].includes(hair))
      oval(head, -0.16, 0.18, 0.22, 0.22, 0.12, 0.13, style.hair);
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
      oval(head, side * 0.12, 0, 0.287, 0.035, 0.05, 0.02, "#302f34");
      oval(head, side * 0.22, -0.11, 0.25, 0.055, 0.025, 0.015, "#d39683");
      if (style.accessory === 1)
        box(head, side * 0.13, 0.01, 0.32, 0.19, 0.14, 0.035, "#4b565b", {
          transparent: true,
          opacity: 0.5,
        });
      if (style.accessory === 2) oval(head, side * 0.36, 0.04, -0.02, 0.07, 0.14, 0.13, "#f3e9d2");
    }
    const mouth = box(head, 0, -0.14, 0.29, 0.09, 0.025, 0.02, "#9a6253");
    return { head, mouth };
  }

  function dressBody(body, style) {
    oval(body, 0, 0.96, 0, 0.29, 0.38, 0.2, style.shirt);
    if (style.outfit === "tunic") {
      box(body, 0, 0.73, 0, 0.46, 0.27, 0.32, style.shirt);
      for (const side of [-1, 1]) oval(body, side * 0.22, 0.72, 0, 0.11, 0.15, 0.17, style.shirt);
    }
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
  const arms = [],
    legs = [],
    knees = [];
  for (const side of [-1, 1]) {
    const arm = group(body, side * 0.32, 1.12, 0);
    oval(arm, 0, -0.14, 0, 0.1, 0.23, 0.1, style.shirt);
    oval(arm, 0, -0.34, 0, 0.09, 0.1, 0.09, style.skin);
    arms.push(arm);
    const leg = group(body, side * 0.13, 0.68, 0);
    box(leg, 0, -0.15, 0, 0.17, 0.3, 0.19, "#465362");
    const knee = group(leg, 0, -0.3, 0);
    box(knee, 0, -0.13, 0, 0.16, 0.26, 0.18, "#465362");
    oval(knee, 0, -0.26, 0.06, 0.12, 0.07, 0.19, "#f2e8d6");
    legs.push(leg);
    knees.push(knee);
  }
  return {head, mouth, arms, legs, knees};
}
