// Illustrative weather, never a real-world forecast.
import { hash, nextChange, segmentAt } from "./weather-schedule.js";

// A single soft pulse per interval, never a strobe or a flash on entering the storm.
function lightningAt(now, period) {
  const age = now - period.since - 15000;
  if (period.kind !== "thunderstorm" || age < 0 || now > period.until - 3000) return 0;
  const interval = 45000 + (period.since % 17000);
  const phase = age % interval;
  // Skip a partial final pulse rather than cutting its fade short.
  if (phase >= 1400 || now - phase + 1400 > period.until - 3000) return 0;
  return 0.8 * Math.sin((Math.PI * phase) / 1400) ** 2;
}
const rains = (kind) => Number(kind === "rain" || kind === "thunderstorm");
export function weatherAt(now, seed = "office") {
  const current = segmentAt(now, seed),
    previous = segmentAt(current.since - 1, seed);
  const t = Math.min(1, Math.max(0, (now - current.since) / 10000));
  const blend = t * t * (3 - 2 * t);
  const mix = (a, b) => a + (b - a) * blend;
  const clouds = { clear: 0, cloudy: 0.75, rain: 0.95, thunderstorm: 1, snow: 0.85 };
  return {
    ...current,
    windX: mix(previous.windX, current.windX),
    wind: Math.abs(mix(previous.windX, current.windX)),
    forecast: nextChange(current, seed),
    sampledAt: now,
    cloud: mix(clouds[previous.kind], clouds[current.kind]),
    rain: mix(rains(previous.kind), rains(current.kind)),
    lightning: lightningAt(now, current),
    snow: mix(Number(previous.kind === "snow"), Number(current.kind === "snow")),
  };
}

// Four surrounding volumes leave the cutaway office's entire vertical column dry.
// Keep a one-unit margin for slanted rain segments, snow drift and the exterior walls.
const VOLUMES = [
  [-14, 34, -14, -1],
  [-14, 34, 15, 28],
  [-14, -1, -1, 15],
  [21, 34, -1, 15],
];
const wrap = (value, span) => ((value % span) + span) % span;
export function precipitationSample(seed, index) {
  const n = hash(`${seed}:precipitation:${index}`);
  return {
    side: index % 4,
    u: (n & 1023) / 1024,
    v: ((n >>> 10) & 1023) / 1024,
    height: ((n >>> 20) / 4096) * 20,
  };
}
export function precipitationPosition(
  sample,
  time,
  wind,
  snow = false,
  out = {},
  drift = time * wind,
) {
  const [left, right, back, front] = VOLUMES[sample.side];
  out.x =
    left +
    wrap(
      sample.u * (right - left) + drift * 0.6 + (snow ? Math.sin(time + sample.height) * 0.18 : 0),
      right - left,
    );
  out.z = back + wrap(sample.v * (front - back) + drift * 0.15, front - back);
  out.y = wrap(sample.height - time * (snow ? 1.1 : 8), 20);
  return out;
}

/** Owns a bounded surrounding atmosphere. Uses the caller's RAF; no timers or network. */
export function createWeatherScene(THREE, scene, seed, camera) {
  const root = new THREE.Group();
  root.userData.dynamic = true;
  scene.add(root);
  const geometries = [],
    materials = [],
    textures = [];
  const geometry = (value) => {
    geometries.push(value);
    return value;
  };
  const material = (value) => {
    materials.push(value);
    return value;
  };
  const previousFog = scene.fog;
  const fog = new THREE.FogExp2("#b8d4dd", 0.001);
  scene.fog = fog;
  // Soft distant billboards avoid opaque ellipsoids floating over the cutaway interior.
  // A cloud supplies opacity only. Do not sample RGB from a translucent canvas on first upload:
  // even a small chromatic defect in that one image would repeat across every billboard.
  const size = 64;
  const mask = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const radius = Math.hypot((2 * x + 1) / size - 1, (2 * y + 1) / size - 1);
      const opacity =
        radius < 0.45 ? 0.8 - (0.4 * radius) / 0.45 : (0.4 * Math.max(0, 1 - radius)) / 0.55;
      // MeshBasicMaterial.alphaMap reads the green channel, not the texture's alpha.
      mask[4 * (y * size + x) + 1] = Math.round(255 * opacity);
    }
  }
  const cloudTexture = new THREE.DataTexture(mask, size, size);
  cloudTexture.minFilter = cloudTexture.magFilter = THREE.LinearFilter;
  cloudTexture.needsUpdate = true;
  textures.push(cloudTexture);
  const cloudMat = material(
    new THREE.MeshBasicMaterial({
      alphaMap: cloudTexture,
      color: "#f1f4f4",
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    }),
  );
  const clouds = new THREE.InstancedMesh(geometry(new THREE.PlaneGeometry(1, 1)), cloudMat, 18);
  clouds.frustumCulled = false;
  root.add(clouds);
  const matrix = new THREE.Object3D();
  const samples = Array.from({ length: 512 }, (_, index) => precipitationSample(seed, index));
  const position = {};
  function positions(count) {
    const geo = geometry(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(10, 10, 7), 36);
    return geo;
  }
  const rainMat = material(
    new THREE.LineBasicMaterial({
      color: "#c2dbea",
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  const rain = new THREE.LineSegments(positions(1024), rainMat);
  root.add(rain);
  // One small depth-tested silhouette beyond the back windows; no scene light or overlay.
  const boltMat = material(
    new THREE.LineBasicMaterial({ color: "#e1ebf5", transparent: true, depthWrite: false }),
  );
  const boltGeo = geometry(new THREE.BufferGeometry());
  boltGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -0.25, 4.6, 0, 0.09, 3.84, 0, 0.09, 3.84, 0, -0.14, 3.89, 0, -0.14, 3.89, 0, 0.33, 2.92, 0,
        0.09, 3.84, 0, 0.47, 3.64, 0,
      ],
      3,
    ),
  );
  const bolt = new THREE.LineSegments(boltGeo, boltMat);
  bolt.visible = false;
  root.add(bolt);
  // Four distant swallows share one dynamic triangle buffer. No offscreen actors or timers.
  const birdGeo = positions(4 * 6);
  const birds = new THREE.Mesh(
    birdGeo,
    material(new THREE.MeshBasicMaterial({ color: "#324752", side: THREE.DoubleSide })),
  );
  birds.visible = false;
  birds.frustumCulled = false;
  root.add(birds);
  function updateFlock(now, weather, daylight, reduced) {
    const age = now - weather.since - 12000,
      cycle = Math.floor(age / 90000),
      phase = age % 90000;
    birds.visible =
      !reduced &&
      daylight > 0.5 &&
      weather.kind === "clear" &&
      age >= 0 &&
      phase < 14000 &&
      now - phase + 14000 <= weather.until;
    if (!birds.visible) return;
    const n = hash(`${seed}:birds:${weather.since}:${cycle}`),
      count = 2 + (n % 3);
    const dir = Math.sign(weather.windX) * ((n >>> 8) % 4 === 0 ? -1 : 1);
    const travel = phase / 14000,
      attr = birdGeo.attributes.position;
    for (let i = 0; i < count; i++) {
      const x = 10 + dir * ((travel - 0.5) * 66 - i * 0.77),
        y = 3.95 + Math.sin(travel * 4 + i) * 0.15 + (i % 2) * 0.26,
        z = -2.3 - i * 0.27;
      const wing = 0.12 * Math.sin(phase * 0.008 + i * 1.7);
      const k = i * 6;
      attr.setXYZ(k, x - 0.29, y + wing, z);
      attr.setXYZ(k + 1, x, y, z + 0.04);
      attr.setXYZ(k + 2, x - 0.12, y + 0.075, z);
      attr.setXYZ(k + 3, x, y, z + 0.04);
      attr.setXYZ(k + 4, x + 0.29, y + wing, z);
      attr.setXYZ(k + 5, x + 0.12, y + 0.075, z);
    }
    birdGeo.setDrawRange(0, count * 6);
    attr.needsUpdate = true;
  }
  const disc = document.createElement("canvas");
  disc.width = disc.height = 16;
  const ctx = disc.getContext("2d");
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.arc(8, 8, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(80,105,120,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const texture = new THREE.CanvasTexture(disc);
  textures.push(texture);
  const snowMat = material(
    new THREE.PointsMaterial({
      color: "#f4f7fa",
      map: texture,
      size: 5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  const snow = new THREE.Points(positions(256), snowMat);
  root.add(snow);
  const wetMat = material(
    new THREE.LineBasicMaterial({
      color: "#dfedf2",
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  const wet = new THREE.LineSegments(positions(54), wetMat);
  root.add(wet);
  const reflectionMat = material(
    new THREE.LineBasicMaterial({
      color: "#eff8fa",
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }),
  );
  const reflectionGeo = positions(12),
    reflections = new THREE.LineSegments(reflectionGeo, reflectionMat);
  let point = 0;
  for (const x of [4.5, 10, 16])
    for (const offset of [-1.2, 1.1]) {
      reflectionGeo.attributes.position.setXYZ(point++, x + offset, 1.45, 0.235);
      reflectionGeo.attributes.position.setXYZ(point++, x + offset + 0.4, 2.2, 0.235);
    }
  root.add(reflections);
  let drift = 0,
    lastElapsed = 0;
  let current,
    sampledAt = -Infinity,
    disposed = false;
  return {
    update(now, elapsed, reducedMotion, mood) {
      if (disposed) return current;
      if (Math.abs(now - sampledAt) >= 250) {
        current = weatherAt(now, seed);
        sampledAt = now;
      }
      // Schedule samples are cached; evaluate the short fade on each rendered frame.
      const level = reducedMotion ? 0 : lightningAt(now, current);
      bolt.visible = level > 0;
      if (bolt.visible) {
        boltMat.opacity = level;
        bolt.position.set(4.5 + 5.5 * (current.since % 3), 0, -1.4);
      }
      updateFlock(now, current, mood.daylight, reducedMotion);
      if (!reducedMotion)
        drift += Math.max(0, Math.min(0.1, elapsed - lastElapsed)) * current.windX;
      lastElapsed = elapsed;
      const t = reducedMotion ? 0 : elapsed;
      const dim = 1 - current.cloud * 0.35;
      fog.density = 0.001 + current.cloud * 0.005 + current.rain * 0.0025 + current.snow * 0.004;
      fog.color.setRGB(...mood.sky.map((channel) => (channel / 255) * dim), THREE.SRGBColorSpace);
      cloudMat.color.setRGB(
        ...mood.horizon.map((channel) => (channel / 255) * (1 - current.cloud * 0.2)),
        THREE.SRGBColorSpace,
      );
      cloudMat.opacity = 0.08 + current.cloud * 0.45;
      for (let index = 0; index < 18; index++) {
        const angle = (index * Math.PI) / 9 + drift * 0.003;
        matrix.position.set(
          10 + Math.cos(angle) * 36,
          14 + (index % 3) * 2,
          7 + Math.sin(angle) * 36,
        );
        matrix.quaternion.copy(camera.quaternion);
        matrix.scale.set(12 + (index % 2) * 4, 4 + (index % 3), 1);
        matrix.updateMatrix();
        clouds.setMatrixAt(index, matrix.matrix);
      }
      clouds.instanceMatrix.needsUpdate = true;
      rain.visible = current.rain > 0.001;
      rainMat.opacity = current.rain * 0.5;
      snow.visible = current.snow > 0.001;
      snowMat.opacity = current.snow * 0.95;
      wet.visible = rain.visible;
      wetMat.opacity = current.rain * 0.55;
      const rainPositions = rain.geometry.attributes.position,
        snowPositions = snow.geometry.attributes.position;
      if (rain.visible || snow.visible)
        for (let index = 0; index < samples.length; index++) {
          const sample = samples[index];
          if (rain.visible) {
            precipitationPosition(sample, t, current.windX, false, position, drift);
            rainPositions.setXYZ(index * 2, position.x, position.y, position.z);
            rainPositions.setXYZ(
              index * 2 + 1,
              position.x + current.windX * 0.2,
              position.y - 0.42,
              position.z,
            );
          }
          if (snow.visible && index < 256) {
            precipitationPosition(sample, t, current.windX, true, position, drift);
            snowPositions.setXYZ(index, position.x, position.y, position.z);
          }
        }
      if (rain.visible) {
        rainPositions.needsUpdate = true;
        for (let index = 0; index < 27; index++) {
          const x = [4.5, 10, 16][Math.floor(index / 9)] - 1.7 + (index % 9) * 0.42;
          const y = 1.32 + wrap(index * 0.19 - t * 0.12, 0.95);
          wet.geometry.attributes.position.setXYZ(index * 2, x, y, 0.235);
          wet.geometry.attributes.position.setXYZ(index * 2 + 1, x, y + 0.07, 0.235);
        }
        wet.geometry.attributes.position.needsUpdate = true;
      }
      if (snow.visible) snowPositions.needsUpdate = true;
      return current;
    },
    inspect() {
      let precipitationInsideOffice = 0;
      for (const object of [rain, snow]) {
        if (!object.visible) continue;
        const attribute = object.geometry.attributes.position;
        for (let i = 0; i < attribute.count; i++) {
          const x = attribute.getX(i),
            z = attribute.getZ(i);
          if (x >= 0 && x <= 20 && z >= 0 && z <= 14) precipitationInsideOffice++;
        }
      }
      return {
        precipitationInsideOffice,
        ...current,
        lightning: bolt.visible ? boltMat.opacity : 0,
        birdCount: birds.visible ? birdGeo.drawRange.count / 6 : 0,
        rainParticles: 512,
        snowParticles: 256,
        wetGlassStreaks: 27,
        precipitationBounds: { x: [-14, 34], y: [0, 20], z: [-14, 28] },
        dryFootprint: { x: [0, 20], z: [0, 14] },
        fogDensity: fog.density,
        particlePositions: Array.from(rain.geometry.attributes.position.array.slice(0, 24)),
        surroundingVolumes: 4,
        externalOnly: true,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      if (scene.fog === fog) scene.fog = previousFog;
      clouds.dispose();
      for (const value of [...geometries, ...materials, ...textures]) value.dispose();
    },
  };
}
