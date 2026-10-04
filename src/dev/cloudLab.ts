import * as THREE from 'three';
import { HAZE, SEA_Y, createClouds as createCanvasClouds, createFarLand, createFarTown, createSky, skyUniforms } from '../vrm/scenes/seaside';
import { createPalette, createSkyMapping, moonIllum, morningTint, samplePalette } from '../vrm/scenes/streetTime';
import { TimeOfDay } from '../vrm/timeOfDay';
import { createClouds } from '../vrm/scenes/clouds';

/**
 * 开发用：云的对比（/cloudlab.html，只在 vite dev 下有）。同一个镜头、同一片天空和远山，上下两格：
 *   1. 原来的：canvas 画的云片（seaside.ts 的 createClouds）
 *   2. Blender 做的体积云，六向光照（clouds.ts）
 * 可以切时间、视角，云的漂移可以加速看。截图：__lab.shot('name.jpg', 小时, 视角) → dev-out/
 */

const SKY_R = 3000;
const SUN_POS: [number, number, number] = [2.0, 2.3, 0.9];
const D = THREE.MathUtils.degToRad;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const keep = <T>(x: T) => x;

// ---- 场景：天空、远山、小镇、海 ----
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const host = document.getElementById('view')!;
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const fog = new THREE.Fog(HAZE, 100, 2800);
scene.fog = fog;
const skyU = skyUniforms();
scene.add(createSky(keep, SKY_R, skyU));
const lightsU = { value: 0 };
scene.add(createFarLand(keep, D(-150), D(80)));
scene.add(createFarTown(keep, D(-128), D(-40), 900, lightsU));
const sea = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x1d66a6 }));
sea.position.y = SEA_Y;
scene.add(sea);
const hemi = new THREE.HemisphereLight();
const sun = new THREE.DirectionalLight();
scene.add(hemi, sun);

// ---- 1. 原来的云 ----
const oldClouds = createCanvasClouds(keep, SKY_R * 0.88, D(-140), D(40));
const oldMats: THREE.MeshBasicMaterial[] = [];
oldClouds.traverse((o) => {
  const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
  if (m && !oldMats.includes(m)) oldMats.push(m);
});
scene.add(oldClouds);

// ---- 2. Blender 做的云 ----
const blender = createClouds(keep, {
  dist: SKY_R * 0.9,
  seed: 91,
  drift: 0.1,
  bands: [
    { from: D(-140), to: D(40), count: 12, elev: [2.5, 6], width: [0.3, 0.5], kinds: ['tall', 'mid', 'flat'] },
    { from: D(40), to: D(220), count: 6, elev: [3.5, 7], width: [0.22, 0.35], kinds: ['mid', 'flat'], opacity: [0.85, 0.9] },
  ],
});
scene.add(blender.group);
const cu = blender.uniforms;
const PANELS: Array<{ name: string; obj: THREE.Object3D }> = [
  { name: '1. 原来的（canvas）', obj: oldClouds },
  { name: '2. Blender 体积云（六向光照）', obj: blender.group },
];

// ---- 时间 → 颜色 ----
const time = new TimeOfDay();
const mapping = createSkyMapping(SUN_POS);
const pal = createPalette();
const sunW = new THREE.Vector3();
const moonW = new THREE.Vector3();
const MOON_COL = new THREE.Color(0xb4c4ec);
let hours = 15;
function applyTime() {
  time.setMode(hours, true);
  time.update(0);
  const t = time.state;
  const elev = t.sunElev;
  samplePalette(elev, pal);
  morningTint(pal, t.hours, elev);
  mapping.sun(t, sunW);
  mapping.moon(t, moonW);
  const moonElev = Math.asin(moonW.y) / D(1);
  const illum = moonIllum(t.moonPhase);
  const lightsOn = smoothstep(4, -5, elev);
  skyU.uZenith.value.copy(pal.zenith);
  skyU.uMid.value.copy(pal.mid);
  skyU.uHorizon.value.copy(pal.horizon);
  skyU.uGlow.value.copy(pal.glow);
  skyU.uGlowAmt.value = pal.glowAmt;
  skyU.uBand.value = pal.band;
  skyU.uSunDir.value.copy(sunW);
  skyU.uSunDisk.value = smoothstep(-1.5, 0.5, elev) * (1 - smoothstep(12, 25, elev));
  skyU.uMoonDir.value.copy(moonW);
  skyU.uMoon.value = (1 - smoothstep(-5, 3, elev)) * smoothstep(-1, 1.5, moonElev) * smoothstep(0.02, 0.1, illum);
  skyU.uMoonPhase.value = t.moonPhase;
  skyU.uStars.value = smoothstep(-5, -14, elev);
  fog.color.copy(pal.fog);
  lightsU.value = lightsOn;
  hemi.color.copy(pal.hemiSky);
  hemi.groundColor.copy(pal.hemiGround);
  hemi.intensity = pal.hemiI;
  const day = elev > -8;
  sun.position.copy(day ? sunW : moonW).multiplyScalar(100);
  sun.color.copy(day ? pal.sunCol : MOON_COL);
  sun.intensity = day ? pal.sunI * smoothstep(-3, 1, elev) : 0.2;
  (sea.material as THREE.MeshLambertMaterial).color.copy(pal.deep);
  for (const m of oldMats) m.color.copy(pal.cloud);
  // Blender 的云：白天太阳照，太阳落到 -8° 以下换成月亮
  if (day) {
    cu.uKeyDir.value.copy(sunW);
    cu.uKeyCol.value.copy(pal.cloud).multiplyScalar(smoothstep(-8, -3, elev) * 0.85 + 0.15);
  } else {
    cu.uKeyDir.value.copy(moonW);
    cu.uKeyCol.value.copy(MOON_COL).multiplyScalar(0.3 * (0.4 + 0.6 * illum) * smoothstep(-2, 3, moonElev));
  }
  cu.uShade.value.copy(pal.cloudShade);
  cu.uHaze.value.copy(pal.horizon);
  cu.uMoonDir.value.copy(moonW);
  cu.uMoonGlow.value = skyU.uMoon.value;
  return t;
}

// ---- 视角 ----
type View = 'sea' | 'main' | 'moon' | 'wide';
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'main', label: '主机位（长焦 24°）' },
  { id: 'sea', label: '海那边' },
  { id: 'moon', label: '月亮' },
  { id: 'wide', label: '广角' },
];
let view: View = 'main';
const camera = new THREE.PerspectiveCamera(24, 1, 0.5, SKY_R + 200);
function aimCamera() {
  camera.position.set(0, 1.6, 0);
  const look = new THREE.Vector3();
  if (view === 'main') {
    camera.fov = 24;
    look.set(-0.05, 0.075, -1);
  } else if (view === 'sea') {
    camera.fov = 30;
    look.set(-300, 220, -2400);
  } else if (view === 'moon') {
    camera.fov = 16;
    look.copy(moonW.y > -0.02 ? moonW : new THREE.Vector3(0.1, 0.12, -1));
  } else {
    camera.fov = 60;
    look.set(-0.3, 0.3, -1);
  }
  camera.lookAt(look.normalize().multiplyScalar(100).add(camera.position));
}

// ---- 渲染：四格 ----
const labels = PANELS.map((p) => {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = p.name;
  host.appendChild(el);
  return el;
});
const info = document.createElement('div');
info.className = 'label';
info.style.right = '8px';
info.style.top = '8px';
host.appendChild(info);
function resize() {
  renderer.setSize(host.clientWidth, host.clientHeight, false);
}
addEventListener('resize', resize);
resize();

function render() {
  const t = applyTime();
  aimCamera();
  const size = renderer.getSize(new THREE.Vector2());
  const w = size.x;
  const h = Math.floor(size.y / 2);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setScissorTest(true);
  PANELS.forEach((p, i) => {
    for (const q of PANELS) q.obj.visible = q === p;
    const x = 0;
    const y = i === 0 ? h : 0;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(scene, camera);
    labels[i].style.left = '8px';
    labels[i].style.top = `${(i === 0 ? 0 : h) + 8}px`;
  });
  renderer.setScissorTest(false);
  const hh = Math.floor(t.hours);
  info.textContent = `${hh}:${String(Math.round((t.hours - hh) * 60)).padStart(2, '0')}  太阳 ${t.sunElev.toFixed(1)}°  ×${speed}`;
}

// ---- 控制条 ----
const bar = document.getElementById('bar')!;
let speed = 1;
function group(label: string, items: Array<{ text: string; on: () => boolean; click: () => void }>) {
  const g = document.createElement('div');
  g.className = 'group';
  g.append(label);
  const btns = items.map((it) => {
    const b = document.createElement('button');
    b.textContent = it.text;
    b.onclick = () => {
      it.click();
      refresh();
    };
    g.append(b);
    return { b, it };
  });
  bar.append(g);
  return btns;
}
const allBtns = [
  ...group(
    '时间',
    [
      ['清晨', 5.2],
      ['白天', 15],
      ['傍晚', 18.2],
      ['黄昏', 18.75],
      ['暮色', 19.3],
      ['夜晚', 21.5],
    ].map(([text, h]) => ({ text: text as string, on: () => hours === h, click: () => (hours = h as number) })),
  ),
  ...group(
    '视角',
    VIEWS.map((v) => ({ text: v.label, on: () => view === v.id, click: () => (view = v.id) })),
  ),
  ...group(
    '速度',
    [1, 30, 120].map((s) => ({ text: `×${s}`, on: () => speed === s, click: () => (speed = s) })),
  ),
];
function refresh() {
  for (const { b, it } of allBtns) b.classList.toggle('on', it.on());
}
refresh();

const clock = new THREE.Clock();
function loop() {
  blender.update(Math.min(clock.getDelta(), 0.1) * speed);
  render();
  requestAnimationFrame(loop);
}
loop();

// 截图（开发用）：__lab.shot('x.jpg', 21.5, 'moon')
(window as unknown as { __lab: unknown }).__lab = {
  cu,
  async shot(name: string, h = hours, v: View = view, advance = 0) {
    hours = h;
    view = v;
    cu.uTime.value += advance;
    refresh();
    render();
    const blob = await new Promise<Blob>((ok) => renderer.domElement.toBlob((b) => ok(b!), 'image/jpeg', 0.9));
    const res = await fetch(`/__dev/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return res.ok;
  },
  setSize(w: number, h: number) {
    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
    resize();
  },
};
