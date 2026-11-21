import * as THREE from 'three';
import { buildFigure, createShapes } from './avatar-figure.js';
import { drawVariation, silhouette } from './avatar-catalog.js';
import { avatarStyle } from './office-model.js';

// One lazy, offscreen studio for the page, not a WebGL context or render loop per agent.
let studio;
function createStudio() {
  const renderer = new THREE.WebGLRenderer({ alpha:true, antialias:true, powerPreference:'low-power' });
  renderer.setSize(288, 288, false);
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.12,1.12,1.12,-1.12,0.1,12);
  camera.position.set(1.35,1.78,4.8);
  camera.lookAt(0,1.04,0);
  scene.add(new THREE.HemisphereLight(0xfff8eb,0xd3d9db,1.9));
  const key = new THREE.DirectionalLight(0xfff4e1,2.3);
  key.position.set(-2,4,4);
  scene.add(key);
  const shapes = createShapes(new Map(),new Set());
  return (canvas, style) => {
    const bust = shapes.group(scene);
    try {
      buildFigure(bust,style,shapes);
      renderer.render(scene,camera);
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(renderer.domElement,0,0,canvas.width,canvas.height);
    } finally { scene.remove(bust); }
  };
}

export function drawPortrait(canvas, id, variation) {
  const style = avatarStyle(id,variation);
  studio ??= createStudio();
  studio(canvas,style);
  return `${style.hairStyle} hair, ${style.outfit}, ${style.bottom}, ${style.shoes}`;
}

export function anotherLook(id, filter, history) {
  return drawVariation(id,filter,history.map(v=>silhouette(avatarStyle(id,v))),avatarStyle);
}
