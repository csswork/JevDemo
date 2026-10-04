import * as THREE from 'three';
import { HAZE, SEA_Y, createClouds as createCanvasClouds, createFarLand, createFarTown, createSky, skyUniforms } from '../vrm/scenes/seaside';
import { createPalette, createSkyMapping, moonIllum, morningTint, samplePalette } from '../vrm/scenes/streetTime';
import { TimeOfDay } from '../vrm/timeOfDay';

/**
 * 开发用：云的几种画法并排对比（/cloudlab.html，只在 vite dev 下有）。
 *
 * 同一个镜头、同一片天空和远山，四格分别是：
 *   1. 原来的：canvas 画的云片（seaside.ts 的 createClouds）
 *   2. 噪声云 · 柔和：分形噪声的密度（一条顶边定个大概）+ 朝光源方向步进几次估遮挡（Shadertoy 上 2D 程序云的常见做法）
 *   3. 棉花团 · 柔和写实：十几个圆团平滑并起来定形状，噪声只做边上的小鼓包；同样朝光源步进 —— 每一团各自上亮下暗
 *   4. 棉花团 · 插画分层：同 3 的形状，亮暗分几层、阴影偏蓝、边缘清楚
 * 2~4 的云会漂移、慢慢翻涌；月亮附近的云变薄、透出月光。
 *
 * 截图：__lab.shot('name.jpg', 小时, 视角) → dev-out/
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

// ---- 2~4. 密度场的云 ----
const cu = {
  uTime: { value: 0 },
  uDrift: { value: D(0.1) },
  /** 主光（白天太阳、夜里月亮）：方向、照亮那一面的颜色 */
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  uKeyCol: { value: new THREE.Color(1, 1, 1) },
  /** 背光面的颜色（天光） */
  uShade: { value: new THREE.Color(0xb7c7e2) },
  uHaze: { value: new THREE.Color(HAZE) },
  uHazeAmt: { value: 0.4 },
  uMoonDir: { value: new THREE.Vector3(0, 0.2, -1) },
  uMoonGlow: { value: 0 },
  /** 光在云背后时边缘透光：范围（越大越集中在光源附近）、强度 */
  uRimPow: { value: 8 },
  uRim: { value: 1 },
};

const VERT = /* glsl */ `
  uniform float uTime, uDrift;
  uniform vec3 uKeyDir;
  attribute vec4 aPlace; // 起始方位角、云底的高度角（弧度）、宽（负数 = 左右翻过来）、离中心多远
  attribute vec4 aBand;  // 组的起始方位角、方位角范围（≥ 2π = 一整圈）、角速度的倍数
  attribute vec4 aSeed;  // 种子、高矮、不透明度
  varying vec2 vQ;
  varying vec3 vDir, vL;
  varying vec4 vInfo;
  void main() {
    float span = aBand.y;
    float u = mod( aPlace.x - aBand.x + uDrift * aBand.z * uTime, span );
    float a = aBand.x + u;
    float life = span >= 6.28 ? 1.0 : smoothstep( 0.0, 0.12, u / span ) * smoothstep( 1.0, 0.88, u / span );
    float w = aPlace.z;
    vec3 out_ = vec3( cos( a ), 0.0, sin( a ) );
    vec3 right = vec3( -sin( a ), 0.0, cos( a ) ) * sign( w );
    vec3 C = vec3( out_.x * cos( aPlace.y ), sin( aPlace.y ), out_.z * cos( aPlace.y ) ) * aPlace.w;
    vec3 wp = C + ( right * position.x + vec3( 0.0, position.y, 0.0 ) ) * abs( w ) * 0.5;
    vQ = position.xy;
    vDir = wp - cameraPosition;
    vL = vec3( dot( uKeyDir, right ), uKeyDir.y, -dot( uKeyDir, out_ ) );
    vInfo = vec4( aSeed.x, aSeed.y, aSeed.z, life );
    gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime, uHazeAmt, uMoonGlow, uRimPow, uRim;
  uniform vec3 uKeyDir, uKeyCol, uShade, uHaze, uMoonDir;
  varying vec2 vQ;
  varying vec3 vDir, vL;
  varying vec4 vInfo;
  const float BASE = 0.08;

  float cHash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float cNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( cHash( i ), cHash( i + vec2( 1.0, 0.0 ) ) , u.x ), mix( cHash( i + vec2( 0.0, 1.0 ) ), cHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
  float h11( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453 ); }
  // "滚滚"的噪声：每一层取 |2n-1|，鼓起来的地方圆、之间是尖的缝 —— 积云一团团的边
  float billow( vec2 p, int oct ) {
    float s = 0.0, a = 0.5, n = 0.0;
    for ( int i = 0; i < 6; i++ ) {
      if ( i >= oct ) break;
      s += a * abs( cNoise( p ) * 2.0 - 1.0 );
      n += a;
      p = p * 2.07 + vec2( 13.1, 7.7 );
      a *= 0.5;
    }
    return s / n;
  }
  float smin( float a, float b, float k ) {
    float h = clamp( 0.5 + 0.5 * ( b - a ) / k, 0.0, 1.0 );
    return mix( b, a, h ) - k * h * ( 1.0 - h );
  }
  // 慢慢翻涌：大的扭动
  vec2 churn( vec2 p ) {
    float t = uTime;
    return vec2( cNoise( p * 0.7 + vec2( t * 0.02, 0.0 ) ), cNoise( p * 0.7 + vec2( 4.0, -t * 0.017 ) ) ) - 0.5;
  }
#if SHAPE == 0
  // ---- 噪声云：一条平滑的顶边（一层底 + 两三座"塔"）定个大概，形状主要靠噪声 ----
  float topLine( float x, float seed, float tall ) {
    float h = 0.12 + 0.06 * h11( seed + 1.0 );
    for ( int i = 0; i < 3; i++ ) {
      float fi = float( i );
      float c = mix( -0.6, 0.6, h11( seed + fi * 7.1 + 2.0 ) );
      float w = mix( 0.16, 0.34, h11( seed + fi * 3.3 + 5.0 ) );
      float hh = mix( 0.25, 0.7, h11( seed + fi * 5.7 + 9.0 ) ) * tall;
      float k = ( x - c ) / w;
      h = max( h, hh * exp( -k * k ) );
    }
    return h * smoothstep( 1.0, 0.55, abs( x ) );
  }
  float density( vec2 q, int oct ) {
    float seed = vInfo.x;
    float th = topLine( q.x, seed, vInfo.y );
    float y = q.y - BASE;
    float sh = min( 1.0 - y / max( th, 0.02 ), 1.0 );
    vec2 p = q * vec2( 2.4, 2.8 ) + seed * 3.7;
    p += churn( p ) * 0.7;
    float b = billow( p + vec2( 0.0, -uTime * 0.012 ), oct );
    float d = sh * 0.9 + ( b - 0.42 ) * 1.2 - 0.2 - ( 1.0 - vInfo.w ) * 1.2;
    return d * smoothstep( 0.0, 0.035, y + ( b - 0.45 ) * 0.025 );
  }
#else
  // ---- 棉花团：十几个圆团平滑地并在一起（底下一排、中间往上堆两座塔），噪声只在边上做小鼓包 ----
  float puffSdf( vec2 q, float seed, float tall ) {
    float d = 1e3;
    for ( int i = 0; i < 7; i++ ) {
      float fi = float( i );
      float x = -0.78 + fi * 0.26 + ( h11( seed + fi * 1.7 ) - 0.5 ) * 0.08;
      float r = ( 0.09 + 0.06 * h11( seed + fi * 2.9 + 1.0 ) ) * ( 1.0 - 0.35 * abs( x ) );
      d = smin( d, length( q - vec2( x, BASE + r * 0.55 ) ) - r, 0.05 );
    }
    for ( int k = 0; k < 2; k++ ) {
      float fk = float( k );
      float cx = mix( -0.45, 0.45, h11( seed + fk * 11.3 + 4.0 ) );
      float top = mix( 0.35, 0.75, h11( seed + fk * 6.1 + 8.0 ) ) * tall * ( 1.0 - 0.35 * fk );
      for ( int i = 0; i < 5; i++ ) {
        float t = float( i ) / 4.0;
        float r = ( 0.15 - t * 0.06 ) * ( 0.85 + 0.3 * h11( seed + fk * 5.0 + float( i ) * 3.1 ) );
        vec2 c = vec2( cx + ( h11( seed + fk * 9.0 + float( i ) * 1.3 ) - 0.5 ) * 0.22 * ( 1.0 - t * 0.5 ), BASE + 0.06 + ( top - 0.06 ) * t );
        c.y = min( c.y, 0.97 - r );
        d = smin( d, length( q - c ) - r, 0.04 );
      }
    }
    return max( d, BASE - q.y );
  }
  float density( vec2 q, int oct ) {
    float seed = vInfo.x;
    vec2 p = q * 5.0 + seed * 3.7;
    float b = billow( p + churn( p * 0.4 ) * 0.8 + vec2( 0.0, -uTime * 0.02 ), oct );
    float sd = puffSdf( q + churn( q * 3.0 + seed ) * 0.04, seed, vInfo.y );
    return -sd * 5.0 + ( b - 0.45 ) * 0.5 - ( 1.0 - vInfo.w ) * 1.2;
  }
#endif
  void main() {
    vec2 q = vQ;
    float d = density( q, 5 );
    if ( d <= -0.02 ) discard;
    // 朝光源走几步，看这一点被前面的云挡了多少光（光在云背后时，自己这一团的厚度也挡光）
    vec2 step_ = vL.xy * 0.06;
    float od = max( d, 0.0 ) * ( 1.0 - vL.z ) * 0.6;
    for ( int i = 1; i <= 4; i++ ) od += max( density( q + step_ * float( i ), 3 ), 0.0 ) * 0.35;
    float T = exp( -od * 2.2 );
    float y = q.y - BASE;
    float ao = mix( 0.62, 1.0, smoothstep( 0.0, 0.45, y ) );
    vec3 v = normalize( vDir );
    float ph = pow( max( dot( v, uKeyDir ), 0.0 ), uRimPow ) * uRim;
    vec3 c;
    float alpha;
  #if STYLE == 0
    // 柔和写实
    c = mix( uShade * ao, uKeyCol, T );
    c += uKeyCol * ph * ( 1.0 - smoothstep( 0.0, 0.35, d ) ) * 1.3;
    alpha = smoothstep( 0.0, 0.4, d );
  #elif STYLE == 1
    // 插画分层：深影 / 影 / 半亮 / 亮，分界清楚；阴影偏蓝
    vec3 deep = uShade * 0.8;
    vec3 mid = mix( uShade, uKeyCol, 0.6 );
    float l = T * mix( 0.75, 1.0, ao );
    c = mix( deep, uShade, smoothstep( 0.16, 0.2, l ) );
    c = mix( c, mid, smoothstep( 0.4, 0.44, l ) );
    c = mix( c, uKeyCol, smoothstep( 0.66, 0.7, l ) );
    float edge = 1.0 - smoothstep( 0.04, 0.2, d );
    c += uKeyCol * ph * edge * 1.6;
    alpha = smoothstep( 0.02, 0.06, d );
  #endif
    // 月亮从云后面透出来：离月亮 4° 以内的云薄一些，再加一团朦胧的光
    float md = max( dot( v, uMoonDir ), 0.0 );
    alpha *= 1.0 - 0.5 * uMoonGlow * smoothstep( 0.9975, 0.99994, md );
    c += vec3( 0.75, 0.82, 1.0 ) * ( pow( md, 3000.0 ) * 1.2 + pow( md, 250.0 ) * 0.35 ) * uMoonGlow;
    // 远处、贴着地平线的融进天色
    c = mix( c, uHaze, uHazeAmt * ( 1.0 - smoothstep( 0.02, 0.3, v.y ) ) );
    gl_FragColor = vec4( c, alpha * vInfo.z );
    #include <colorspace_fragment>
  }
`;

interface Band {
  from: number;
  to: number;
  count: number;
  elev: [number, number];
  width: [number, number];
  tall: [number, number];
  opacity: [number, number];
}
function cloudGeometry(dist: number, bands: Band[], seed: number) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const all: Array<{ place: number[]; band: number[]; seed: number[]; dist: number }> = [];
  for (const b of bands) {
    const span = Math.min(b.to - b.from, Math.PI * 2);
    for (let k = 0; k < b.count; k++) {
      const pick = ([lo, hi]: [number, number]) => lo + (hi - lo) * r();
      const d = dist * (0.97 + 0.03 * r());
      const a = b.from + ((k + 0.5) / b.count) * span + (r() - 0.5) * (span / b.count) * 0.6;
      all.push({
        place: [a, D(pick(b.elev)), pick(b.width) * d * (r() < 0.5 ? -1 : 1), d],
        band: [b.from, span >= Math.PI * 2 - 1e-3 ? 6.3 : span, dist / d, 0],
        seed: [r() * 100, pick(b.tall), pick(b.opacity), 0],
        dist: d,
      });
    }
  }
  all.sort((x, y) => y.dist - x.dist);
  const base = new THREE.PlaneGeometry(2, 1);
  base.translate(0, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  const attr = (k: 'place' | 'band' | 'seed') => new THREE.InstancedBufferAttribute(new Float32Array(all.flatMap((c) => c[k])), 4);
  geo.setAttribute('aPlace', attr('place'));
  geo.setAttribute('aBand', attr('band'));
  geo.setAttribute('aSeed', attr('seed'));
  geo.instanceCount = all.length;
  return geo;
}
const geo = cloudGeometry(
  SKY_R * 0.9,
  [
    { from: D(-140), to: D(40), count: 18, elev: [3, 7], width: [0.36, 0.66], tall: [0.6, 1.2], opacity: [0.95, 1] },
    { from: D(40), to: D(220), count: 7, elev: [4, 8], width: [0.22, 0.38], tall: [0.5, 0.9], opacity: [0.85, 0.9] },
  ],
  91,
);
/** 2~4 格：[名字, 形状（0 噪声云 / 1 棉花团）, 画法（0 柔和 / 1 插画分层）] */
const VARIANTS: Array<[string, number, number]> = [
  ['噪声云 · 柔和', 0, 0],
  ['棉花团 · 柔和写实', 1, 0],
  ['棉花团 · 插画分层', 1, 1],
];
const newClouds = VARIANTS.map(([, shape, style]) => {
  const m = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: cu,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { SHAPE: shape, STYLE: style },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  m.frustumCulled = false;
  m.renderOrder = -1;
  scene.add(m);
  return m;
});
const PANELS: Array<{ name: string; obj: THREE.Object3D }> = [
  { name: '1. 原来的（canvas）', obj: oldClouds },
  ...newClouds.map((m, i) => ({ name: `${i + 2}. ${VARIANTS[i][0]}`, obj: m as THREE.Object3D })),
];

// ---- 时间 → 颜色 ----
const time = new TimeOfDay();
const mapping = createSkyMapping(SUN_POS);
const pal = createPalette();
const sunW = new THREE.Vector3();
const moonW = new THREE.Vector3();
const MOON_COL = new THREE.Color(0xb4c4ec);
/** 云的背光面（按太阳高度插值） */
const SHADE: Array<[number, number]> = [
  [30, 0xb7c7e2],
  [15, 0xb2c0da],
  [6, 0xaea8c4],
  [1, 0x8a80a8],
  [-4, 0x4c4a68],
  [-10, 0x1e2236],
  [-18, 0x141826],
];
const _c = new THREE.Color();
function shadeAt(elev: number, out: THREE.Color) {
  if (elev >= SHADE[0][0]) return out.setHex(SHADE[0][1]);
  for (let i = 0; i < SHADE.length - 1; i++) {
    const [e0, c0] = SHADE[i];
    const [e1, c1] = SHADE[i + 1];
    if (elev >= e1) return out.setHex(c0).lerp(_c.setHex(c1), smoothstep(e0, e1, elev));
  }
  return out.setHex(SHADE[SHADE.length - 1][1]);
}

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
  // 新的云：白天太阳照，太阳落到 -8° 以下换成月亮
  if (day) {
    cu.uKeyDir.value.copy(sunW);
    cu.uKeyCol.value.copy(pal.cloud).multiplyScalar(smoothstep(-8, -3, elev) * 0.85 + 0.15);
    cu.uRimPow.value = 8;
    cu.uRim.value = 1;
  } else {
    cu.uKeyDir.value.copy(moonW);
    cu.uKeyCol.value.copy(MOON_COL).multiplyScalar(0.3 * (0.4 + 0.6 * illum) * smoothstep(-2, 3, moonElev));
    // 月亮小：亮边只在月亮附近
    cu.uRimPow.value = 60;
    cu.uRim.value = 2;
  }
  shadeAt(elev, cu.uShade.value);
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
  const w = Math.floor(size.x / 2);
  const h = Math.floor(size.y / 2);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setScissorTest(true);
  PANELS.forEach((p, i) => {
    for (const q of PANELS) q.obj.visible = q === p;
    const x = (i % 2) * w;
    const y = i < 2 ? h : 0;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(scene, camera);
    labels[i].style.left = `${x + 8}px`;
    labels[i].style.top = `${(i < 2 ? 0 : h) + 8}px`;
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
  cu.uTime.value += Math.min(clock.getDelta(), 0.1) * speed;
  render();
  requestAnimationFrame(loop);
}
loop();

// 截图（开发用）：__lab.shot('x.jpg', 21.5, 'moon')
(window as unknown as { __lab: unknown }).__lab = {
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
