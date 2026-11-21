// A fixed dollhouse office. Only actors, light and status surfaces change on updates.
import * as THREE from "three";
import { buildFigure, createShapes } from './avatar-figure.js';
import { workVariants, atStation } from './office-variants.js';
import { eventCue, stationActivity, writingSignal } from "./office-activity.js";
import {
  avatarStyle,
  createLayout,
  createSimulation,
  hash,
  moodAt,
  servesRoom,
} from "./office-model.js";
import { createPoseAccent } from "./office-poses.js";
import { createWeatherScene } from "./office-weather.js";

const badgeColors = {
  work: { dot: "#157466", fill: "#29665c", ink: "#fff" },
  wait: { dot: "#c17907", fill: "#ffdf8d", ink: "#523709" },
  error: { dot: "#b93633", fill: "#9d2f30", ink: "#fff" },
  quiet: { dot: "#6b7278", fill: "#525a61", ink: "#fff" },
};
const quietActions = new Set(["waiting", "standby", "break", "away", "onboarding", "inactive"]);
function badgeTone(active, cue, action) {
  if (!active) return badgeColors.quiet;
  if (cue === "error") return badgeColors.error;
  if (cue === "human-waiting") return badgeColors.wait;
  return quietActions.has(action) ? badgeColors.quiet : badgeColors.work;
}

// Static decorative DOM behind WebGL: no particle engine, timers or extra render loop.
function createSkyLayer(container) {
  const sky = document.createElement("div");
  sky.className = "scene-sky";
  sky.setAttribute("aria-hidden", "true");
  const stars = document.createElement("div");
  stars.className = "scene-stars";
  for (let index = 0; index < 48; index++) {
    const seed = hash(`office-star-${index}`);
    const star = document.createElement("i");
    star.style.setProperty("--star-x", `${(seed % 980) / 10 + 1}%`);
    star.style.setProperty("--star-y", `${((seed >>> 10) % 900) / 10 + 3}%`);
    star.style.setProperty("--star-size", `${1 + (seed % 3) * 0.6}px`);
    stars.append(star);
  }
  sky.append(stars);
  for (const name of ["sun", "moon", "clouds"]) {
    const object = document.createElement("div");
    object.className = `scene-${name}`;
    sky.append(object);
  }
  container.append(sky);
  return sky;
}

// Deal whole accessory sets once per page load, not on a snapshot or scene remount.
function dealDeskSets() {
  const sets = [
    { cup: -0.82, pencils: [[-0.71, 0.08, 0.62, '#ce993e'], [-0.85, 0.15, 0.37, '#527582']] },
    { sheets: 3, pencils: [[-0.44, 0.17, -0.19, '#b47155']] },
    { plant: true },
    { cup: 0.56, cupZ: -0.40, pencils: [[-0.79, -0.05, 1.12, '#587b74'], [-0.69, 0.22, -1.30, '#d4a44a']] },
    { notebook: true, cup: 0.84, pencils: [[-0.48, 0.18, 0.21, '#be805d']] },
    { sheets: 1, cup: -0.88 },
    { notebook: true, plant: true, pencils: [[-0.48, 0.16, 0.23, '#ce993e']] },
  ];
  for (let i = sets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sets[i], sets[j]] = [sets[j], sets[i]];
  }
  const shift = limit => (Math.random() * 2 - 1) * limit;
  return sets.map(set => ({
    ...set,
    offsetX: shift(0.024), offsetZ: shift(0.028), angle: shift(0.045),
    pencils: set.pencils?.map(([x,z,a,color]) => [x + shift(0.016), z + shift(0.024), a + shift(0.09), color]),
  }));
}
const pageDeskSets = dealDeskSets();

export function createOfficeScene({ container, onSelect }) {
  const layout = createLayout();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const simulation = createSimulation(layout, () => !reduced.matches);
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute(
    "aria-label",
    "Virtual office. Select agents using the adjacent agent list.",
  );
  const skyLayer = createSkyLayer(container);
  container.append(renderer.domElement);
  const camera = new THREE.OrthographicCamera(-15, 15, 10, -10, 0.1, 150);
  const materials = new Map();
  const geometries = new Set();
  const textures = new Set();
  const actors = new Map();
  const screens = new Map();
  const parkedMice = new Map();
  const relationships = new Map();
  const lamps = [];
  const fish = [];
  const cabinetDoors = [];
  const cabinetBooks = new Map();
  const staticBatches = [];
  const owned = new Set();
  let selectedId = null;
  let disposed = false,
    enabled = false,
    frame = 0,
    last = 0,
    time = 0,
    frames = 0;
  let lastMinute = "",
    currentTheme = "";
  let currentMood,
    moodText = "",
    weatherAppearanceKey = "";
  const orbit = { yaw: 0.48, pitch: 0.72, zoom: 1 };
  const shapes = createShapes(materials, geometries);
  const { material, mesh, cubeGeometry, box, oval, cylinder, group } = shapes;
  function canvasTexture(width, height, draw) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext("2d"), width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    return texture;
  }
  function floorLabelTexture(text) {
    return canvasTexture(512, 96, (ctx, w, h) => {
      ctx.font = "650 40px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // A light edge should not dominate small lettering viewed at an angle.
      ctx.lineJoin = "round";
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#dce2df";
      ctx.strokeText(text, w / 2, h / 2, w - 32);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, w / 2, h / 2, w - 32);
    });
  }
  function boardTexture(text) {
    return canvasTexture(512, 224, (ctx, w, h) => {
      ctx.fillStyle = "#f7f5e9";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#70958a";
      ctx.fillRect(22, 22, 7, h - 44);
      ctx.fillStyle = "#6b827a";
      ctx.font = "600 19px system-ui";
      ctx.fillText("CURRENT FOCUS", 48, 48);
      ctx.fillStyle = "#334e48";
      ctx.font = "500 30px system-ui";
      const words = text.slice(0, 58).split(" ");
      let line = "",
        y = 104;
      for (const word of words) {
        if (line && ctx.measureText(`${line} ${word}`).width > w - 90) {
          ctx.fillText(line, 48, y, w - 90);
          y += 42;
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      ctx.fillText(line, 48, Math.min(y, 188), w - 90);
    });
  }
  function floorText(text, x, z, width = 3.4) {
    const mat = new THREE.MeshBasicMaterial({
      map: floorLabelTexture(text),
      toneMapped: false,
      transparent: true,
      depthWrite: false,
    });
    owned.add(mat);
    const object = mesh(
      new THREE.PlaneGeometry(width, (width * 96) / 512),
      mat,
      scene,
      x,
      0.036,
      z,
    );
    object.rotation.x = -Math.PI / 2;
    object.castShadow = false;
    object.receiveShadow = false;
    return object;
  }
  const measure = document.createElement("canvas").getContext("2d");
  // Labels are measured in CSS pixels; the orthographic camera maps them into world units.
  function labelTexture(text, tone, identity) {
    const font = identity ? "700 12px system-ui" : "600 11px system-ui";
    const padding = identity ? 24 : 16;
    measure.font = font;
    const chars = Array.from(text);
    let fitted = text;
    while (measure.measureText(fitted).width > 144 && chars.length) {
      chars.pop();
      fitted = `${chars.join("")}…`;
    }
    const w = Math.ceil(measure.measureText(fitted).width) + padding;
    return canvasTexture(w * 3, 20 * 3, (ctx) => {
      ctx.scale(3, 3);
      ctx.fillStyle = identity ? "#fffdf8" : tone.fill;
      ctx.strokeStyle = identity ? "#726f66" : "#fffdf8";
      ctx.beginPath();
      ctx.roundRect(0.5, 0.5, w - 1, 19, 9);
      ctx.fill();
      ctx.stroke();
      if (identity) {
        ctx.fillStyle = tone.dot;
        ctx.beginPath();
        ctx.arc(8, 10, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = identity ? "#262f30" : tone.ink;
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillText(fitted, identity ? 15 : 8, 10);
    });
  }
  function spriteLabel(text, identity = false) {
    const texture = labelTexture(text, badgeColors.quiet, identity);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    owned.add(mat);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.05, 0.385, 1);
    sprite.renderOrder = 4;
    return sprite;
  }
  const wood = canvasTexture(512, 512, (ctx) => {
    const colors = ["#d4b28a", "#ddbf9b", "#d9b994", "#e1c5a3"];
    for (let row = 0; row < 12; row++) {
      for (let col = -1; col < 4; col++) {
        const x = col * 180 + (row % 2) * 90;
        ctx.fillStyle = colors[(row + col + 4) % 4];
        ctx.fillRect(x + 1, row * 43 + 1, 178, 41);
        ctx.fillStyle = "#83664118";
        for (let j = 0; j < 4; j++) ctx.fillRect(x + 10 + j * 7, row * 43 + 8 + j * 7, 120, 1);
      }
    }
  });
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  wood.repeat.set(3, 2);
  box(scene, 10, -0.31, 7, 20.3, 0.5, 14.3, "#c2ad96");
  mesh(new THREE.BoxGeometry(20, 0.1, 14), material("#ffffff", { map: wood }), scene, 10, -0.05, 7);
  const wallMat = material("#f0e8db");
  const wall = (x, z, w, d, h) => {
    const object = mesh(cubeGeometry, wallMat, scene, x, h / 2, z);
    object.scale.set(w, h, d);
    box(scene, x, h + 0.04, z, w + 0.04, 0.08, d + 0.04, "#e0d4c1");
  };
  // Actual wall openings: transparent panes show the sky, not an opaque wall behind them.
  wall(10, 0, 20, 0.16, 1.18);
  for (const [left, right] of [
    [0, 2.35],
    [6.65, 7.85],
    [12.15, 13.85],
    [18.15, 20],
  ])
    wall((left + right) / 2, 0, right - left, 0.16, 2.7);
  box(scene, 10, 2.6, 0, 20, 0.2, 0.16, "#f0e8db");
  wall(0, 7, 0.16, 14, 1.0);
  wall(20, 7, 0.16, 14, 0.45);
  // Large northern windows stay behind the action; foreground walls are cut away.
  const windowMat = material("#c9e4e7", {
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    roughness: 0.3,
    emissive: "#c7dee6",
    emissiveIntensity: 0.1,
  });
  for (const x of [4.5, 10, 16]) {
    for (const side of [-1, 1]) {
      box(scene, x + side * 2.12, 1.85, 0.13, 0.075, 1.35, 0.13, "#c7cdc8");
      box(scene, x, 1.85 + side * 0.65, 0.13, 4.3, 0.07, 0.13, "#c7cdc8");
    }
    const glass = mesh(cubeGeometry, windowMat, scene, x, 1.85, 0.21);
    glass.scale.set(4.1, 1.2, 0.03);
    glass.castShadow = false;
    box(scene, x, 1.85, 0.24, 0.05, 1.25, 0.05, "#f0e8db");
    box(scene, x, 1.2, 0.27, 4.5, 0.1, 0.3, "#f0e8db");
  }
  for (const rug of layout.rugs) {
    box(scene, rug.x, 0.013, rug.z, rug.w, 0.026, rug.d, rug.color);
    floorText(rug.label, rug.x, rug.z + rug.d / 2 - 0.48, 3.6);
  }
  const officeSign = floorText("Office", 4.5, 13.7, 6.5);
  let signName = "Office";
  for (const partition of layout.partitions) {
    const { x, z, w, d } = partition;
    box(scene, x, 0.22, z, w, 0.44, d, "#e3d9c9");
    const pane = box(scene, x, 1.43, z, w, 1.98, d, "#c8e2df", {
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    pane.castShadow = false;
    box(scene, x, 2.45, z, w + 0.025, 0.055, d + 0.025, "#8f9e97");
    for (const sign of [-1, 1])
      box(
        scene,
        x + (w > d ? (w / 2) * sign : 0),
        1.45,
        z + (d > w ? (d / 2) * sign : 0),
        0.055,
        2,
        0.055,
        "#8f9e97",
      );
  }
  floorText("IN", 12.95, 5.1, 0.65);

  function chair(x, z, rotation, color = "#78918d") {
    const root = group(scene, x, 0, z, rotation);
    cylinder(root, 0, 0.19, 0, 0.29, 0.05, "#59615f");
    cylinder(root, 0, 0.37, 0, 0.055, 0.35, "#59615f");
    box(root, 0, 0.57, 0, 0.68, 0.14, 0.66, color);
    box(root, 0, 0.96, -0.29, 0.69, 0.65, 0.12, color);
  }
  function table(root, w, d, height = 0.92) {
    box(root, 0, height, 0, w, 0.12, d, "#dec4a1");
    for (const x of [-w / 2 + 0.17, w / 2 - 0.17])
      for (const z of [-d / 2 + 0.13, d / 2 - 0.13])
        box(root, x, height / 2, z, 0.09, height, 0.09, "#64716c");
  }
  function pencil(parent, x, surface, z, yaw, color) {
    const p = group(parent, x, surface + 0.016, z, yaw);
    box(p, 0, 0, 0, 0.03, 0.03, 0.31, color);
    cylinder(p, 0, 0, 0.177, 0.018, 0.045, '#d0aa78', 0.003).rotation.x = Math.PI / 2;
    box(p, 0, 0, -0.168, 0.032, 0.032, 0.028, '#c98c84');
  }
  const screenArt = new Map(
    ["idle", "code", "document", "chart"].map((kind) => {
      const texture = canvasTexture(192, 128, (ctx, w, h) => {
        ctx.fillStyle = kind === "document" ? "#e6e7dc" : "#203c4a";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#72958d";
        ctx.fillRect(0, 0, w, 15);
        if (kind === "idle") {
          ctx.fillStyle = "#8ca9a2";
          ctx.font = "14px system-ui";
          ctx.fillText("STANDBY", 57, 74);
        }
        if (kind === "document" || kind === "code")
          for (let i = 0; i < 7; i++) {
            ctx.fillStyle =
              kind === "document" ? "#79918b" : ["#9fc7bc", "#e0bd88", "#97b5d1"][i % 3];
            ctx.fillRect(
              16 + (kind === "code" ? (i % 3) * 9 : 0),
              27 + i * 12,
              90 + (i % 3) * 22,
              4,
            );
          }
        if (kind === "chart") {
          ctx.fillStyle = "#c7dfd9";
          ctx.font = "12px system-ui";
          ctx.fillText("ILLUSTRATION", 14, 32);
          for (let i = 0; i < 8; i++) {
            ctx.fillStyle = i % 2 ? "#d7b57f" : "#8bb7ac";
            const height = 20 + ((i * 13) % 60);
            ctx.fillRect(15 + i * 21, 115 - height, 12, height);
          }
        }
      });
      renderer.initTexture(texture);
      return [kind, texture];
    }),
  );
  function monitor(root, id, x = 0, z = -0.2) {
    box(root, x, 1.34, z, 0.94, 0.63, 0.09, "#3c474b");
    const screenMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: screenArt.get("idle"),
      emissiveMap: screenArt.get("idle"),
      emissive: "#c8dbf0",
      emissiveIntensity: 0.45,
      roughness: 0.4,
    });
    owned.add(screenMat);
    const screen = mesh(cubeGeometry, screenMat, root, x, 1.35, z + 0.05);
    screen.scale.set(0.83, 0.5, 0.012);
    screen.castShadow = false;
    screens.set(id, screen);
    box(root, x, 1.02, z, 0.08, 0.2, 0.1, "#59615f");
    box(root, x, 0.99, z, 0.42, 0.035, 0.27, "#59615f");
    box(root, x, 1.0, 0.26, 0.64, 0.035, 0.25, "#f5efe3");
  }
  let boardSurface, boothReceiver, printerSheet;
  const boardMarks = [];
  const drinkStreams = new Map();
  function drinkStream(root, id, x, y, z, color) {
    const stream = cylinder(root, x, y, z, 0.021, 0.15, color);
    stream.userData.dynamic = true;
    stream.castShadow = false;
    stream.visible = false;
    drinkStreams.set(id, stream);
  }
  const ambientObjects = {
    coffee: ["pour", "Coffee"],
    water: ["pour", "Water"],
    aquarium: ["watching", "Aquarium"],
    "plant-14-8": ["watering", "Plants"],
    'board-view': ['watching', 'Looking at Board'],
    'meeting-table': ['resting', 'Quiet Seat'],
    sofa: ["break", "Lounge"],
  };
  function handset(parent, x, y, z) {
    const receiver = group(parent, x, y, z);
    oval(receiver, 0, 0.055, 0, 0.24, 0.04, 0.055, "#30343b");
    for (const side of [-1, 1]) {
      oval(receiver, side * 0.16, 0.025, 0, 0.1, 0.05, 0.065, "#30343b");
      oval(receiver, side * 0.23, -0.015, 0, 0.1, 0.075, 0.11, "#30343b");
    }
    return receiver;
  }
  let deskIndex = 0;
  for (const item of layout.furniture) {
    const root = group(scene, item.x, 0, item.z, item.rotation ?? 0);
    const { kind, w, d } = item;
    if (kind === "desk") {
      table(root, w, d);
      // Read from the chair: keep the front strip usable and drinks in the monitor row.
      const extras = pageDeskSets[deskIndex++] ?? {};
      const decor = group(root, extras.offsetX, 0, extras.offsetZ, extras.angle);
      const style = hash(item.id) % 6;
      monitor(root, item.id, [0.04, -0.12, 0, 0.13, -0.06, 0.08][style]);
      const padX = 0.50, padZ = 0.35;
      box(root, padX, 0.988, padZ, 0.32, 0.015, 0.33, style % 2 ? '#b3c1bf' : '#9eaeb8');
      const mouse = oval(root, padX, 1.024, padZ, 0.073, 0.038, 0.105, '#404e59');
      mouse.userData.dynamic = true;
      parkedMice.set(item.id, mouse);
      if (extras.cup !== undefined)
        cylinder(decor, extras.cup, 1.08, extras.cupZ ?? -0.34, 0.095, 0.20, ['#d49c77','#809ca9','#eee2c5','#88a48c'][style % 4]);
      if (extras.sheets) {
        for (let page = 0; page < extras.sheets; page++)
          box(decor, -0.77 + page * 0.015, 0.99 + page * 0.015, 0.14, 0.40, 0.015, 0.46, page % 2 ? '#f7eddf' : '#d6dfd8').rotation.y = 0.10 * page;
      } else if (extras.notebook) {
        box(decor, -0.82, 1.005, 0.07, 0.34, 0.05, 0.42, style ? '#7b9a9d' : '#a88597').rotation.y = -0.18;
      }
      if (extras.plant) {
        cylinder(decor, 0.90, 1.055, -0.31, 0.11, 0.15, '#ddc7a5');
        oval(decor, 0.90, 1.22, -0.31, 0.12, 0.17, 0.12, '#71956d');
      }
      for (const [x, z, angle, color] of extras.pencils ?? []) pencil(decor, x, 0.98, z, angle, color);
    } else if (kind === "desk-divider") {
      const pane = box(root, 0, 1.2, 0, w, 0.5, d, "#bbdedc", {
        transparent: true,
        opacity: 0.65,
        roughness: 1,
        depthWrite: false,
      });
      pane.castShadow = false;
      box(root, 0, 1.46, 0, w + 0.03, 0.035, d + 0.02, "#d1ddd8");
      for (const side of [-1, 1])
        box(root, side * (w / 2 - 0.04), 1.18, 0, 0.045, 0.58, d + 0.02, "#b6c7c4");
    } else if (kind === "tv") {
      box(root, 0, 0.15, 0, 0.4, 0.1, 1.1, "#7e9395");
      box(root, 0, 0.9, 0, 0.07, 1.5, 0.09, "#9cafaf");
      box(root, 0, 1.75, 0, 0.14, 1.0, 1.7, "#586e74");
      const mat = material("#ffffff", {
        map: screenArt.get("chart"),
        emissiveMap: screenArt.get("chart"),
        emissive: "#b6d2d4",
        emissiveIntensity: 0.2,
      });
      const display = mesh(new THREE.PlaneGeometry(1.58, 0.88), mat, root, -0.08, 1.75, 0);
      display.rotation.y = -Math.PI / 2;
      display.castShadow = false;
    } else if (kind === "meeting-table") {
      table(root, w, d);
      box(root, -0.8, 1.0, 0.05, 0.6, 0.035, 0.4, "#829c98");
      cylinder(root, 0, 1.08, 0, 0.14, 0.2, "#ece8db");
      oval(root, 0, 1.3, 0, 0.22, 0.3, 0.22, "#6d9163");
    } else if (kind === "sofa") {
      box(root, 0, 0.35, 0, w, 0.45, d, "#87978c");
      box(root, 0, 0.85, -0.42, w, 0.85, 0.25, "#819487");
      for (const x of [-1.3, 0, 1.3]) box(root, x, 0.63, 0.05, 1.22, 0.2, 0.75, "#a3b3a0");
      for (const x of [-1.85, 1.85]) box(root, x, 0.7, 0, 0.2, 0.55, 1.1, "#819487");
      // Plump, rounded cushions lean into the arms, clear of both reserved seats.
      const cushion = new THREE.SphereGeometry(1, 20, 12);
      const vertices = cushion.attributes.position;
      const soften = (n) => Math.sign(n) * Math.pow(Math.abs(n), 0.65);
      for (let i = 0; i < vertices.count; i++) {
        vertices.setXYZ(i, soften(vertices.getX(i)), soften(vertices.getY(i)), soften(vertices.getZ(i)));
      }
      cushion.computeVertexNormals();
      for (const side of [-1, 1]) {
        const pillow = mesh(cushion, material(side < 0 ? "#c8b399" : "#97ada3"), root, side * 1.48, 0.95, -0.12);
        pillow.scale.set(0.28, 0.24, 0.15);
        pillow.rotation.set(-0.18, side * 0.10, -side * 0.22);
      }
    } else if (kind === "coffee-table") {
      table(root, w, d, 0.46);
      box(root, -0.35, 0.55, 0, 0.5, 0.06, 0.34, "#b57458");
      cylinder(root, 0.4, 0.6, 0, 0.09, 0.18, "#eee8db");
    } else if (kind === "plant") {
      cylinder(root, 0, 0.28, 0, 0.25, 0.5, "#cfb49a", 0.3);
      for (const [x, y, z] of [
        [0, 0.85, 0],
        [-0.16, 0.74, 0.08],
        [0.14, 0.69, -0.07],
      ])
        oval(root, x, y, z, 0.22, 0.48, 0.22, "#64896a");
    } else if (kind === "whiteboard") {
      box(root, 0, 1.45, 0, w, 1.45, d, "#a9b7ac");
      const mat = new THREE.MeshStandardMaterial({
        map: boardTexture("Ready for ideas"),
        roughness: 1,
      });
      owned.add(mat);
      boardSurface = mesh(
        new THREE.PlaneGeometry(w - 0.18, 1.25),
        mat,
        root,
        0,
        1.45,
        d / 2 + 0.01,
      );
      for (let i = 0; i < 4; i++) {
        const mark = box(
          root,
          -0.65 + i * 0.35,
          1.17 + (i % 2) * 0.07,
          d / 2 + 0.023,
          0.28,
          0.028,
          0.008,
          "#497b73",
        );
        mark.userData.dynamic = true;
        mark.rotation.z = i % 2 ? 0.25 : -0.15;
        mark.visible = false;
        boardMarks.push(mark);
      }
      box(root, 0, 0.7, 0.1, w, 0.035, 0.16, "#b9c7c5");
      for (const side of [-1, 1]) {
        box(root, side * 1.25, 0.4, 0, 0.045, 0.8, 0.06, "#a2b3b0");
        box(root, side * 1.25, 0.07, 0, 0.25, 0.06, 0.42, "#a2b3b0");
      }
    } else if (kind === "library") {
      box(root, 0, 1, -0.28, w, 2, 0.12, "#ac8b66");
      for (const x of [-w / 2, w / 2]) box(root, x, 1, 0, 0.1, 2, d, "#b99b76");
      for (const y of [0.1, 0.75, 1.4, 2]) {
        box(root, 0, y, 0, w, 0.08, d, "#cbb08b");
        if (y < 2)
          for (let i = 0; i < 8; i++)
            box(
              root,
              -1 + i * 0.27,
              y + 0.27,
              0.02,
              0.19,
              0.44 + (i % 2) * 0.09,
              0.4,
              ["#78969e", "#c68769", "#d7c8a8", "#8e9d77"][i % 4],
            );
      }
    } else if (kind === "archive") {
      box(root, 0, 0.85, -0.26, w, 1.7, 0.12, "#91a5ac");
      for (const side of [-1, 1]) box(root, side * 0.58, 0.85, 0, 0.08, 1.7, d, "#9cafb4");
      for (const y of [0.1, 0.7, 1.25, 1.7]) box(root, 0, y, 0, w, 0.07, d, "#c6d0ca");
      for (let i = 0; i < 5; i++)
        box(
          root,
          -0.44 + i * 0.21,
          0.95,
          0,
          0.16,
          0.4,
          0.38,
          ["#c8ae84", "#8e9fae", "#b2bda1"][i % 3],
        );
      // A stack on the upper shelf; only the top volume moves during a reported compaction.
      for (const [i,color] of ['#65788e','#d5b485','#828c63'].entries()) {
        const volume=box(root,0,1.32+i*.08,.04,.53,.075,.36,color);
        if (i===2) { volume.userData.dynamic=true; cabinetBooks.set(item.id,volume); }
      }
      for (const side of [-1, 1]) {
        const door = group(root, side * 0.59, 0, 0.34);
        door.userData.dynamic = true;
        door.userData.side = side;
        door.userData.station = item.id;
        box(door, -side * 0.29, 0.86, 0, 0.58, 1.65, 0.055, "#b3c3c5");
        box(door, -side * 0.48, 0.9, 0.055, 0.035, 0.22, 0.035, "#657d84");
        cabinetDoors.push(door);
      }
    } else if (kind === "aquarium") {
      box(root, 0, 0.4, 0, w, 0.8, d, "#a1b8b5");
      box(root, 0, 0.82, 0, w + 0.06, 0.08, d + 0.04, "#d0dfd4");
      const glass = box(root, 0, 1.21, 0, w, 0.72, d, "#82c9d3", {
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      });
      glass.castShadow = false;
      box(root, 0, 0.91, 0, w - 0.08, 0.06, d - 0.08, "#ddcfac");
      for (const side of [-1, 1]) {
        const swimmer = group(root, side * 0.35, 1.2, side * 0.1);
        swimmer.userData.dynamic = true;
        oval(swimmer, 0, 0, 0, 0.16, 0.08, 0.055, side < 0 ? "#e7a46c" : "#7fadd0").castShadow =
          false;
        const tail = box(swimmer, -0.16, 0, 0, 0.09, 0.12, 0.025, "#edc295");
        tail.rotation.z = 0.5;
        tail.castShadow = false;
        fish.push({ root: swimmer, phase: side < 0 ? 0 : Math.PI });
      }
      oval(root, 0.6, 1.07, 0.05, 0.09, 0.2, 0.08, "#6aab8e");
      box(root, 0, 1.59, 0, w + 0.04, 0.06, d + 0.02, "#a4c1c1");
    } else if (kind === "printer") {
      box(root, 0, 0.45, 0, w, 0.9, d, "#d5c5ad");
      box(root, 0, 1.1, 0, 0.9, 0.4, 0.65, "#e8e6dd");
      box(root, 0, 1.32, 0, 0.65, 0.04, 0.45, "#586663");
      printerSheet = box(root, 0, 1.03, 0.37, 0.6, 0.03, 0.34, "#f9f6ec");
      printerSheet.userData.dynamic = true;
      printerSheet.visible = false;
    } else if (kind === "phone") {
      box(root, 0, 0.5, 0, w, 1, d, "#b6ac96");
      box(root, 0, 1.03, 0, w + 0.04, 0.06, d + 0.04, "#e4d6be");
      const telephone = group(root, 0, 1.12, 0, Math.PI / 2);
      const base = box(telephone, 0, 0, 0, 0.62, 0.13, 0.65, "#5a626c");
      base.rotation.x = -0.13;
      box(telephone, 0, 0.095, -0.075, 0.3, 0.025, 0.1, "#9dadae");
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 3; col++)
          box(
            telephone,
            (col - 1) * 0.085,
            0.085,
            0.03 + row * 0.06,
            0.055,
            0.025,
            0.04,
            "#d5d9dc",
          );
      boothReceiver = handset(telephone, 0, 0.15, -0.22);
      boothReceiver.userData.dynamic = true;
      for (let i = 0; i < 12; i++)
        oval(
          telephone,
          -0.3 + Math.cos(i * 1.8) * 0.025,
          0.07,
          -0.15 + i * 0.028,
          0.02,
          0.018,
          0.02,
          "#30343b",
        );
    } else if (kind === "tool-cart") {
      // A freestanding drawer trolley with casters, a shallow tray and a handled tool.
      for (const x of [-0.24, 0.24]) for (const z of [-0.31, 0.31])
        oval(root, x, 0.11, z, 0.09, 0.11, 0.09, '#404849');
      box(root, 0, 0.55, 0, w, 0.72, d, '#517b78');
      for (const y of [0.42, 0.68]) box(root, w / 2, y, 0, 0.05, 0.045, 0.44, '#c2ceca');
      box(root, 0, 0.94, 0, w, 0.08, d, '#495957');
      box(root, 0.07, 1.01, 0, 0.05, 0.045, 0.38, '#c9d1cf');
      box(root, 0.07, 1.02, 0.18, 0.10, 0.07, 0.19, '#d2965f');
    } else if (kind === "extinguisher") {
      box(root, -0.16, 0.65, 0, 0.14, 0.47, 0.23, "#555c59");
      cylinder(root, 0, 0.59, 0, 0.18, 0.68, "#c93d34");
      oval(root, 0, 0.94, 0, 0.18, 0.11, 0.18, "#c93d34");
      cylinder(root, 0, 1.05, 0, 0.065, 0.13, "#626a68");
      box(root, 0, 1.14, 0.05, 0.09, 0.06, 0.26, "#373e40");
      box(root, 0.175, 0.64, 0, 0.015, 0.24, 0.16, "#f7edcf");
      cylinder(root, 0, 0.82, -0.20, 0.032, 0.41, "#343d40");
    } else if (kind === "waste-bin") {
      cylinder(root, 0, 0.34, 0, 0.23, 0.66, "#657b77", 0.29);
      cylinder(root, 0, 0.68, 0, 0.30, 0.07, "#879a94");
      cylinder(root, 0, 0.718, 0, 0.24, 0.012, "#303e40");
    } else if (kind === "water") {
      box(root, 0, 0.55, 0, 0.57, 1.1, 0.56, "#dae5df");
      const bottle = cylinder(root, 0, 1.38, 0, 0.23, 0.56, "#8cb9ce", 0.21);
      bottle.material = material("#8cb9ce", { transparent: true, opacity: 0.68, roughness: 0.3 });
      bottle.castShadow = false;
      for (const z of [-0.12, 0.12])
        box(root, -0.32, 0.85, z, 0.08, 0.07, 0.07, z < 0 ? "#a5bfcc" : "#bf8b7c");
      box(root, -0.31, 0.61, 0, 0.18, 0.04, 0.37, "#8da4a7");
      drinkStream(root, item.id, -0.33, 0.74, -0.12, "#9fcada");
    } else if (kind === "coffee") {
      box(root, 0, 0.5, 0, w, 1, d, "#b79974");
      box(root, 0, 1.04, 0, w + 0.05, 0.08, d + 0.05, "#ede1ca");
      box(root, 0, 1.36, -0.4, 0.65, 0.55, 0.55, "#4d5c5b");
      box(root, -0.36, 1.25, -0.4, 0.12, 0.22, 0.4, "#c3d0cb");
      box(root, -0.43, 1.38, -0.4, 0.1, 0.05, 0.09, "#8da19e");
      cylinder(root, -0.4, 1.14, -0.4, 0.075, 0.12, "#f5edde");
      drinkStream(root, item.id, -0.43, 1.28, -0.4, "#654537");
      cylinder(root, 0.08, 1.72, -0.4, 0.16, 0.2, "#a3b9b4");
      cylinder(root, -0.1, 1.2, 0.25, 0.1, 0.2, "#f5edde");
    } else {
      box(root, 0, 0.5, 0, w, 1, d, "#b6ac96");
      box(root, 0, 1.05, 0, w, 0.1, d, "#e0c7a3");
      if (kind === "workshop") {
        // Tabletop props share the workbench's existing station.
        const shredder = group(root, -0.04, 1.1, -0.52, 0.35);
        box(shredder, 0, 0.19, 0, 0.42, 0.38, 0.27, '#788884');
        box(shredder, 0, 0.41, 0, 0.46, 0.08, 0.31, '#475454');
        box(shredder, 0, 0.452, 0, 0.32, 0.01, 0.032, '#222d30');
        box(shredder, 0, 0.51, -0.01, 0.25, 0.13, 0.012, '#efece4').rotation.x = -0.12;
        const vise = group(root, 0.19, 1.1, -0.01, 0.16);
        box(vise, 0, 0.035, 0, 0.22, 0.07, 0.21, '#536164');
        box(vise, 0, 0.095, 0, 0.27, 0.07, 0.13, '#984f42');
        for (const x of [-0.09, 0.09]) {
          box(vise, x, 0.14, 0, 0.07, 0.12, 0.19, '#984f42');
          box(vise, x, 0.205, 0, 0.07, 0.022, 0.20, '#b9c4c4');
        }
        cylinder(vise, 0.15, 0.10, 0, 0.033, 0.09, '#586363').rotation.z = Math.PI / 2;
        box(vise, 0.19, 0.10, 0, 0.023, 0.17, 0.023, '#b9c4c4').rotation.x = 0.4;
        pencil(root, -0.13, 1.1, 0.92, 0.73, '#cca14f');
        pencil(root,  0.01, 1.1, 0.89, 0.50, '#748d91');
        pencil(root,  0.14, 1.1, 0.95, 0.87, '#b77868');
        const cameraProp = group(root, 0.04, 1.1, 0.45, 0.48);
        cameraProp.scale.setScalar(1.2);
        box(cameraProp, 0, 0.085, 0, 0.27, 0.17, 0.11, '#444d52');
        box(cameraProp, -0.055, 0.183, 0, 0.09, 0.033, 0.08, '#616b70');
        cylinder(cameraProp, 0.025, 0.09, 0.085, 0.073, 0.09, '#282d32').rotation.x = Math.PI / 2;
        cylinder(cameraProp, 0.025, 0.09, 0.135, 0.051, 0.012, '#486370').rotation.x = Math.PI / 2;
      } else {
        box(root, -0.2, 1.75, 0, 0.12, 1.4, d, "#9baaa0");
        box(root, 0.08, 1.2, 0, 0.35, 0.18, 0.45, "#526366");
      }
    }
  }
  for (const slot of layout.slots)
    if (slot.pose === "seated" && slot.object !== "sofa")
      chair(slot.x, slot.z, slot.rot, slot.room === "meeting" ? "#9a92b3" : "#6f8c88");

  // Wall-mounted luminaires explain the warm pools without obscuring the cutaway.
  const fixtureMaterial = material("#fff0c4", { emissive: "#ffcf83", emissiveIntensity: 0 });
  for (const x of [3.2, 6.5, 9.8, 16.5]) {
    box(scene, x, 2.57, 0.27, 1.1, 0.18, 0.2, "#6e746c");
    const fixture = mesh(cubeGeometry, fixtureMaterial, scene, x, 2.51, 0.38);
    fixture.scale.set(0.95, 0.08, 0.19);
  }
  const warmLamp = new THREE.Color('#ffd49b'), daylightLamp = new THREE.Color('#f4faff');
  const hemi = new THREE.HemisphereLight("#cdddec", "#a38c75", 2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#ffe1b3", 2.4);
  sun.position.set(-5, 25, 15);
  sun.target.position.set(10, 0, 7);
  scene.add(sun, sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 18;
  sun.shadow.camera.bottom = -18;
  sun.shadow.camera.far = 70;
  sun.shadow.normalBias = 0.035;
  sun.shadow.bias = -0.0002;
  function roomLight(x, y, z, reach) {
    const light = new THREE.PointLight("#ffd49b", 0, reach, 1.5);
    light.position.set(x, y, z);
    scene.add(light);
    return light;
  }
  // Four perimeter zones and one center, all at the same ceiling height.
  for (const [x, z] of [
    [3.2, 1.9],   // Whiteboard.
    [10.9, 2.5],  // Printer and meeting-room approach.
    [1.9, 12.2],  // Left filing cabinet.
    [10.9, 12.2], // Exit desk, with overlap toward the aquarium.
    [6.5, 6.8],   // Center of the workspace rug.
  ]) lamps.push(roomLight(x, 4.1, z, 13));
  const meetingLight = roomLight(16.5, 3.5, 3, 10);
  cylinder(scene, 19.2, 0.07, 10.6, 0.28, 0.1, "#625d52");
  cylinder(scene, 19.2, 1.15, 10.6, 0.035, 2.2, "#625d52");
  const shade = cylinder(scene, 19.2, 2.24, 10.6, 0.42, 0.4, "#f2d7a8", 0.26);
  const loungeLight = roomLight(shade.position.x, shade.position.y - 0.24, shade.position.z, 8);
  shade.material.emissive.set("#ffcc88");

  // Batch repeated opaque furniture once. Keep glass, doors, fish and status surfaces independent.
  scene.updateMatrixWorld(true);
  const batches = new Map();
  scene.traverse((object) => {
    if (!object.isMesh || object.material.transparent) return;
    for (let parent = object; parent; parent = parent.parent) if (parent.userData.dynamic) return;
    const key = `${object.geometry.uuid}:${object.material.uuid}:${object.castShadow}:${object.receiveShadow}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(object);
  });
  for (const meshes of batches.values()) {
    if (meshes.length < 3) continue;
    const first = meshes[0];
    const batch = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    meshes.forEach((object, index) => {
      batch.setMatrixAt(index, object.matrixWorld);
      object.removeFromParent();
    });
    batch.computeBoundingSphere();
    scene.add(batch);
    staticBatches.push(batch);
  }

  // The embedded and full views of one office share a simulated forecast.
  const weatherScene = createWeatherScene(THREE, scene, location.pathname.replace(/^\/embed\//, '/'), camera);

  function makeActor(data) {
    const variation = data.avatar_variation ?? null;
    const style = avatarStyle(data.id, variation);
    const root = group(scene);
    root.userData.agentId = data.sourceAgentId ?? data.id;
    const body = group(root, 0, 0.04, 0);
    const { head, mouth, arms, legs, knees } = buildFigure(body, style, shapes);
    const bulb = oval(body, 0.5, 1.95, 0.08, 0.12, 0.16, 0.12, "#f3d78e");
    bulb.visible = false;
    const ring = mesh(
      new THREE.RingGeometry(0.36, 0.43, 24),
      new THREE.MeshBasicMaterial({
        color: style.shirt,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
      }),
      root,
      0,
      0.045,
      0,
    );
    owned.add(ring.material);
    ring.rotation.x = -Math.PI / 2;
    ring.castShadow = false;
    const label = spriteLabel(data.name, true);
    label.position.y = 2.35;
    root.add(label);
    const activityLabel = spriteLabel("");
    activityLabel.position.y = 2.72;
    activityLabel.scale.set(2.5, 0.34, 1);
    root.add(activityLabel);
    const book = group(body, 0, 0.98, 0.38);
    for (const side of [-1, 1]) {
      const page = box(book, side * 0.15, 0, 0, 0.29, 0.055, 0.34, "#f1e6c9");
      page.rotation.z = side * 0.12;
    }
    box(book, 0, -0.045, 0, 0.63, 0.035, 0.36, "#678c9a");
    const pageHinge = group(book, 0, 0.046, 0);
    box(pageHinge, 0.14, 0, 0, 0.28, 0.014, 0.32, "#fff5db");
    const mouse = oval(body, -.50, 1.0, .54, .068, .035, .093, '#505d68');
    const looseSheet = box(body, -.1, 1.008, .43, .42, .018, .31, '#c4d3d8');
    const paper = box(body, 0, 1.02, 0.37, 0.47, 0.025, 0.36, "#f5eddb");
    const phone = handset(body, 0.36, 1.47, 0.05);
    phone.scale.setScalar(0.65);
    phone.rotation.z = Math.PI / 2;
    const cup = cylinder(body, 0.31, 1.13, 0.3, 0.1, 0.19, "#e4c594");
    const tablet = box(body, 0, 1.05, 0.35, 0.42, 0.035, 0.30, '#527580');
    tablet.rotation.x = -0.38;
    for (const prop of [book, paper, phone, cup, tablet, mouse, looseSheet]) prop.visible = false;
    return {
      root,
      body,
      head,
      arms,
      legs,
      knees,
      ring,
      label,
      activityLabel,
      activityText: "",
      badgeTone: badgeColors.quiet,
      mouth,
      bulb,
      book,
      pageHinge,
      paper, mouse, looseSheet,
      phone,
      cup,
      tablet,
      name: data.name,
      variation,
      style,
      phase: hash(data.id) % 100,
      poseAccent: createPoseAccent(hash(data.id)),
      baseHeight: body.position.y,
      seated: false,
    };
  }
  function destroyActor(actor) {
    scene.remove(actor.root);
    for (const label of [actor.label, actor.activityLabel]) {
      label.material.map.dispose();
      textures.delete(label.material.map);
      label.material.dispose();
      owned.delete(label.material);
    }
    actor.ring.geometry.dispose();
    geometries.delete(actor.ring.geometry);
    actor.ring.material.dispose();
    owned.delete(actor.ring.material);
  }

  const hud = document.createElement("div");
  hud.className = "scene-hud";
  const moodLabel = document.createElement("span");
  moodLabel.className = "scene-weather";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn btn-small";
  reset.textContent = "Reset View";
  const weatherStack = document.createElement("div");
  weatherStack.className = "scene-weather-stack";
  const forecastCard = document.createElement("div");
  forecastCard.className = "scene-forecast";
  const forecastTitle = document.createElement("strong");
  forecastTitle.textContent = "Simulated Forecast";
  const outlook = document.createElement("span");
  forecastCard.append(forecastTitle, outlook);
  weatherStack.append(moodLabel, forecastCard);
  hud.append(weatherStack, reset);
  container.append(hud);
  const caption = document.createElement("div");
  caption.className = "scene-caption";
  const hint = document.createElement('span');
  hint.className = 'stage-hint';
  hint.textContent = 'Drag to orbit · Scroll to zoom · Click an agent';
  const footer = document.createElement('div');
  footer.className = 'scene-footer';
  footer.append(caption, hint);
  container.append(footer);
  let captionText = "";
  function updateCaption() {
    const actor = simulation.actors.get(selectedId);
    const data = actor?.data;
    let text = `${simulation.actors.size} ${simulation.actors.size === 1 ? 'agent' : 'agents'} · Select an avatar for details`;
    if (data) {
      const kind = data.kind || '';
      const harness = ({ pi:'Pi', opencode:'OpenCode', sdk:'SDK' })[kind.toLowerCase()] ?? kind;
      const presence = data.presence ?? {};
      const state = ({ online:'Online', stale:'No signal', offline:'Offline', lobby:'Not yet reporting' })[presence.state] ?? 'Not yet reporting';
      const activity = presence.state !== 'online' ? 'No current activity' : data.signal ? stationActivity(data).label : presence.activity || presence.task || stationActivity(data).label;
      text = `Selected: ${harness ? harness + ' ' : ''}Session · ${data.name} · ${state} · ${actor.mode === 'waiting' ? 'Waiting for a free station · ' : actor.mode === 'blocked' ? 'Route unavailable · ' : ''}${activity}`;
    }
    if (text !== captionText) {
      caption.textContent = text;
      captionText = text;
    }
  }
  function applyMood(force = false) {
    const now = new Date();
    const minute = `${now.getDate()}:${now.getHours()}:${now.getMinutes()}`;
    if (!force && minute === lastMinute) return;
    lastMinute = minute;
    const mood = moodAt(now.getHours() + now.getMinutes() / 60);
    currentMood = mood;
    container.style.setProperty("--scene-stars", mood.stars);
    container.style.setProperty("--scene-daylight", mood.daylight);
    container.style.setProperty("--scene-twilight", mood.twilight);
    container.style.setProperty("--scene-sun-x", `${mood.discX}%`);
    container.style.setProperty("--scene-sun-y", `${mood.discY}%`);
    container.style.setProperty("--scene-sky", `rgb(${mood.sky.join(" ")})`);
    container.style.setProperty("--scene-horizon", `rgb(${mood.horizon.join(" ")})`);
    moodText = `${mood.label} · ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} Local`;
    weatherAppearanceKey = "";
    hemi.intensity = mood.fill;
    sun.intensity = mood.sun;
    sun.position.set(mood.sunX, mood.sunY, -8);
    sun.color.set(`rgb(${mood.lightColor.join(',')})`).lerp(daylightLamp, mood.daylight * 0.78);
    for (const lamp of lamps) lamp.color.copy(warmLamp).lerp(daylightLamp, mood.daylight);
    fixtureMaterial.color.copy(lamps[0].color);
    fixtureMaterial.emissive.copy(lamps[0].color);
    meetingLight.color.copy(lamps[0].color);
    windowMat.emissiveIntensity = 0.08 + mood.daylight * 0.12;
    applyWeather();
  }
  function applyWeather() {
    const weather = weatherScene.update(Date.now(), time, reduced.matches, currentMood);
    const minutes = Math.max(1, Math.ceil((weather.forecast.at - weather.sampledAt) / 60000));
    const key = `${lastMinute}:${weather.kind}:${weather.cloud.toFixed(3)}:${weather.windX.toFixed(3)}:${weather.forecast.at}:${minutes}`;
    if (key === weatherAppearanceKey) return;
    weatherAppearanceKey = key;
    const dim = 1 - weather.cloud * 0.35;
    container.style.setProperty("--scene-cloud-cover", weather.cloud);
    container.style.setProperty("--scene-stars", currentMood.stars * (1 - weather.cloud * 0.85));
    container.style.setProperty(
      "--scene-sky",
      `rgb(${currentMood.sky.map((value) => value * dim).join(" ")})`,
    );
    container.style.setProperty(
      "--scene-horizon",
      `rgb(${currentMood.horizon.map((value) => value * dim).join(" ")})`,
    );
    const labels = {
      clear: "Clear",
      cloudy: "Cloudy",
      rain: "Rain",
      thunderstorm: "Thunderstorm",
      snow: "Snow",
    };
    const label =
      weather.kind === "clear" && currentMood.daylight > 0.5 ? "Sunny" : labels[weather.kind];
    const nextTime = new Date(weather.forecast.at);
    const nextSunny =
      weather.forecast.kind === "clear" &&
      moodAt(nextTime.getHours() + nextTime.getMinutes() / 60).daylight > 0.5;
    const nextLabel = nextSunny ? "Sunny" : labels[weather.forecast.kind];
    outlook.textContent = `${nextLabel} in ~${minutes} min · Wind ${weather.forecast.direction < 0 ? "←" : "→"}`;
    moodLabel.textContent = `${moodText} · ${label}${weather.wind > 0.65 ? " / Windy" : ""} · Simulated`;
    moodLabel.title =
      "Office simulation, not a real-world forecast. Conditions are evaluated every 5–15 minutes independently of agent activity.";
    // Overcast cools the whole office, while warm practical lamps preserve readability.
    hemi.color.setRGB(
      0.8 - weather.cloud * 0.09,
      0.87 - weather.cloud * 0.04,
      0.95,
      THREE.SRGBColorSpace,
    );
    hemi.intensity = (currentMood.fill + 0.68 * currentMood.daylight) * (1 - weather.cloud * 0.12);
    sun.intensity = currentMood.sun * (1 - weather.cloud * 0.75);
    const lampsOn = Math.max(currentMood.lamps, 0.32 * currentMood.daylight, weather.cloud * 0.38);
    for (const lamp of lamps) lamp.intensity = 15 * lampsOn;
    meetingLight.intensity = 22 * lampsOn;
    // The shade and its pool on the furniture follow the same dimmer, even on bright days.
    const loungeOn = Math.max(0.36, currentMood.lamps, weather.cloud * 0.45);
    loungeLight.intensity = 17 * loungeOn;
    shade.material.emissiveIntensity = 1.6 * loungeOn;
    fixtureMaterial.emissiveIntensity = lampsOn * 2;
  }
  function setTheme() {
    const theme = document.documentElement.dataset.theme;
    if (theme === currentTheme) return;
    currentTheme = theme;
    // UI theme adjusts exposure only. It never rebuilds or moves the office.
    renderer.toneMappingExposure = theme === "dark" ? 1.0 : 1.15;
  }
  function positionCamera() {
    camera.position.set(
      10 + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * 40,
      Math.sin(orbit.pitch) * 40,
      7 + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * 40,
    );
    camera.lookAt(10, 0.6, 7);
    camera.updateMatrixWorld();
    simulation.setViewpoint(camera.position);
    const aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    // Fit all eight model corners in camera space rather than guessing a distance.
    let halfX = 0,
      halfY = 0;
    for (const x of [-0.4, 20.4])
      for (const y of [-0.6, 3])
        for (const z of [-0.4, 14.4]) {
          const p = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
          halfX = Math.max(halfX, Math.abs(p.x));
          halfY = Math.max(halfY, Math.abs(p.y));
        }
    const height = (Math.max(halfY, halfX / aspect) * 1.12) / orbit.zoom;
    camera.left = -height * aspect;
    camera.right = height * aspect;
    camera.top = height;
    camera.bottom = -height;
    camera.updateProjectionMatrix();
  }
  function resize() {
    if (disposed || !container.clientWidth || !container.clientHeight) return;
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    positionCamera();
  }
  function resetView() {
    orbit.yaw = 0.48;
    orbit.pitch = 0.72;
    orbit.zoom = 1;
    positionCamera();
  }
  reset.addEventListener("click", resetView);
  let drag = null;
  const canvas = renderer.domElement;
  function down(event) {
    drag = { x: event.clientX, y: event.clientY, distance: 0 };
    canvas.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!drag) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    drag.distance += Math.abs(dx) + Math.abs(dy);
    orbit.yaw = THREE.MathUtils.clamp(orbit.yaw - dx * 0.004, -0.65, 1.05);
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.003, 0.48, 1.12);
    drag.x = event.clientX;
    drag.y = event.clientY;
    positionCamera();
  }
  function up(event) {
    if (drag && drag.distance < 6) {
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hits = ray.intersectObjects(
        [...actors.values()].map((actor) => actor.root),
        true,
      );
      if (hits.length) {
        let object = hits[0].object;
        while (object && !object.userData.agentId) object = object.parent;
        if (object) {
          selectedId = object.userData.agentId;
          onSelect?.(selectedId);
          updateCaption();
        }
      }
    }
    drag = null;
  }
  function cancel() {
    drag = null;
  }
  function wheel(event) {
    event.preventDefault();
    orbit.zoom = THREE.MathUtils.clamp(orbit.zoom * Math.exp(-event.deltaY * 0.001), 0.8, 2.2);
    positionCamera();
  }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("wheel", wheel, { passive: false });
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function replaceBadge(sprite, text, tone, identity) {
    const previous = sprite.material.map;
    sprite.material.map = labelTexture(text, tone, identity);
    textures.delete(previous);
    previous.dispose();
  }

  function animateActor(model, actor, dt) {
    model.root.position.set(actor.position.x, 0, actor.position.z);
    model.root.rotation.y = actor.angle;
    // Signal loss freezes navigation. Do not straighten legs through an occupied seat.
    if (actor.mode !== 'stale') model.seated = actor.mode === 'seated';
    const seated = model.seated;
    const moving = actor.mode === "walking";
    const active = actor.data.presence?.state === "online";
    const activity = stationActivity(actor.data);
    const arrived =
      active &&
      !actor.holdingIntent &&
      !actor.path.length &&
      ["seated", "standing"].includes(actor.mode) &&
      actor.target &&
      Math.hypot(actor.position.x - actor.target.x, actor.position.z - actor.target.z) < 0.001;
    const alternate = !!actor.tripTarget && actor.target === actor.tripTarget && actor.workSignal === actor.data.signal?.id;
    const rules = arrived && !actor.ambient && !actor.attention && !actor.finalStop &&
      !['waiting','standby','inactive','human-waiting','none'].includes(activity.action) && workVariants(actor.data);
    const selected = actor.data.signal?.variant;
    const variant = rules && (selected ? atStation(rules.selections.get(selected),actor.target) :
      atStation(alternate ? rules.work_trip : rules.working,actor.target,model.phase) || atStation(rules.overflow,actor.target,model.phase));
    // The sender describes the work; the occupied object determines the hands/props.
    // A desk can also remain visible during room hysteresis. Never type in transit or on a sofa.
    const toolKeyboard = !selected && arrived && ['desk','intern-desk'].includes(actor.target.room) && seated &&
      actor.data.signal?.action === 'use_tools' && ['tools','none'].includes(activity.action);
    const toolStation = arrived && !selected && activity.action==='tools' && ['library','printer'].includes(actor.target.id);
    const childAtDesk = arrived && seated && actor.data.actorKind==='subagent' && actor.room==='intern-desk' && ['desk','intern-desk'].includes(actor.target.room);
    const interacting = arrived && (childAtDesk || toolStation || variant || (!(selected && rules) && (toolKeyboard || alternate || servesRoom(actor.target, activity.action === 'other' ? 'other' : actor.data.presence?.room))));
    const cue = eventCue(actor.data);
    let action = cue?.kind === "error" ? "error" : variant ? variant.pose : toolKeyboard ? 'typing' : interacting ? activity.action : "none";
    if(cue?.kind!=='error' && toolStation) action=actor.target.id==='library' ? 'reading' : 'output';
    if(cue?.kind!=='error' && childAtDesk && ['typing','none','waiting'].includes(action)) action='typing';
    if (arrived && actor.finalStop) action = actor.finalStop === 'printer' ? 'output' : 'communication';
    if (!variant && interacting && actor.target.object?.startsWith("archive") && action === "reading")
      action = "output";
    const ambient = actor.ambient && arrived && ambientObjects[actor.target.object];
    if (ambient) action = ambient[0];
    else if (action === 'break' && ['coffee','water'].includes(actor.target?.object)) action = 'pour';
    if (action === 'other') action = ambientObjects[actor.target.object]?.[0] ?? 'watching';
    const portable = action === 'portable';
    model.tablet.visible = portable;
    if (action === 'sorting' && !cabinetBooks.has(actor.target?.object)) action='none';
    const sortingBeat = action==='sorting' && !reduced.matches ? (1-Math.cos(time*2.4))*.5 : 0;
    model.stationAction = action;
    let activityText = activity.label;
    if (active && !interacting) activityText = `Preparing · ${activity.label}`;
    if (portable) activityText = 'Writing · Overflow Spot';
    if (moving) activityText = (alternate || actor.workReturning) ? activity.label : `Walking · ${activity.label}`;
    const stationWait = active && actor.mode === 'waiting' && !!workVariants(actor.data) && !actor.holdingIntent && !actor.path.length;
    if (actor.mode === 'waiting') activityText = stationWait ? `${activity.label} · Waiting for Station` : 'Waiting for Station';
    if(childAtDesk && activity.action==='waiting') activityText='Active Subagent Run';
    if(actor.mode==='yielding') activityText='Waiting for a Clear Path';
    if (actor.mode === "blocked") activityText = "Route Unavailable";
    if (actor.ambient)
      activityText = `Ambient · ${moving ? "Walking" : ambient ? ambient[1] : "Standby"}`;
    if (actor.finalStop) activityText = 'Final Response';
    if (cue) activityText = cue.label;
    if(actor.leaving) activityText='Leaving Office';
    model.cue = cue?.kind ?? null;
    model.bulb.visible = cue?.kind === "planning";
    model.mouth.scale.y = cue?.kind === "error" ? 0.08 : 0.025;
    model.mouth.rotation.z = cue?.kind === "error" ? 0.3 : 0;
    const tone = badgeTone(active, model.cue, activity.action);
    if (tone !== model.badgeTone || model.name !== actor.data.name) {
      model.name = actor.data.name;
      replaceBadge(model.label, model.name, tone, true);
    }
    if (tone !== model.badgeTone || activityText !== model.activityText) {
      model.activityText = activityText;
      replaceBadge(model.activityLabel, activityText, tone, false);
    }
    model.badgeTone = tone;
    model.waving = action === "human-waiting";
    const cameraAngle = Math.atan2(
      camera.position.x - actor.position.x,
      camera.position.z - actor.position.z,
    );
    if (model.waving && !seated) model.root.rotation.y = cameraAngle;
    const headTurn = Math.atan2(
      Math.sin(cameraAngle - actor.angle),
      Math.cos(cameraAngle - actor.angle),
    );
    // Seated hips/legs keep the chair orientation. Only the head turns within a natural range.
    model.head.rotation.y = model.waving && seated ? Math.max(-0.55, Math.min(0.55, headTurn)) : 0;
    const eligible =
      interacting &&
      !actor.ambient &&
      !actor.holdingIntent &&
      !reduced.matches &&
      cue?.kind !== "error";
    // A finished call, an idle heartbeat or a held route is not evidence of a long-running tool.
    const signal = actor.data.signal;
    const longWork = eligible && signal?.type === 'tool.start' &&
      (action === 'tools' || (action === 'typing' && (toolKeyboard || writingSignal(signal))));
    // A sustained failure can move in place even without a usable station. It is not recovery.
    const restingError = cue?.kind === 'error' && !reduced.matches && !moving &&
      !actor.holdingIntent && !actor.path.length;
    const poseAction = longWork ? (action === 'tools' ? 'bench-active' : 'keyboard-active') : action;
    const { kind, amount } = model.poseAccent(
      time,
      restingError ? 'error-rest' : stationWait && !reduced.matches ? 'station-wait' : eligible ? poseAction : 'none',
      restingError || stationWait ? (seated ? 'seated' : 'standing') : actor.mode,
      restingError || longWork ? signal.id : actor.data.runId ?? signal?.run_id,
      actor.data.presence?.task,
      eligible && variant && action === variant.pose && signal?.type !== 'tool.end' ? variant.accents : undefined,
    );
    model.accent = kind;
    model.head.rotation.x = (model.waving ? -0.25 : 0) + (kind === "nod" ? 0.24 * amount : 0);
    model.head.rotation.z = kind === "tilt" ? 0.25 * amount : 0;
    if (kind === "glance" || kind === 'scan') model.head.rotation.y += 0.28 * amount;
    if (kind === 'reach' || kind === 'adjust') model.head.rotation.x += 0.16 * amount;
    model.book.visible = action === "reading";
    model.pageHinge.rotation.z =
      model.book.visible && !reduced.matches
        ? Math.PI * Math.min(1, ((time + model.phase) % 5) / 1.2)
        : 0.12;
    const slide = reduced.matches ? 0 : Math.sin(time * 2.1 + model.phase);
    const arranging = action === 'arranging';
    model.paper.visible = arranging || action === 'output';
    model.looseSheet.visible = arranging;
    model.paper.position.x = arranging ? .09 + slide*.11 : 0;
    model.paper.rotation.y = arranging ? slide*.12 : 0;
    model.mouse.visible = action === 'mouse';
    model.mouse.position.x = -.50 + slide*.045;
    model.phone.visible = action === "communication";
    model.cup.visible = ["break", "watering", "pour"].includes(action);
    model.cup.rotation.z = action === "watering" ? -0.6 : 0;
    model.cup.position.z = action === "pour" ? 0.44 : 0.3;
    model.cup.position.y = action === "pour" ? 1.07 : 1.13;
    const gesture = reduced.matches ? 0 : Math.sin(time * 3 + model.phase) * 0.08;
    const swing = moving && !reduced.matches ? Math.sin(time * 9 + model.phase) * 0.5 : 0;
    model.baseHeight += ((seated ? -0.05 : 0.04) - model.baseHeight) * Math.min(1, dt * 10);
    model.body.position.y = model.baseHeight + (kind === "hop" ? 0.23 * amount : 0);
    model.body.rotation.x = (seated ? 0.04 : 0) + (kind === "lean" ? 0.12 * amount : 0) + sortingBeat*.13;
    model.body.rotation.z = cue?.kind === "error" ? 0.08 : kind === "stamp" ? -0.09 * amount : 0;
    if (kind === 'reach' || kind === 'adjust') model.body.rotation.x += 0.19 * amount;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const typing =
        seated && action === "typing" && !reduced.matches
          ? Math.sin(time * 12 + model.phase) * 0.07 * side
          : 0;
      const leg = seated ? -Math.PI / 2 : swing * side;
      model.legs[i].rotation.x += (leg - model.legs[i].rotation.x) * Math.min(1, dt * 14);
      model.knees[i].rotation.x +=
        ((seated ? Math.PI / 2 : 0) - model.knees[i].rotation.x) * Math.min(1, dt * 14);
      // Lift a single foot in its own space, leaving the floor ring and navigation root fixed.
      model.legs[i].position.y = 0.68 + (kind === "stamp" && i === 1 ? 0.17 * amount : 0);
      let arm = -swing * side * 0.7;
      if (action === "typing") arm = -1.25 + typing;
      if (action === "reading" || action === "output") arm = -1.1 + gesture * side;
      if (action === 'mouse') arm = i===0 ? -1.24 + gesture*.35 : -.52;
      if (arranging) arm = -1.18 + side*.12*slide;
      if (action === 'inspecting' && i===1) arm = -1.91 + gesture;
      if (action === 'portable') arm = -1.31 + (i === 1 ? gesture : 0);
      if (action === 'sorting') arm = -1.05 - (i===1 ? sortingBeat : 1-sortingBeat)*.59;
      if (action === "tools") arm = -1.15 + gesture * side * 2;
      if ((action === 'planning' || action === 'writing') && i === 1) arm = -1.9 + gesture;
      if (action === "communication" && i === 1) arm = -2.35;
      if (model.cup.visible && i === 1) arm = (action === "pour" ? -1.4 : -1.7) + gesture;
      if (action === "meeting") arm = -0.55 + gesture * side;
      if (cue?.kind === "error") arm = -2.1;
      if (action === "human-waiting" && i === 1) arm = -2.85;
      const wavingArm = action === "human-waiting" && i === 1;
      if (kind === 'reach' && i === 1) arm -= 0.68 * amount;
      if (kind === 'adjust') arm += (i === 1 ? -0.38 : 0.16) * amount;
      model.arms[i].rotation.z = wavingArm
        ? 0.45 + gesture * 2
        : action === "planning" && i === 1
          ? 0.12 + gesture * 3
          : 0;
      if (i===0 && action==='mouse') model.arms[i].rotation.z = -.16 + slide*.16;
      if (arranging) model.arms[i].rotation.z = side*.16 + slide*.22;
      if (action==='inspecting' && i===1) model.arms[i].rotation.z = .18 + slide*.17;
      if (i === 1 && (kind === 'mouse' || kind === 'reach')) model.arms[i].rotation.z += 0.48 * amount;
      if (kind === 'adjust' && i === 1) model.arms[i].rotation.z += Math.sin(time * 6) * 0.35 * amount;
      model.arms[i].position.y = wavingArm ? 1.35 : 1.12;
      const [sleeve, hand] = model.arms[i].children;
      sleeve.position.y = wavingArm ? -0.36 : -0.14;
      sleeve.scale.y = wavingArm ? 0.44 : 0.23;
      hand.position.y = wavingArm ? -0.82 : -0.34;
      model.arms[i].rotation.x = arm;
      model.arms[i].position.z = (['typing','mouse','arranging'].includes(action) ? 0.12 : 0) + (kind === 'reach' && i === 1 ? 0.16 * amount : 0);
    }
    model.ring.material.opacity = actor.data.id === selectedId ? 1 : active ? 0.65 : 0.15;
    model.label.material.opacity = active ? 1 : 0.9;
    model.activityLabel.material.opacity = active ? 1 : 0.9;
  }
  const labelPoint = new THREE.Vector3();
  function placeLabels() {
    // Prioritize attention/selection; move labels upward rather than covering faces or each other.
    camera.updateMatrixWorld();
    const px = camera.projectionMatrix.elements[0],
      py = camera.projectionMatrix.elements[5];
    const unit = (camera.top - camera.bottom) / Math.max(1, canvas.clientHeight);
    const lift = unit / Math.cos(orbit.pitch);
    const attention = (m) => m.cue === "human-waiting" || m.cue === "error";
    const models = [...actors.values()].sort(
      (a, b) =>
        Number(b.root.userData.agentId === selectedId) -
          Number(a.root.userData.agentId === selectedId) ||
        Number(attention(b)) - Number(attention(a)) ||
        a.name.localeCompare(b.name),
    );
    const occupied = models.map((model) => {
      labelPoint.set(model.root.position.x, 1.65, model.root.position.z).project(camera);
      const halfWidth = (model.waving ? 0.8 : 0.45) * px;
      return {
        left: labelPoint.x - halfWidth,
        right: labelPoint.x + halfWidth,
        bottom: labelPoint.y - 0.5 * py,
        top: labelPoint.y + 0.5 * py,
      };
    });
    for (const model of models) {
      const status = model.root.userData.agentId === selectedId || attention(model) || model.activityText === 'Final Response' || model.activityText === 'Other Activity' || model.activityText === 'Compacting Context';
      for (const sprite of [model.label, model.activityLabel]) {
        sprite.scale.set((sprite.material.map.image.width / 3) * unit, 20 * unit, 1);
      }
      model.label.visible = false;
      model.activityLabel.visible = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const height = 2.35 + (12 + attempt * 7) * lift;
        labelPoint.set(model.root.position.x, height, model.root.position.z).project(camera);
        const halfWidth =
          Math.max(model.label.scale.x, status ? model.activityLabel.scale.x : 0) * 0.5 * px;
        const rect = {
          left: labelPoint.x - halfWidth,
          right: labelPoint.x + halfWidth,
          bottom: labelPoint.y - 10 * unit * py,
          top: labelPoint.y + (status ? 33 : 10) * unit * py,
        };
        if (
          rect.left < -0.99 ||
          rect.right > 0.99 ||
          rect.bottom < -0.95 ||
          rect.top > 0.92 ||
          occupied.some(
            (other) =>
              rect.left < other.right + 0.006 &&
              rect.right > other.left - 0.006 &&
              rect.bottom < other.top + 0.006 &&
              rect.top > other.bottom - 0.006,
          )
        )
          continue;
        model.label.visible = true;
        model.activityLabel.visible = status;
        model.label.position.y = height;
        model.activityLabel.position.y = height + 23 * lift;
        occupied.push(rect);
        break;
      }
    }
  }

  function syncScreens() {
    for (const [id, screen] of screens) {
      const occupant = [...simulation.actors.values()].find(
        (actor) =>
          actor.target?.object === id &&
          actor.mode === "seated" &&
          stationActivity(actor.data).action === "typing",
      );
      const profile = occupant
        ? ["code", "document", "chart"][(hash(occupant.data.id) + Math.floor(time / 8)) % 3]
        : "idle";
      const key = `${occupant?.data.id ?? ""}:${profile}`;
      if (screen.userData.key === key) continue;
      screen.userData.key = key;
      screen.userData.occupant = occupant?.data.id ?? null;
      screen.userData.profile = profile;
      screen.material.map = screenArt.get(profile);
      screen.material.emissiveMap = screenArt.get(profile);
      screen.material.emissiveIntensity = occupant ? 0.35 : 0.04;
    }
  }
  function syncRelationships() {
    for (const [id, line] of relationships) {
      const actor = simulation.actors.get(id);
      const parent = simulation.actors.get(actor?.data.parentId);
      if (!actor || !parent) {
        scene.remove(line);
        line.geometry.dispose();
        geometries.delete(line.geometry);
        line.material.dispose();
        owned.delete(line.material);
        relationships.delete(id);
        continue;
      }
      // A line means related participants are seated together, not arbitrary collaboration.
      line.visible =
        actor.mode === "seated" &&
        parent.mode === "seated" &&
        actor.target?.room === "meeting" &&
        parent.target?.room === "meeting";
      const positions = line.geometry.attributes.position;
      positions.setXYZ(0, parent.position.x, 1.15, parent.position.z);
      positions.setXYZ(1, actor.position.x, 1.15, actor.position.z);
      positions.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }
  function loop(stamp) {
    frame = 0;
    if (disposed || !enabled || document.hidden) return;
    frame = requestAnimationFrame(loop);
    if (stamp - last < 1000 / 30) return;
    const dt = last ? Math.min((stamp - last) / 1000, 0.1) : 0;
    last = stamp;
    time += dt;
    applyMood();
    applyWeather();
    simulation.step(dt);
    syncScreens();
    syncRelationships();
    for (const [id, model] of actors) {
      const actor=simulation.actors.get(id);
      if(actor) animateActor(model, actor, dt);
      else {destroyActor(model);actors.delete(id);}
    }
    syncStationProps(dt);
    if (!reduced.matches)
      for (const swimmer of fish) {
        swimmer.root.position.x = Math.sin(time * 0.6 + swimmer.phase) * 0.55;
        swimmer.root.rotation.y = Math.cos(time * 0.6 + swimmer.phase) > 0 ? 0 : Math.PI;
      }
    if (boothReceiver)
      boothReceiver.visible = ![...actors.values()].some((model) => model.phone.visible);
    placeLabels();
    updateCaption();
    renderer.render(scene, camera);
    frames++;
  }
  function reconcileLoop() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    if (!disposed && enabled && !document.hidden) {
      resize();
      applyMood(true);
      frame = requestAnimationFrame(loop);
    }
  }
  document.addEventListener("visibilitychange", reconcileLoop);
  function update(list, officeName = "Office") {
    if (disposed) return;
    if (officeName !== signName) {
      const oldMap = officeSign.material.map;
      officeSign.material.map = floorLabelTexture(officeName);
      textures.delete(oldMap);
      oldMap.dispose();
      signName = officeName;
    }
    simulation.update(list, !reduced.matches && enabled && !document.hidden);
    for (const [id, actor] of actors)
      if (!simulation.actors.has(id)) {
        destroyActor(actor);
        actors.delete(id);
      }
    for (const data of list) {
      if (!simulation.actors.has(data.id)) continue;
      const previous = actors.get(data.id);
      if (!previous || previous.variation !== (data.avatar_variation ?? null)) {
        if (previous) destroyActor(previous);
        actors.set(data.id, makeActor(data));
      }
    }
    for (const data of list) {
      if (!data.parentId || relationships.has(data.id) || !simulation.actors.has(data.parentId))
        continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({
        color: "#b29bd0",
        transparent: true,
        opacity: 0.6,
      });
      geometries.add(geometry);
      owned.add(mat);
      const line = new THREE.Line(geometry, mat);
      relationships.set(data.id, line);
      scene.add(line);
    }
    syncScreens();
    syncRelationships();
    updateCaption();
  }
  function syncStationProps(dt) {
    const open = new Set(), sorting = new Set();
    let writer,
      printing = false;
    for (const stream of drinkStreams.values()) stream.visible = false;
    for (const mouse of parkedMice.values()) mouse.visible = true;
    for (const [id, model] of actors) {
      const actor = simulation.actors.get(id),
        object = actor.target?.object;
      if (model.mouse.visible && parkedMice.has(object)) parkedMice.get(object).visible = false;
      if (model.stationAction === "pour" && drinkStreams.has(object)) {
        const stream = drinkStreams.get(object);
        stream.visible = reduced.matches || (time + model.phase) % 5 < 3;
      }
      if (model.stationAction === "planning" && object === "whiteboard") writer = actor.data;
      if (model.stationAction === 'sorting') { open.add(object); sorting.add(object); }
      if (model.stationAction === "output") {
        if (object === "printer") printing = true;
        else open.add(object);
      }
    }
    for (const door of cabinetDoors) {
      const goal = open.has(door.userData.station) ? door.userData.side * 1.2 : 0;
      door.rotation.y += (goal - door.rotation.y) * (reduced.matches ? 1 : Math.min(1, dt * 6));
    }
    for (const [id,book] of cabinetBooks) {
      const beat = sorting.has(id) && !reduced.matches ? (1-Math.cos(time*2.4))*.5 : 0;
      book.position.set(beat*.21,1.48+beat*.12,.04+beat*.25);
    }
    printerSheet.visible = printing;
    printerSheet.position.z = reduced.matches
      ? 0.42
      : 0.31 + 0.22 * (0.5 - 0.5 * Math.cos(time * 2.5));
    if (boardSurface.userData.writer !== writer?.id) {
      boardSurface.userData.writer = writer?.id;
      boardSurface.userData.start = time;
    }
    const progress = reduced.matches ? 4 : (time - boardSurface.userData.start) * 1.8;
    boardMarks.forEach((mark, i) => {
      mark.visible = !!writer && progress > i;
      mark.scale.x = 0.28 * Math.max(0.01, Math.min(1, progress - i));
    });
    const text = writer?.presence?.task || writer?.presence?.activity || "READY FOR IDEAS";
    if (boardSurface.userData.text !== text) {
      textures.delete(boardSurface.material.map);
      boardSurface.material.map.dispose();
      boardSurface.material.map = boardTexture(text);
      boardSurface.userData.text = text;
    }
  }
  resize();
  setTheme();
  applyMood(true);
  return {
    update,
    setTheme,
    setActive(value) {
      enabled = value;
      reconcileLoop();
    },
    select(id) {
      selectedId = id;
      updateCaption();
    },
    // Read-only diagnostics for bounded browser checks; no route or server writes.
    inspect() {
      return {
        frames,
        officeName: signName,
        active: enabled && !document.hidden,
        mood: moodLabel.textContent,
        lighting: {
          fill: hemi.intensity,
          sun: sun.intensity,
          lamp: lamps[0].intensity,
          stars: currentMood.stars,
          daylight: currentMood.daylight,
        },
        drawCalls: renderer.info.render.calls,
        weather: weatherScene.inspect(),
        boardMarks: boardMarks.filter((mark) => mark.visible).length,
        printing: printerSheet.visible,
        sortedBookOffset: Math.max(0,...Array.from(cabinetBooks.values(), book=>book.position.x)),
        archiveOpen: cabinetDoors.some((door) => Math.abs(door.rotation.y) > 0.5),
        windowOpacity: windowMat.opacity,
        staticBatches: staticBatches.length,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        screens: [...screens].map(([id, screen]) => ({ id, occupant: screen.userData.occupant })),
        actors: [...simulation.actors.values()].map((a) => ({
          id: a.data.id,
          position: { ...a.position },
          target: a.target?.id,
          dock: a.dock?.id,
          attention: a.attention ? (a.attention.standing ? "standing" : "seated") : null,
          chairRotation: a.target?.rot,
          bodyRotation: actors.get(a.data.id)?.root.rotation.y,
          headRotation: actors.get(a.data.id)?.head.rotation.y,
          mode: a.mode,
          action: actors.get(a.data.id)?.activityText,
          cue: actors.get(a.data.id)?.cue,
          actorKind: a.data.actorKind ?? "agent",
          ambient: a.ambient,
          ambientTarget: a.ambientTarget,
          parentId: a.data.parentId,
          meetingLink: relationships.get(a.data.id)?.visible ?? false,
          reading: actors.get(a.data.id)?.book.visible,
          output: actors.get(a.data.id)?.paper.visible,
          station: a.target?.object,
          waving: actors.get(a.data.id)?.waving,
          poseAccent: actors.get(a.data.id)?.accent ?? null,
          waveAngle: actors.get(a.data.id)?.arms[1].rotation.z,
          handset: actors.get(a.data.id)?.phone.visible,
          facingCamera: Math.cos(
            (actors.get(a.data.id)?.root.rotation.y ?? 0) +
              (actors.get(a.data.id)?.head.rotation.y ?? 0) -
              Math.atan2(camera.position.x - a.position.x, camera.position.z - a.position.z),
          ),
          appearance: actors.get(a.data.id)?.style,
          seatedLeg: actors.get(a.data.id)?.legs[0].rotation.x,
          task: a.data.presence?.task,
        })),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", reconcileLoop);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      reset.removeEventListener("click", resetView);
      weatherScene.dispose();
      for (const batch of staticBatches) batch.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const mat of materials.values()) mat.dispose();
      for (const mat of owned) mat.dispose();
      for (const texture of textures) texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      skyLayer.remove();
      hud.remove();
      footer.remove();
    },
  };
}
