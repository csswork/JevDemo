import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { canvasTexture, rng } from './common';

/**
 * 街景（street.ts）的远景：天空、积云、对岸的山和小镇、防波堤上的灯塔、远处的跨海桥（海面本身见 water.ts），
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
export function createSky(keep: Keep, sunDir: THREE.Vector3, radius: number) {
  const ZENITH = new THREE.Color(0x2265c8);
  const MID = new THREE.Color(0x4f98e6);
  const HORIZON = new THREE.Color(HAZE);
  const GLOW = new THREE.Color(0xfff8e6);
  const g = keep(new THREE.SphereGeometry(radius, 64, 32));
  const p = g.attributes.position;
  const col: number[] = [];
  const c = new THREE.Color();
  const dir = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    dir.fromBufferAttribute(p, i).normalize();
    const e = Math.max(0, dir.y);
    // 地平线那一圈很窄就过渡到天蓝（插画里的天是饱和的深蓝，只有贴着地平线才发白）
    c.copy(HORIZON).lerp(MID, smoothstep(0, 0.2, e)).lerp(ZENITH, smoothstep(0.18, 0.85, e));
    c.lerp(GLOW, 0.55 * Math.max(0, dir.dot(sunDir)) ** 12);
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const sky = new THREE.Mesh(g, keep(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  sky.renderOrder = -2;
  sky.name = 'sky';
  return sky;
}

// ---- 积云 ----
/**
 * 一朵动漫风格的积云（canvas）：先把所有云团画成背光的灰蓝剪影，再在每一团的左上方叠一个小一圈的白圆（只画在剪影里），
 * 就是插画里那种"上面亮白、下面一层层灰蓝阴影"的体积感；底部压平、再暗一点
 */
function cumulusTexture(seed: number, tall: number) {
  const r = rng(seed);
  const W = 1024;
  const H = 512;
  return canvasTexture(W, H, (g) => {
    const puffs: Array<[number, number, number]> = [];
    const base = H * 0.86;
    // 底下一排扁的，中间往上堆几座"塔"
    for (let k = 0; k < 22; k++) {
      const t = k / 21;
      const x = 90 + t * (W - 180) + (r() - 0.5) * 30;
      const rad = 38 + r() * 34;
      puffs.push([x, base - rad * 0.5, rad]);
    }
    const towers = 2 + Math.floor(r() * 2);
    for (let k = 0; k < towers; k++) {
      const cx = 220 + r() * (W - 440);
      const top = base - (160 + r() * 200) * tall;
      const n = 9 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const y = base - 40 + (top - base + 40) * t;
        const spread = (1 - t * 0.55) * (90 + r() * 40);
        const rad = (70 - t * 26) * (0.8 + r() * 0.4) * (0.75 + 0.35 * tall);
        puffs.push([cx + (r() - 0.5) * spread * 1.4, y, rad]);
        if (r() < 0.7) puffs.push([cx + (r() - 0.5) * spread * 1.8, y + rad * 0.3, rad * 0.7]);
      }
    }
    // 1. 剪影（背光面的颜色）
    g.fillStyle = '#b7c7e2';
    for (const [x, y, rad] of puffs) {
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    // 2. 亮面：每团左上方一个小一圈的白圆，只画在剪影里
    g.globalCompositeOperation = 'source-atop';
    for (const [x, y, rad] of puffs) {
      const grd = g.createRadialGradient(x - rad * 0.3, y - rad * 0.35, rad * 0.2, x - rad * 0.12, y - rad * 0.18, rad * 0.92);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.75, 'rgba(250,252,255,0.95)');
      grd.addColorStop(1, 'rgba(236,242,252,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x - rad * 0.12, y - rad * 0.18, rad * 0.92, 0, Math.PI * 2);
      g.fill();
    }
    // 3. 底部一层更暗的灰蓝（云底平、背光）
    const shade = g.createLinearGradient(0, base - 70, 0, base + 20);
    shade.addColorStop(0, 'rgba(150,168,204,0)');
    shade.addColorStop(1, 'rgba(150,168,204,0.85)');
    g.fillStyle = shade;
    g.fillRect(0, base - 70, W, 90);
    // 4. 底边压平：再往下的切掉
    g.globalCompositeOperation = 'destination-out';
    const cut = g.createLinearGradient(0, base - 6, 0, base + 18);
    cut.addColorStop(0, 'rgba(0,0,0,0)');
    cut.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = cut;
    g.fillRect(0, base - 6, W, H - base + 6);
    // 两头淡出，拼在一起不露边
    for (const side of [0, 1]) {
      const fx = g.createLinearGradient(side ? W : 0, 0, side ? W - 90 : 90, 0);
      fx.addColorStop(0, 'rgba(0,0,0,1)');
      fx.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = fx;
      g.fillRect(side ? W - 90 : 0, 0, 90, H);
    }
  });
}

/** 高空的一缕缕卷云（很淡，横着拉长） */
function cirrusTexture(seed: number) {
  const r = rng(seed);
  return canvasTexture(512, 128, (g) => {
    for (let k = 0; k < 30; k++) {
      const x = 40 + r() * 432;
      const y = 30 + r() * 68;
      const w = 60 + r() * 160;
      const grd = g.createRadialGradient(x, y, 0, x, y, w / 2);
      grd.addColorStop(0, `rgba(255,255,255,${0.25 + r() * 0.25})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.save();
      g.translate(x, y);
      g.scale(1, 0.12 + r() * 0.1);
      g.translate(-x, -y);
      g.beginPath();
      g.arc(x, y, w / 2, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
}

/**
 * 云：一圈积云（海那一侧多、大），高处几缕卷云。都是正对角色的面片，在天空球里面。
 * seaFrom / seaTo = 海那一侧的方位角范围（弧度，atan2(z, x)），积云主要堆在这里（山的后面）
 */
export function createClouds(keep: Keep, dist: number, seaFrom: number, seaTo: number) {
  const group = new THREE.Group();
  group.name = 'clouds';
  const rc = rng(91);
  const cumulus = [cumulusTexture(5, 1), cumulusTexture(8, 0.7), cumulusTexture(13, 1.25), cumulusTexture(21, 0.5)].map(keep);
  const geo = keep(new THREE.PlaneGeometry(1, 0.5));
  const place = (a: number, elev: number, w: number, mat: THREE.Material, d = dist) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * Math.cos(elev) * d, Math.sin(elev) * d, Math.sin(a) * Math.cos(elev) * d);
    m.scale.set(w * (rc() < 0.5 ? -1 : 1), w, 1);
    m.lookAt(0, m.position.y, 0);
    m.renderOrder = -1;
    group.add(m);
  };
  const mat = (tex: THREE.Texture, opacity: number) =>
    keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity }));
  // 海那一侧：一排大积云，底边贴着山顶往上一点
  const span = seaTo - seaFrom;
  for (let k = 0; k < 18; k++) {
    const a = seaFrom + ((k + 0.5) / 18) * span + (rc() - 0.5) * 0.1;
    place(a, THREE.MathUtils.degToRad(3 + rc() * 4), dist * (0.36 + rc() * 0.3), mat(cumulus[k % cumulus.length], 0.94 + rc() * 0.06));
  }
  // 陆地那一侧（她身后的山上方）少一些、小一些
  for (let k = 0; k < 7; k++) {
    const a = seaTo + ((k + 0.5) / 7) * (Math.PI * 2 - span) + (rc() - 0.5) * 0.2;
    place(a, THREE.MathUtils.degToRad(4 + rc() * 4), dist * (0.22 + rc() * 0.16), mat(cumulus[(k + 2) % cumulus.length], 0.85));
  }
  // 卷云：高一些、淡
  const cirrus = [cirrusTexture(3), cirrusTexture(4)].map(keep);
  for (let k = 0; k < 10; k++) {
    const a = rc() * Math.PI * 2;
    place(a, THREE.MathUtils.degToRad(14 + rc() * 22), dist * (0.35 + rc() * 0.3), mat(cirrus[k % 2], 0.5 + rc() * 0.3), dist * 0.95);
  }
  return group;
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
export function createFarTown(keep: Keep, from: number, to: number, count = 900) {
  const r = rng(404);
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
  const im = keep(new THREE.InstancedMesh(geo, mat, count));
  const palette = [0xffffff, 0xfbf6ec, 0xf1f3f5, 0xfdf8f0, 0xeaf0f5, 0xf5ebdd, 0xffffff, 0xe6eaee, 0xf3e4d4];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  let n = 0;
  for (let k = 0; k < count * 3 && n < count; k++) {
    const a = from + r() * (to - from);
    // 大部分在岸边 8~60m，少数往山脚爬一点
    const u = r() < 0.85 ? 8 + r() * 52 : 50 + r() * 60;
    const rr = farShore(a) + u;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    // 低矮的：远看是一条白线，不是一排方块（第一版高的有 40m，长焦一放大像一片高楼）
    const tall = r() < 0.05;
    const w = 7 + r() * 9;
    const h = tall ? 12 + r() * 8 : 4 + r() * 5;
    const d = 7 + r() * 8;
    // 地面高度和 createFarLand 的近岸部分一致（-4 + 6.5 · smoothstep(0,14,u)，往里一点点起坡）
    const y = -4 + 6.5 * smoothstep(0, 14, u) + 0.08 * Math.max(0, u - 45);
    q.setFromAxisAngle(up, -a + (r() - 0.5) * 0.4);
    m.compose(new THREE.Vector3(x, y - 0.5, z), q, new THREE.Vector3(w, h, d));
    im.setMatrixAt(n, m);
    im.setColorAt(n, c.setHex(palette[Math.floor(r() * palette.length)]));
    n++;
  }
  im.count = n;
  im.computeBoundingSphere();
  im.name = 'far-town';
  return im;
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
export function createLighthouse(keep: Keep, from: [number, number], to: [number, number]) {
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
  group.add(tower);
  return group;
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
export function createBoats(keep: Keep, alive: () => boolean, layer?: number) {
  const group = new THREE.Group();
  group.name = 'boats';
  // [绕圈的圆心 x, z, 半径, 速度（米/秒，负 = 反方向）, 起始角]
  const paths: Array<[number, number, number, number, number]> = [
    [70, -190, 70, 1.4, 0.3],
    [-60, -330, 90, -1.1, 2.2],
    [180, -420, 110, 1.2, 4.1],
    [20, -620, 120, -0.9, 1.0],
  ];
  const boats: Array<{ m: THREE.Object3D; x: number; z: number; rad: number; speed: number; a0: number }> = [];
  void loadModel(keep, 'fishing_boat/fishing_boat.glb', alive).then((gltf) => {
    if (!gltf) return;
    for (const [x, z, rad, speed, a0] of paths) {
      const m = gltf.scene.clone(true);
      if (layer != null) m.traverse((c) => c.layers.enable(layer));
      group.add(m);
      boats.push({ m, x, z, rad, speed, a0 });
    }
  });
  return {
    group,
    update(t: number) {
      for (const [k, b] of boats.entries()) {
        const a = b.a0 + (t * b.speed) / b.rad;
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
