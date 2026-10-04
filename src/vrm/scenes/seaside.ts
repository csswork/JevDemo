import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { canvasTexture, rng } from './common';

/**
 * 街景（street.ts）的远景：天空（云在 clouds.ts）、对岸的山和小镇、防波堤上的灯塔、远处的跨海桥（海面本身见 water.ts），
 * 海上慢慢绕圈的几条渔船、头顶盘旋的海鸥（这两样是 Blender 做的模型，见 scripts/blender/）。
 *
 * 照着一张二次元风格的海边小镇插画搭：深蓝的天、地平线发白，大朵的积云堆在山后面；
 * 对岸一条白色的小镇贴着海岸线，后面两层山（近的绿、远的发蓝）。
 *
 * 远景都很远（对岸 1km 外，山在 1.2~2km）：长焦（24°）会把远处的东西放大 —— 第一版对岸放在 430m，
 * 山顶满了半个画面、压在头后面，对岸的房子一栋栋大得像近景。按"山顶在地平线上 3~6°、小镇是一条细白线"
 * 倒推的距离和高度。远景不投影、不接收阴影。
 */

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- 噪声（地形用）----
const hash = (x: number, y: number) => {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** 值噪声，0..1 */
export function noise2(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** 分形噪声，0..1 */
export function fbm(x: number, y: number, octaves = 5) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * noise2(x * f + i * 17.3, y * f - i * 9.1);
    n += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/** 海面高度（世界 y）。岸边的护岸、防波堤都按它算 */
export const SEA_Y = -1.2;
/** 地平线 / 雾的颜色：天空最下面一圈、海的远处、山的雾都是它，接得上 */
export const HAZE = 0xd3e8f5;

type Keep = <T extends { dispose(): void }>(x: T) => T;

// ---- 天空 ----
/**
 * 天空的参数（按时间变，见 streetTime.ts）。颜色是线性空间的。
 * 渐变：地平线 → mid（很窄就过渡过去）→ 天顶；太阳周围一圈光晕（glowAmt），黄昏时贴着地平线、朝着太阳那边一条暖色带（band）；
 * 夜里有星星（stars）和月亮（moon = 显不显，phase = 月相）
 */
export function skyUniforms() {
  return {
    uZenith: { value: new THREE.Color(0x2265c8) },
    uMid: { value: new THREE.Color(0x4f98e6) },
    uHorizon: { value: new THREE.Color(HAZE) },
    uGlow: { value: new THREE.Color(0xfff8e6) },
    uGlowAmt: { value: 0.55 },
    uBand: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunDisk: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    uMoon: { value: 0 },
    uMoonPhase: { value: 0.38 },
    uMoonTex: { value: null as THREE.Texture | null },
    uStars: { value: 0 },
    uTime: { value: 0 },
    /** 只给环境贴图用：HDRI 混进来多少、乘什么色、绕竖轴转多少；地平线以下的地面色；地平线上小镇的灯 */
    uHdri: { value: null as THREE.Texture | null },
    uHdriMix: { value: 0 },
    uHdriTint: { value: new THREE.Color(1, 1, 1) },
    uHdriRot: { value: 0 },
    uGround: { value: new THREE.Color(0x1a1e26) },
    uTownGlow: { value: 0 },
  };
}
export type SkyUniforms = ReturnType<typeof skyUniforms>;

/** 月亮的盘面（canvas）：灰白的底、一块块暗的月海、几个亮的环形山。月相在着色器里按球面算 */
function moonTexture() {
  const r = rng(77);
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.save();
    g.beginPath();
    g.arc(128, 128, 124, 0, Math.PI * 2);
    g.clip();
    const base = g.createRadialGradient(110, 110, 10, 128, 128, 130);
    base.addColorStop(0, '#f4f2ea');
    base.addColorStop(1, '#d8d6cf');
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 256);
    // 月海：几块大的暗斑（参考满月时"兔子"的位置）
    const maria: Array<[number, number, number]> = [
      [96, 92, 34],
      [140, 80, 26],
      [160, 120, 30],
      [118, 140, 22],
      [84, 150, 18],
      [150, 168, 16],
    ];
    for (const [x, y, rr] of maria) {
      for (let k = 0; k < 6; k++) {
        g.fillStyle = `rgba(120,122,128,${0.12 + r() * 0.1})`;
        g.beginPath();
        g.ellipse(x + (r() - 0.5) * rr * 0.6, y + (r() - 0.5) * rr * 0.6, rr * (0.5 + r() * 0.5), rr * (0.4 + r() * 0.5), r() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (let k = 0; k < 40; k++) {
      const x = 20 + r() * 216;
      const y = 20 + r() * 216;
      const rr = 1.5 + r() * 5;
      g.fillStyle = `rgba(255,255,250,${0.15 + r() * 0.2})`;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `rgba(110,110,115,${0.1 + r() * 0.1})`;
      g.beginPath();
      g.arc(x + rr * 0.3, y + rr * 0.3, rr * 0.8, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  });
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize( ( modelMatrix * vec4( position, 0.0 ) ).xyz );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    gl_Position.z = gl_Position.w; // 永远在最远处
  }
`;
const SKY_COMMON = /* glsl */ `
  uniform vec3 uZenith, uMid, uHorizon, uGlow;
  uniform float uGlowAmt, uBand;
  uniform vec3 uSunDir;
  uniform float uSunDisk;
  varying vec3 vDir;
  vec3 skyGradient( vec3 d ) {
    float e = max( d.y, 0.0 );
    // 地平线那一圈很窄就过渡到天蓝（插画里的天是饱和的深蓝，只有贴着地平线才发白）
    vec3 c = mix( uHorizon, uMid, smoothstep( 0.0, 0.2, e ) );
    c = mix( c, uZenith, smoothstep( 0.18, 0.85, e ) );
    float sd = max( dot( d, uSunDir ), 0.0 );
    c = mix( c, uGlow, uGlowAmt * pow( sd, 12.0 ) );
    // 黄昏：贴着地平线、朝太阳那一侧的一条暖色带（背着太阳的那边也有一点）
    vec2 dh = normalize( d.xz + 1e-5 );
    vec2 sh = normalize( uSunDir.xz + 1e-5 );
    // 底数要夹到 0 以上：两个单位向量的点积会略小于 -1，负数开 2.5 次方是 NaN —— 正背着太阳的那一两个像素，
    // 烘环境贴图时 PMREM 的模糊会把它摊到整张图上，所有吃环境光的材质一片黑
    float side = pow( clamp( dot( dh, sh ) * 0.5 + 0.5, 0.0, 1.0 ), 2.5 );
    c = mix( c, uGlow, uBand * ( 0.25 + 0.75 * side ) * ( 1.0 - smoothstep( 0.0, 0.32, e ) ) );
    // 太阳盘（只在太阳附近，白天几乎不会转到它）
    c += uGlow * uSunDisk * smoothstep( 0.99985, 0.99993, sd ) * 6.0;
    return c;
  }
`;
const SKY_FRAG = /* glsl */ `
  ${SKY_COMMON}
  uniform vec3 uMoonDir;
  uniform float uMoon, uMoonPhase, uStars, uTime;
  uniform sampler2D uMoonTex;
  float hash13( vec3 p ) {
    p = fract( p * 0.1031 );
    p += dot( p, p.zyx + 31.32 );
    return fract( ( p.x + p.y ) * p.z );
  }
  void main() {
    vec3 d = normalize( vDir );
    vec3 c = skyGradient( d );
    float e = max( d.y, 0.0 );
    // 星星：方向空间里一格一格，少数格子里有一颗，各自闪；贴着地平线的看不见（雾、光污染）
    if ( uStars > 0.0 ) {
      vec3 sp = d * 260.0;
      vec3 cell = floor( sp );
      float h = hash13( cell );
      if ( h > 0.982 ) {
        vec3 f = fract( sp ) - 0.5 - ( vec3( hash13( cell + 7.1 ), hash13( cell + 3.7 ), hash13( cell + 1.3 ) ) - 0.5 ) * 0.5;
        float tw = 0.65 + 0.35 * sin( uTime * ( 1.3 + h * 4.0 ) + h * 60.0 );
        float b = ( h - 0.982 ) / 0.018;
        c += vec3( 0.85, 0.9, 1.0 ) * smoothstep( 0.22, 0.0, length( f ) ) * ( 0.25 + 1.6 * b * b ) * tw * uStars * smoothstep( 0.03, 0.2, e );
      }
    }
    // 月亮：盘面贴图 + 按月相的明暗（球面上的光照），外面一圈淡淡的光晕
    if ( uMoon > 0.0 ) {
      float md = dot( d, uMoonDir );
      const float SIZE = 0.0105; // 半径约 0.6°，比真的大一倍（长焦下更好看）
      float halo = pow( max( md, 0.0 ), 900.0 ) * 0.35 + pow( max( md, 0.0 ), 90.0 ) * 0.08;
      c += vec3( 0.75, 0.82, 1.0 ) * halo * uMoon;
      if ( md > cos( SIZE ) ) {
        vec3 right = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.0 ) ) );
        vec3 up = cross( right, uMoonDir );
        vec2 uv = vec2( dot( d, right ), dot( d, up ) ) / sin( SIZE );
        float r2 = dot( uv, uv );
        if ( r2 < 1.0 ) {
          vec3 n = vec3( uv, sqrt( 1.0 - r2 ) );
          float th = uMoonPhase * 6.2831853;
          vec3 L = vec3( sin( th ), 0.0, -cos( th ) );
          float lit = smoothstep( -0.04, 0.12, dot( n, L ) );
          vec3 tex = texture2D( uMoonTex, uv * 0.5 + 0.5 ).rgb;
          vec3 moon = tex * ( lit * 1.25 + 0.035 ) * vec3( 1.0, 0.97, 0.9 );
          float edge = smoothstep( 1.0, 0.92, r2 );
          c = mix( c, moon + c * ( 1.0 - lit ) * 0.6, edge * uMoon );
        }
      }
    }
    gl_FragColor = vec4( c, 1.0 );
    #include <colorspace_fragment>
  }
`;
/** 环境贴图（反射）用的天空：同一套渐变，白天混进 HDRI（玻璃、铁件反射的云和太阳），地平线以下是地面 / 海 */
const ENV_FRAG = /* glsl */ `
  ${SKY_COMMON}
  uniform sampler2D uHdri;
  uniform float uHdriMix, uHdriRot, uTownGlow;
  uniform vec3 uHdriTint, uGround;
  void main() {
    vec3 d = normalize( vDir );
    vec3 c = skyGradient( d );
    c = mix( c, uGround, 1.0 - smoothstep( -0.25, 0.0, d.y ) );
    // 地平线上一圈小镇的灯（夜里反射里的暖光）
    c += vec3( 1.0, 0.72, 0.42 ) * uTownGlow * exp( -abs( d.y ) * 28.0 );
    if ( uHdriMix > 0.0 ) {
      float cs = cos( uHdriRot ), sn = sin( uHdriRot );
      vec3 dl = vec3( cs * d.x - sn * d.z, d.y, sn * d.x + cs * d.z );
      vec2 uv = vec2( atan( dl.z, dl.x ) * 0.15915494 + 0.5, asin( clamp( dl.y, -1.0, 1.0 ) ) * 0.31830989 + 0.5 );
      c = mix( c, texture2D( uHdri, uv ).rgb * uHdriTint, uHdriMix );
    }
    gl_FragColor = vec4( c, 1.0 );
  }
`;

export function createSky(keep: Keep, radius: number, uniforms: SkyUniforms) {
  uniforms.uMoonTex.value = keep(moonTexture());
  const mat = keep(
    new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(radius, 48, 24)), mat);
  sky.renderOrder = -2;
  sky.frustumCulled = false;
  sky.name = 'sky';
  return sky;
}

/** 烘环境贴图用的小场景（舞台按 Backdrop.lighting.envScene 烘成 PMREM）：一个天空球，和画面里的天空共用参数 */
export function createSkyEnv(keep: Keep, uniforms: SkyUniforms) {
  const scene = new THREE.Scene();
  const mat = keep(new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERT, fragmentShader: ENV_FRAG, side: THREE.BackSide, depthWrite: false }));
  scene.add(new THREE.Mesh(keep(new THREE.SphereGeometry(500, 48, 24)), mat));
  return scene;
}

// ---- 对岸：山 + 小镇 ----
/**
 * 对岸的海岸线离角色多远（按方位角 a = atan2(z, x)）。海湾的开口朝 -Z / +X，
 * 正前方（她身后，-Z）最近，往两边绕远
 */
export function farShore(a: number) {
  const deg = THREE.MathUtils.radToDeg(a);
  // -90° 正前方 1km，往 +X 方向（0°）、再往 +Z 方向（80°）越来越远；往左（-150°）也远一点
  const t = (deg + 90) / 170; // -90° → 0, 80° → 1
  const right = 1000 + 650 * smoothstep(0, 1, t) + 90 * Math.sin(deg * 0.09);
  const left = 1000 + 350 * smoothstep(-90, -150, deg) + 60 * Math.sin(deg * 0.13 + 1);
  return deg >= -90 ? right : left;
}

/**
 * 对岸的山：极坐标的高度场（方位角 from..to，从海岸线往里 0..depth 米）。
 * 岸边先是一条平地（小镇），往里两道山脊：近的绿，远的偏蓝（插画里的空气透视，比只靠雾冲淡更蓝）
 */
export function createFarLand(keep: Keep, from: number, to: number) {
  const NA = 300;
  const NR = 46;
  const depth = 950;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  const shoreCol = new THREE.Color(0x9fb39a);
  const nearCol = new THREE.Color(0x3f8044);
  const nearDark = new THREE.Color(0x2c6439);
  const farCol = new THREE.Color(0x5b86b0);
  for (let i = 0; i <= NA; i++) {
    const a = from + ((to - from) * i) / NA;
    const r0 = farShore(a);
    for (let j = 0; j <= NR; j++) {
      // 岸边密、往里疏
      const u = depth * (j / NR) ** 1.6;
      const r = r0 + u;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const n1 = fbm(x * 0.004, z * 0.004, 5);
      const n2 = fbm(x * 0.0024 + 40, z * 0.0024 - 20, 4);
      // 第一道山脊（岸边往里 80~450m）、第二道（450m 往后）更高
      const ridge1 = smoothstep(50, 220, u) * (1 - 0.55 * smoothstep(330, 520, u)) * (30 + 80 * n1 * n1 * 1.6);
      const ridge2 = smoothstep(330, 680, u) * (70 + 130 * n2 * n2 * 1.8);
      let y = -4 + 6.5 * smoothstep(0, 14, u) + Math.max(ridge1, ridge2) + 6 * (n1 - 0.5);
      // 方位角两头往下收（山脉的尽头没进海里）
      const edge = Math.min(i, NA - i) / NA;
      y = THREE.MathUtils.lerp(-6, y, smoothstep(0, 0.06, edge));
      pos.push(x, y, z);
      // 颜色：岸边灰绿（小镇的地面）→ 山坡绿（一块块深浅）→ 远处的山偏蓝
      const forest = smoothstep(0.45, 0.6, fbm(x * 0.02, z * 0.02, 3));
      c.copy(nearCol).lerp(nearDark, forest * 0.7);
      c.lerp(shoreCol, 1 - smoothstep(10, 60, u));
      c.lerp(farCol, smoothstep(300, 680, u) * 0.85);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NA; i++) {
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j;
      const b = a + NR + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = keep(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 法线朝下就翻绕序（方位角递增的方向决定左右手）
  if (g.attributes.normal.getY(NR) < 0) {
    g.setIndex(idx.map((_, k) => idx[k - (k % 3) + 2 - (k % 3)]));
    g.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(g, keep(new THREE.MeshLambertMaterial({ vertexColors: true })));
  mesh.name = 'far-land';
  return mesh;
}

/**
 * 对岸的小镇：贴着海岸线的一条白房子（远看就是一排白的、米色的方块），一部分往山脚爬一点。
 * 一个 InstancedMesh，每栋一个颜色；盒子顶面压暗当屋顶
 */
/** 对岸小镇每栋房子的位置、朝向、大小、墙色（createFarTown 的白盒子和 street.ts 换上的 Blender 房子用同一份） */
export interface TownSpot {
  pos: THREE.Vector3;
  rotY: number;
  w: number;
  h: number;
  d: number;
  color: number;
  /** 0..1 的随机数（选房子的样式、瓦色） */
  pick: number;
  /** 离岸多远（米） */
  u: number;
}
export function farTownSpots(from: number, to: number, count = 900): TownSpot[] {
  const r = rng(404);
  const palette = [0xffffff, 0xfbf6ec, 0xf1f3f5, 0xfdf8f0, 0xeaf0f5, 0xf5ebdd, 0xffffff, 0xe6eaee, 0xf3e4d4];
  const out: TownSpot[] = [];
  for (let k = 0; k < count * 3 && out.length < count; k++) {
    const a = from + r() * (to - from);
    const u = r() < 0.85 ? 8 + r() * 52 : 50 + r() * 60;
    const rr = farShore(a) + u;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const tall = r() < 0.05;
    const w = 7 + r() * 9;
    const h = tall ? 12 + r() * 8 : 4 + r() * 5;
    const d = 7 + r() * 8;
    const y = -4 + 6.5 * smoothstep(0, 14, u) + 0.08 * Math.max(0, u - 45);
    const rotY = -a + (r() - 0.5) * 0.4;
    const color = palette[Math.floor(r() * palette.length)];
    out.push({ pos: new THREE.Vector3(x, y, z), rotY, w, h, d, color, pick: (Math.sin(k * 12.9898) * 43758.5453) % 1, u });
  }
  for (const s of out) s.pick = Math.abs(s.pick);
  return out;
}

export function createFarTown(keep: Keep, from: number, to: number, count = 900, lights?: { value: number }) {
  const geo = keep(new THREE.BoxGeometry(1, 1, 1));
  geo.translate(0, 0.5, 0);
  // 顶面暗一点（屋顶），侧面原色
  const nrm = geo.attributes.normal;
  const vc: number[] = [];
  for (let i = 0; i < nrm.count; i++) {
    const top = nrm.getY(i) > 0.5;
    vc.push(top ? 0.62 : 1, top ? 0.66 : 1, top ? 0.74 : 1);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(vc, 3));
  // 自发光托一点底：背阴面不至于发灰（远看应该是一片白）
  const mat = keep(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x8a96a2, emissiveIntensity: 0.45 }));
  if (lights) farWindows(mat, lights);
  const im = keep(new THREE.InstancedMesh(geo, mat, count));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  let n = 0;
  for (const sp of farTownSpots(from, to, count)) {
    q.setFromAxisAngle(up, sp.rotY);
    m.compose(sp.pos.clone().setY(sp.pos.y - 0.5), q, new THREE.Vector3(sp.w, sp.h, sp.d));
    im.setMatrixAt(n, m);
    im.setColorAt(n, c.setHex(sp.color));
    n++;
  }
  im.count = n;
  im.computeBoundingSphere();
  im.name = 'far-town';
  return im;
}

/**
 * 对岸小镇夜里的窗灯：盒子的四个侧面按米分成一层层、一格格，随机一部分格子亮着暖黄的灯（每栋、每格固定）。
 * 1km 外一扇窗只有两三个像素：格子比像素还小的时候（掠射角、更远）淡成平均的亮度，不然转镜头时一片闪
 */
function farWindows(mat: THREE.MeshLambertMaterial, lights: { value: number }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLights = lights;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBox;\nvarying vec3 vBoxN;\nvarying float vSeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 sz = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
          vBox = position * sz;
          vBoxN = normal;
          vSeed = float( gl_InstanceID );
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLights;\nvarying vec3 vBox;\nvarying vec3 vBoxN;\nvarying float vSeed;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if ( uLights > 0.0 && abs( vBoxN.y ) < 0.5 ) {
          float u = abs( vBoxN.x ) > 0.5 ? vBox.z : vBox.x;
          float face = vBoxN.x + vBoxN.z * 2.0;
          vec2 g = vec2( u / 2.6, ( vBox.y - 0.7 ) / 2.8 );
          vec2 cell = floor( g );
          vec2 f = fract( g );
          float h = fract( sin( dot( vec3( cell, vSeed * 0.731 + face * 3.1 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
          float win = step( 0.28, f.x ) * step( f.x, 0.72 ) * step( 0.3, f.y ) * step( f.y, 0.78 ) * step( 0.0, cell.y ) * step( h, 0.34 );
          float fw = max( fwidth( g.x ), fwidth( g.y ) );
          win = mix( win, 0.07, smoothstep( 0.35, 1.0, fw ) );
          totalEmissiveRadiance += vec3( 1.0, 0.72, 0.38 ) * win * uLights * 1.6;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'far-town-windows';
}

/** 远处的跨海桥：一条长的桥面 + 一排桥墩，白灰色 */
export function createBridge(keep: Keep, a0: number, a1: number, inset: number) {
  const p0 = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0)).multiplyScalar(farShore(a0) - inset);
  const p1 = new THREE.Vector3(Math.cos(a1), 0, Math.sin(a1)).multiplyScalar(farShore(a1) - inset);
  const len = p0.distanceTo(p1);
  const parts: THREE.BufferGeometry[] = [];
  const deck = new THREE.BoxGeometry(len, 1.6, 9);
  deck.translate(0, 9, 0);
  parts.push(deck);
  // 栏杆那条细边
  const rail = new THREE.BoxGeometry(len, 0.9, 0.3);
  rail.translate(0, 10.2, 4.3);
  parts.push(rail);
  const piers = Math.round(len / 38);
  for (let k = 1; k < piers; k++) {
    const pier = new THREE.BoxGeometry(2.4, 12, 3.2);
    pier.translate(-len / 2 + (len * k) / piers, 2, 0);
    parts.push(pier);
  }
  const merged = mergeBoxes(parts);
  const mesh = new THREE.Mesh(keep(merged), keep(new THREE.MeshLambertMaterial({ color: 0xe9ecef })));
  mesh.position.copy(p0).lerp(p1, 0.5).setY(SEA_Y);
  mesh.rotation.y = -Math.atan2(p1.z - p0.z, p1.x - p0.x);
  mesh.name = 'bridge';
  return mesh;
}

/** 几个盒子合成一个几何体（只要位置和法线） */
function mergeBoxes(parts: THREE.BufferGeometry[]) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...(p.attributes.position.array as Float32Array));
    nrm.push(...(p.attributes.normal.array as Float32Array));
    for (const i of p.index!.array) idx.push(base + i);
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/**
 * 防波堤 + 灯塔（插画右边那座白灯塔）：一条低矮的混凝土堤，尽头一座白色的圆塔，
 * 上面一圈深色的回廊、玻璃灯室、深色的圆顶。from → to 是堤的两头（世界 xz），灯塔在 to 那头
 */
export function createLighthouse(keep: Keep, from: [number, number], to: [number, number], lights: { value: number }) {
  const group = new THREE.Group();
  group.name = 'lighthouse';
  const concrete = keep(new THREE.MeshStandardMaterial({ color: 0xcfcac0, roughness: 0.95 }));
  const white = keep(new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 }));
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.3 }));
  const glass = keep(new THREE.MeshStandardMaterial({ color: 0xbfe3f2, roughness: 0.1, metalness: 0.2, emissive: 0x6b8a99, emissiveIntensity: 0.4 }));
  const a = new THREE.Vector2(...from);
  const b = new THREE.Vector2(...to);
  const len = a.distanceTo(b);
  // 堤面只高出水面 1.6m：第一版 3m，比眼睛还高，在头后面挡出一条灰带、把后面的海遮住了
  const wall = new THREE.Mesh(keep(new THREE.BoxGeometry(len, 2.4, 3.4)), concrete);
  wall.position.set((a.x + b.x) / 2, SEA_Y + 0.4, (a.y + b.y) / 2);
  wall.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
  wall.name = 'breakwater';
  group.add(wall);
  // 灯塔：底座、塔身（往上收）、回廊、灯室、圆顶
  const tower = new THREE.Group();
  tower.position.set(b.x, SEA_Y + 1.6, b.y);
  const base = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.6, 2.8, 1.2, 24)), concrete);
  base.position.y = 0.6;
  tower.add(base);
  const body = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.35, 1.9, 10.5, 24)), white);
  body.position.y = 1.2 + 5.25;
  tower.add(body);
  const deck = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.0, 1.6, 0.5, 24)), dark);
  deck.position.y = 11.9;
  tower.add(deck);
  const lantern = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.95, 0.95, 1.6, 16)), glass);
  lantern.position.y = 12.95;
  tower.add(lantern);
  const roof = new THREE.Mesh(keep(new THREE.SphereGeometry(1.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), dark);
  roof.position.y = 13.75;
  tower.add(roof);
  // 门（塔身底部一个深色的小方块）
  const door = new THREE.Mesh(keep(new THREE.BoxGeometry(0.9, 1.8, 0.3)), dark);
  door.position.set(0, 2.1, 1.75);
  tower.add(door);
  // 门朝着角色这边
  tower.rotation.y = Math.atan2(-b.x, -b.y);
  tower.name = 'tower';
  group.add(tower);

  // 夜里：灯室亮起来，两道光束绕着转（10 秒一圈）。光束是两个开口的长锥，加法混合，越远越淡、边缘柔
  const beamMat = keep(
    new THREE.ShaderMaterial({
      uniforms: { uOn: { value: 0 } },
      vertexShader: `
        varying float vAlong;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vAlong = uv.y;
          vec4 wp = modelMatrix * vec4( position, 1.0 );
          vN = normalize( mat3( modelMatrix ) * normal );
          vV = normalize( cameraPosition - wp.xyz );
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uOn;
        varying float vAlong;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float edge = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 1.5 );
          float a = pow( vAlong, 4.0 ) * edge * uOn * 0.05;
          gl_FragColor = vec4( vec3( 1.0, 0.95, 0.82 ) * a, 1.0 );
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  // 锥：顶点在灯上，往 +X 伸 160m、口径 5.5m（uv.y = 1 在顶点那头）
  const cone = keep(new THREE.ConeGeometry(5.5, 160, 20, 1, true));
  cone.rotateZ(Math.PI / 2);
  cone.translate(80, 0, 0);
  const beam = new THREE.Group();
  beam.position.set(b.x, SEA_Y + 1.6 + 12.95, b.y);
  for (const ry of [0, Math.PI]) {
    const m = new THREE.Mesh(cone, beamMat);
    m.rotation.y = ry;
    m.frustumCulled = false;
    m.renderOrder = 3;
    beam.add(m);
  }
  beam.visible = false;
  group.add(beam);
  const lamp = beam.position.clone();
  // 光束转到正对着她（原点）那一下最亮：两道光束，任一道对上都算
  const toChar = Math.atan2(-lamp.z, -lamp.x);
  let angle = 0;
  return {
    group,
    /** 灯室的位置（世界坐标） */
    lamp,
    /** 塔的变换（Blender 的灯塔摆到这里）、防波堤两头 */
    tower,
    ends: [a.clone(), b.clone()] as const,
    /** 换上 Blender 的模型以后，把这里程序拼的塔和堤藏起来（光束留着） */
    hideProcedural() {
      tower.visible = false;
      wall.visible = false;
    },
    /** 光束对着这边有多正（0..1） */
    facing() {
      // 光束在 +X 上，绕 Y 转 angle 以后朝向的方位角（atan2(z, x)）是 -angle
      const d = Math.cos(-angle - toChar);
      return 0.25 + 0.75 * Math.pow(Math.abs(d), 24);
    },
    update(time: number, on: number) {
      angle = -(time / 10) * Math.PI * 2;
      beam.rotation.y = angle;
      beam.visible = on > 0.01;
      beamMat.uniforms.uOn.value = smoothstep(0.2, 0.6, on) * lights.value;
    },
  };
}

// ---- 渔船、海鸥（Blender 做的模型，生成脚本见 scripts/blender/）----
const MODELS = `${import.meta.env.BASE_URL}scene/models/`;

/** 载入一个 GLB，几何体、材质、贴图登记到场景的释放列表里；场景已经换走了就返回 null */
function loadModel(keep: Keep, file: string, alive: () => boolean) {
  return new GLTFLoader().loadAsync(`${MODELS}${file}`).then(
    (gltf) => {
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        keep(mesh.geometry);
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          keep(m);
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) keep(v);
        }
      });
      return alive() ? gltf : null;
    },
    () => null,
  );
}

/**
 * 几条小渔船（scripts/blender/fishing_boat.py 生成的 9m 玻璃钢渔船：白船身、蓝腰线、驾驶舱、桅杆、轮胎防撞垫）。
 * 在海湾里慢慢绕大圈、随浪轻轻起伏和摇晃。模型的水线在 y = 0，船头朝 +X。
 * 每条船两个材质（油漆、玻璃），一条两次绘制。layer = 加进哪一层（海面的反射）
 */
/** 船上标着的一盏灯（航行灯）：pos 是船的局部坐标，props 是模型里写的光晕大小、颜色 */
export interface BoatLight {
  boat: THREE.Object3D;
  pos: THREE.Vector3;
  props: Record<string, unknown>;
}

export function createBoats(keep: Keep, alive: () => boolean, layer: number | undefined, opts: { lights: { value: number }; onLight: (l: BoatLight) => void }) {
  const group = new THREE.Group();
  group.name = 'boats';
  // [绕圈的圆心 x, z, 半径, 速度（米/秒，负 = 反方向）, 起始角]
  const paths: Array<[number, number, number, number, number]> = [
    [70, -190, 70, 1.4, 0.3],
    [-60, -330, 90, -1.1, 2.2],
    [180, -420, 110, 1.2, 4.1],
    [20, -620, 120, -0.9, 1.0],
  ];
  const boats: Array<{ m: THREE.Object3D; x: number; z: number; rad: number; speed: number; a: number }> = [];
  void loadModel(keep, 'fishing_boat/fishing_boat.glb', alive).then((gltf) => {
    if (!gltf) return;
    // 航行灯的材质换成按天黑程度发光的（四条船共用一个）
    let glow: THREE.MeshStandardMaterial | null = null;
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!/glow/.test(mat.name)) return;
      if (!glow) {
        glow = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }));
        glow.onBeforeCompile = (shader) => {
          shader.uniforms.uLights = opts.lights;
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uLights;')
            .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * smoothstep( 0.15, 0.3, uLights ) * 2.5;');
        };
        glow.customProgramCacheKey = () => 'boat-nav-glow';
      }
      mesh.material = glow;
    });
    // 模型里标的灯（空物体 light…）
    const marks: Array<{ pos: THREE.Vector3; props: Record<string, unknown> }> = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (o.name.startsWith('light') && !(o as THREE.Mesh).isMesh) marks.push({ pos: new THREE.Vector3().setFromMatrixPosition(o.matrixWorld), props: o.userData });
    });
    for (const [x, z, rad, speed, a0] of paths) {
      const m = gltf.scene.clone(true);
      if (layer != null) m.traverse((c) => c.layers.enable(layer));
      group.add(m);
      boats.push({ m, x, z, rad, speed, a: a0 });
      for (const mk of marks) opts.onLight({ boat: m, pos: mk.pos.clone(), props: mk.props });
    }
  });
  let last = -1;
  return {
    group,
    /** night = 天黑了多少：夜里船开得慢一些（一半的速度，慢慢地开着灯绕） */
    update(t: number, night = 0) {
      const dt = last < 0 ? 0 : Math.min(0.2, Math.max(0, t - last));
      last = t;
      const k0 = 1 - 0.5 * night;
      for (const [k, b] of boats.entries()) {
        b.a += (dt * b.speed * k0) / b.rad;
        const a = b.a;
        b.m.position.set(b.x + Math.cos(a) * b.rad, SEA_Y + 0.08 * Math.sin(t * 1.3 + k), b.z + Math.sin(a) * b.rad);
        // 船头朝着前进方向（圆的切线）；船头随浪一抬一落、左右轻轻摇
        const dx = -Math.sin(a) * Math.sign(b.speed);
        const dz = Math.cos(a) * Math.sign(b.speed);
        b.m.rotation.set(0.035 * Math.sin(t * 0.9 + k), Math.atan2(-dz, dx), 0.025 * Math.sin(t * 1.1 + k * 2), 'YXZ');
      }
    },
  };
}

/**
 * 海鸥（scripts/blender/seagull.py 生成：带骨架，两段循环动作 flap 扇翅 / glide 滑翔）。
 * 几只在栏杆外面的海上绕圈：扇一阵、滑翔一阵（两段动作交叉淡入淡出），转弯时往圈里侧身，
 * 扇翅时微微往上爬、滑翔时往下滑。每只一个骨骼动画网格（SkeletonUtils.clone），各自一个 AnimationMixer。
 * 模型头朝 +X、左翅膀朝 -Z、背朝 +Y
 */
export function createGulls(keep: Keep, alive: () => boolean, layer?: number) {
  const group = new THREE.Group();
  group.name = 'gulls';
  // [圆心 x, y, z, 半径, 角速度, 相位]。前两只离岸近（50~60m），整圈都在默认机位的画面里、看得清扇翅；
  // 圈的最内侧离护岸也有几米，低空飞不会穿过栏杆边的路灯和树
  const paths: Array<[number, number, number, number, number, number]> = [
    [10, 5.5, -46, 6, 0.38, 0.8],
    [14, 7.5, -60, 9, -0.26, 2.9],
    [24, 10, -52, 9, 0.32, 0],
    [30, 13, -60, 12, -0.25, 1.7],
    [14, 16, -85, 14, 0.2, 3.1],
    [46, 9, -40, 8, -0.36, 4.4],
    [-8, 19, -110, 16, 0.18, 2.4],
    [60, 21, -95, 15, 0.22, 5.2],
  ];
  interface Gull {
    o: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    flap: THREE.AnimationAction;
    glide: THREE.AnimationAction;
    w: number;
    p: (typeof paths)[number];
  }
  const gulls: Gull[] = [];
  void loadModel(keep, 'seagull/seagull.glb', alive).then((gltf) => {
    if (!gltf) return;
    const flapClip = THREE.AnimationClip.findByName(gltf.animations, 'flap');
    const glideClip = THREE.AnimationClip.findByName(gltf.animations, 'glide');
    if (!flapClip || !glideClip) return;
    paths.forEach((p, k) => {
      const o = cloneSkinned(gltf.scene);
      o.rotation.order = 'YXZ';
      o.traverse((c) => {
        if (layer != null) c.layers.enable(layer);
        // 每只的骨架各有一张骨骼矩阵的贴图（画过一次才建），场景换走时要一起释放
        if ((c as THREE.SkinnedMesh).isSkinnedMesh) keep((c as THREE.SkinnedMesh).skeleton);
      });
      group.add(o);
      const mixer = new THREE.AnimationMixer(o);
      const flap = mixer.clipAction(flapClip);
      const glide = mixer.clipAction(glideClip);
      // 每只扇翅的快慢、起始的相位都不一样
      flap.timeScale = 0.9 + 0.25 * ((k * 0.37) % 1);
      flap.time = (k * 0.13) % flapClip.duration;
      glide.time = (k * 0.7) % glideClip.duration;
      flap.play();
      glide.play();
      gulls.push({ o, mixer, flap, glide, w: 0, p });
    });
  });
  const pos = new THREE.Vector3();
  let last = 0;
  return {
    group,
    update(t: number) {
      const dt = Math.min(0.1, Math.max(0, t - last));
      last = t;
      for (const g of gulls) {
        const [x, y, z, rad, w, ph] = g.p;
        const a = ph + t * w;
        // 扇一阵（约 4~6s）、滑翔一阵；两段动作的权重慢慢过渡
        const flapping = Math.sin(t * 0.5 + ph * 3) > 0.1;
        g.w += ((flapping ? 1 : 0) - g.w) * Math.min(1, dt * 2.5);
        g.flap.setEffectiveWeight(g.w);
        g.glide.setEffectiveWeight(1 - g.w);
        g.mixer.update(dt);
        // 扇翅时往上爬、滑翔时往下滑（一个慢的起伏，跟着扇 / 滑的节奏：高度 ∝ -cos，爬升速度 ∝ sin）
        const climb = -Math.cos(t * 0.5 + ph * 3) * 1.4;
        pos.set(x + Math.cos(a) * rad, y + climb, z + Math.sin(a) * rad);
        g.o.position.copy(pos);
        // 头朝前进方向；往圈里侧身（转弯时里侧的翅膀低）；爬升时抬头、下滑时低头
        const fx = -Math.sin(a) * Math.sign(w);
        const fz = Math.cos(a) * Math.sign(w);
        const yaw = Math.atan2(-fz, fx);
        const inside = (x - pos.x) * fz + (z - pos.z) * -fx > 0;
        const bank = THREE.MathUtils.degToRad(14 + 6 * (1 - g.w));
        g.o.rotation.set(inside ? -bank : bank, yaw, Math.sin(t * 0.5 + ph * 3) * 0.12);
      }
    },
  };
}
