import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { canvasTexture, rng, type Backdrop } from './common';
import { createBatcher, createTreeMaker, type TreeVariant } from './foliage';
import {
  HAZE,
  SEA_Y,
  createBoats,
  createBridge,
  createClouds,
  createGulls,
  createFarLand,
  createFarTown,
  createLighthouse,
  createSky,
  fbm,
} from './seaside';
import { F, bannerUV, cellUV, chalkboard, facadeAtlas, signAtlas, signUV, type Cell } from './streetTextures';
import { REFLECT_LAYER, createWater } from './water';
import { asphaltMaterial, concreteMaterial, facadeMaterial, metalMaterial, paverMaterial, roofMaterial, woodMaterial } from './streetMaterials';

/**
 * 背景场景：海边小镇的街道（照着一张二次元风格的插画搭的），全 3D：
 *
 *   街道      双车道的柏油路从她身边往远处伸，过了人行横道往左拐，顺着海岸线绕过去。
 *             左边（-X）是一排两三层的日式小楼：一楼是店面（咖啡店、陶器店、土特产店、居酒屋……）或住家，
 *             二楼是窗户和阳台，屋顶铺波形瓦，有的一楼上面还有一道小瓦檐（庇）。
 *             右边（+X）是窄一点的人行道、花岗岩矮墙和黑色铁栏杆，栏杆外面就是海
 *   房子      全部程序生成：开间 × 楼层一格一格拼立面（streetTextures.ts 的立面图集，canvas 画的），
 *             屋顶是带厚度的瓦面（硬山 / 悬山、山墙朝街的、四坡顶、平顶），所有房子按材质合成几个网格，各画一次
 *   店门口    咖啡店的深蓝遮阳篷、立式小黑板、长凳、花箱和盆栽，挂在墙上的竖旗（海のカフェ、やきもの……
 *             旗子面朝街的方向，从她身后往远处看正好是正面），路边插的布旗，自动售货机
 *   电线杆    水泥电线杆、横担、变压器，杆子之间垂着电线（插画里头顶那几根线）
 *   路灯      右边人行道上的欧式路灯（Poly Haven street_lamp_01，公园那盏），灯杆上挂"海の見える街"的旗
 *   树        右边人行道的行道树、房子之间的庭院树、栏杆边一溜灌木（ez-tree，和公园同一套合批、透光、随风）
 *   远景      海、对岸的小镇和两层山、灯塔和防波堤、跨海桥、积云（seaside.ts）；身后的小镇往山坡上爬
 *
 * 坐标和舞台一致：角色站在原点、面朝 +Z，主相机在 +Z 方向往 -Z 看，半身景别里看到的是她身后：
 * 她站在路上靠左那条车道（离左边路牙 1.4m），身后左边是咖啡店往后的一排店面，右边是栏杆和海，
 * 正后方是路的尽头 —— 路在那里往左拐，头后面是海、对岸和山，没有竖着的东西（视线走廊，和公园一样）。
 *
 * 灯光：舞台的主光当太阳用（右侧偏前、离地约 46°），左边一排店面朝着太阳、是亮的，遮阳篷和瓦檐在墙上投影；
 * 行道树在路面上投斑驳的影子。天光偏蓝、地面反光偏暖灰，环境光（IBL）还用公园那张名古屋的 HDR。
 */

const BASE = `${import.meta.env.BASE_URL}scene/`;

type V2 = [number, number];
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- 布局 ----

/**
 * 路的中线：从身后（+Z）那头往前，过了她以后往左拐，顺着海岸线伸到远处。两头都伸得很远（雾里看不到尽头）。
 * 路的左边是陆地（店面、身后的小镇和山），右边是护岸和海
 */
const ROAD: V2[] = [
  [-520, 920],
  [-210, 530],
  [-62, 322],
  [-12, 200],
  [0.6, 118],
  [1.6, 60],
  [1.6, 0],
  [1.6, -14],
  [1.0, -26],
  [-1.0, -38],
  [-4.9, -50],
  [-10.9, -60],
  [-18.9, -68],
  [-29.4, -75],
  [-43.4, -80],
  [-70, -86],
  [-130, -92],
  [-300, -108],
  [-920, -165],
];
/** 横断面（离中线的距离，正 = 左边 / 陆地那侧） */
const ROAD_HALF = 3;
const CURB = 0.18;
const KERB_H = 0.15;
/** 左边人行道外沿 = 店面的门脸线 */
const FRONT = 5.6;
/** 右边人行道外沿 = 矮墙内侧；矮墙外侧 = 护岸 */
const WALL_IN = -5.0;
const WALL_OUT = -5.45;
/** 矮墙只比人行道高 40cm：再高就把近处的海全挡住了（相机只有 1.4m 高，海面在路面下 1.2m） */
const WALL_TOP = 0.55;
/** 主相机 z（算"头后面的视线走廊"） */
const CAM_Z = 1.58;
/**
 * 太阳（舞台的主光）：右侧偏前、离地约 46°。左边的店面朝着它（门脸是亮的），
 * 影子往左后方落：遮阳篷、瓦檐的影子落在墙上，行道树的影子落在路上
 */
const SUN_POS: [number, number, number] = [2.0, 2.3, 0.9];
const SUN_DIR = new THREE.Vector3(...SUN_POS).normalize();
const SKY_R = 3000;
/** 叶子的颜色：插画里是阳光下发亮的黄绿 */
const LEAF_TINT = new THREE.Color(1.3, 1.38, 0.92);

/** 墙的颜色（乘在立面贴图上）：米白、暖白、浅灰、淡蓝灰、浅米黄 */
const WALL_TINTS = [0xfff6e6, 0xffffff, 0xeeeeec, 0xe4ecf2, 0xf6e8d2, 0xfbf1e4, 0xf0ece6];
/** 屋瓦的颜色：蓝灰（最多）、深灰、黑、偏棕 */
const ROOF_TINTS = [0x8ea0bc, 0x8ea0bc, 0x7d8aa0, 0x5f6672, 0x9a7f70, 0x6f7f9c];

interface Sample {
  p: THREE.Vector3;
  /** 前进方向（从 +Z 那头往远处） */
  t: THREE.Vector3;
  /** 左边（陆地那侧）的单位法线 */
  l: THREE.Vector3;
}

type RoofType = 'hira' | 'tsuma' | 'yose' | 'flat';
interface BuildingSpec {
  /** 门脸中点在路上的位置（弧长，米） */
  s: number;
  w: number;
  depth: number;
  /** 门脸往里缩多少（默认 0） */
  setback?: number;
  /** 每层每个开间用哪一格：ground 一楼，upper[k] 第 k+2 层（不够长就循环） */
  ground: Cell[];
  upper: Cell[][];
  tint: number;
  roof: RoofType;
  roofTint: number;
  pitch?: number;
  hisashi?: boolean;
  /** 二楼阳台：开间范围 [from, to) */
  balcony?: [number, number];
  /** 布遮阳篷的颜色 */
  awning?: number;
  /** 一楼上方的横招牌（signUV 的编号） */
  sign?: number;
  /** 挂在墙上的竖旗（bannerUV 的编号），挂在门脸的哪一头（0 = 近处那头，1 = 远处那头） */
  banner?: [number, number];
  /** 底座在多高（坡上的房子） */
  y?: number;
  /** 拿来防穿墙 */
  solid?: boolean;
}

/**
 * 一个网格的数据：位置、法线、uv、颜色（可选：旗子的摆动参数、按米铺的第二套 uv）。所有房子按材质各攒一个，最后各合成一个几何体。
 * poly 的点按"从正面看逆时针"给，法线由前三个点算。
 * uv1：墙面的灰泥贴图用（立面图集用 uv）。按变换前的局部坐标算：u = 沿着这个面的水平方向（米），v = 高度（米），
 * 同一面墙上一格挨一格的接得上
 */
class Mesher {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  uv1: number[] | null;
  col: number[] = [];
  idx: number[] = [];
  sway: number[] | null;
  private m = new THREE.Matrix4();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly t = new THREE.Vector3();
  private readonly w = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  constructor({ sway = false, uv1 = false }: { sway?: boolean; uv1?: boolean } = {}) {
    this.sway = sway ? [] : null;
    this.uv1 = uv1 ? [] : null;
  }
  setTransform(m: THREE.Matrix4) {
    this.m.copy(m);
    return this;
  }
  identity() {
    this.m.identity();
    return this;
  }
  poly(pts: THREE.Vector3[], uvs: Array<[number, number]>, c: THREE.Color, sway?: { dir: THREE.Vector3; w: number[] }) {
    const base = this.pos.length / 3;
    const w = pts.map((p, i) => this.w[i].copy(p).applyMatrix4(this.m));
    const n = this.a.subVectors(w[1], w[0]).cross(this.b.subVectors(w[2], w[0]));
    if (n.lengthSq() < 1e-12 && w.length > 3) n.subVectors(w[2], w[0]).cross(this.b.subVectors(w[3], w[0]));
    n.normalize();
    if (this.uv1) {
      // 沿这个面的水平方向：第一条边投到水平面上（三角形山墙的第一条边也是水平的）
      const t = this.t.subVectors(pts[1], pts[0]).setY(0);
      if (t.lengthSq() < 1e-8) t.set(1, 0, 0);
      t.normalize();
      for (const p of pts) this.uv1.push(p.x * t.x + p.z * t.z, p.y);
    }
    w.forEach((p, i) => {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(uvs[i][0], uvs[i][1]);
      this.col.push(c.r, c.g, c.b);
      // 旗子：xyz = 往哪边摆（旗面的法线，正反两面一样），w = 离挂点多远（0 不动，1 摆得最大）
      if (this.sway) this.sway.push(sway?.dir.x ?? 0, sway?.dir.y ?? 0, sway?.dir.z ?? 0, sway?.w[i] ?? 0);
    });
    for (let i = 1; i < pts.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }
  /** p0 左下、p1 右下、p2 右上、p3 左上（从正面看），uv = [u0, v0, u1, v1] */
  quad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, uv: readonly number[], c: THREE.Color) {
    this.poly(
      [p0, p1, p2, p3],
      [
        [uv[0], uv[1]],
        [uv[2], uv[1]],
        [uv[2], uv[3]],
        [uv[0], uv[3]],
      ],
      c,
    );
  }
  /** 轴对齐的盒子（当前变换下），uvScale > 0 时按米铺 uv */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, uvScale = 0) {
    const faces: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
      [v3(x0, y0, z1), v3(x1, y0, z1), v3(x1, y1, z1), v3(x0, y1, z1)],
      [v3(x1, y0, z0), v3(x0, y0, z0), v3(x0, y1, z0), v3(x1, y1, z0)],
      [v3(x1, y0, z1), v3(x1, y0, z0), v3(x1, y1, z0), v3(x1, y1, z1)],
      [v3(x0, y0, z0), v3(x0, y0, z1), v3(x0, y1, z1), v3(x0, y1, z0)],
      [v3(x0, y1, z1), v3(x1, y1, z1), v3(x1, y1, z0), v3(x0, y1, z0)],
      [v3(x0, y0, z0), v3(x1, y0, z0), v3(x1, y0, z1), v3(x0, y0, z1)],
    ];
    for (const [p0, p1, p2, p3] of faces) {
      const k = uvScale > 0 ? 1 / uvScale : 0;
      this.quad(p0, p1, p2, p3, [0, 0, p0.distanceTo(p1) * k, p1.distanceTo(p2) * k], c);
    }
  }
  get empty() {
    return this.idx.length === 0;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.uv1) g.setAttribute('uv1', new THREE.Float32BufferAttribute(this.uv1, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.sway) g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
const col = (hex: number) => new THREE.Color(hex);

export function createStreet(): Backdrop {
  const group = new THREE.Group();
  group.name = 'street';
  const disposables: Array<{ dispose(): void }> = [];
  let disposed = false;
  const keep = <T extends { dispose(): void }>(x: T) => {
    if (disposed) x.dispose();
    else disposables.push(x);
    return x;
  };
  const r = rng(717);
  const colliders: THREE.Object3D[] = [];
  const collider = (geo: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const mesh = new THREE.Mesh(keep(geo));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(m);
    mesh.matrixWorld.copy(m);
    colliders.push(mesh);
  };

  // ---- 路：按弧长每 0.5m 采一个点 ----
  const curve = new THREE.CatmullRomCurve3(
    ROAD.map(([x, z]) => v3(x, 0, z)),
    false,
    'centripetal',
  );
  curve.arcLengthDivisions = 6000;
  const LEN = curve.getLength();
  const STEP = 0.5;
  const samples: Sample[] = [];
  for (let i = 0, n = Math.ceil(LEN / STEP); i <= n; i++) {
    const u = Math.min(1, (i * STEP) / LEN);
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).setY(0).normalize();
    samples.push({ p, t, l: v3(t.z, 0, -t.x) });
  }
  /** 弧长 s 处（线性插值） */
  const at = (s: number): Sample => {
    const f = THREE.MathUtils.clamp(s / STEP, 0, samples.length - 1.001);
    const i = Math.floor(f);
    const k = f - i;
    const a = samples[i];
    const b = samples[i + 1];
    const t = a.t.clone().lerp(b.t, k).normalize();
    return { p: a.p.clone().lerp(b.p, k), t, l: v3(t.z, 0, -t.x) };
  };
  /** 路上 s 处、离中线 d（左正）、高 y 的点 */
  const pt = (s: number, d: number, y = 0) => {
    const a = at(s);
    return a.p.clone().addScaledVector(a.l, d).setY(y);
  };
  /**
   * 最近的中线点：返回弧长和离中线的距离（左正）。先隔 16 个点粗找，再在附近细找。
   * 陆地的高度场有四万多个顶点，每个都要找一次：坐标放进定长数组里找（对象数组慢十几倍）
   */
  const SX = Float64Array.from(samples, (q) => q.p.x);
  const SZ = Float64Array.from(samples, (q) => q.p.z);
  const proj = { s: 0, d: 0 };
  const project = (x: number, z: number) => {
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < SX.length; i += 16) {
      const d = (SX[i] - x) * (SX[i] - x) + (SZ[i] - z) * (SZ[i] - z);
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const from = Math.max(0, bi - 16);
    const to = Math.min(SX.length, bi + 17);
    for (let i = from; i < to; i++) {
      const d = (SX[i] - x) * (SX[i] - x) + (SZ[i] - z) * (SZ[i] - z);
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const l = samples[bi].l;
    proj.s = bi * STEP;
    proj.d = (x - SX[bi]) * l.x + (z - SZ[bi]) * l.z;
    return proj;
  };
  /** 角色脚下（原点）在路上的弧长 */
  const S0 = project(0, 0).s;
  /** 头后面的视线走廊：竖着的东西（灯杆、电线杆、树干、旗杆）不进去 */
  const inHeadCorridor = (p: THREE.Vector3) => p.z < 0.5 && Math.abs(p.x) < 0.15 * ((CAM_Z - p.z) / CAM_Z) + 0.6;

  /** 陆地的高度：护岸外面是海底；路和店面那一条是平的；往里（离路 40m 以后）起坡，就是小镇后面的山 */
  const landY = (x: number, z: number, d = project(x, z).d) => {
    const dl = d - WALL_OUT; // 离护岸外侧多远（陆地那侧为正）
    if (dl <= 0) return -9;
    if (dl < 12) return THREE.MathUtils.lerp(-9, -0.05, dl / 12);
    const hill = smoothstep(40, 420, dl) * (60 + 110 * fbm(x * 0.004 + 3, z * 0.004 - 7, 4));
    const bumps = smoothstep(30, 120, dl) * 5 * (fbm(x * 0.03, z * 0.03, 3) - 0.35);
    return -0.05 + hill + bumps;
  };

  // ---- 材质（PBR 贴图和着色器里的"旧"，见 streetMaterials.ts）----
  const atlas = facadeAtlas();
  keep(atlas.map);
  keep(atlas.emissive);
  keep(atlas.mask);
  const facadeMat = facadeMaterial(keep, atlas);
  const roofMat = roofMaterial(keep);
  const woodMat = woodMaterial(keep);
  const metalMat = metalMaterial(keep);
  /** 刷了漆的小部件（不贴图，靠顶点色）：屋脊、平顶的女儿墙、水箱、售货机的侧面、旗杆…… */
  const trimMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  const fabricMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
  const signTex = keep(signAtlas());
  const wind = { uTime: { value: 0 } };
  const signMat = keep(new THREE.MeshStandardMaterial({ map: signTex, vertexColors: true, roughness: 0.9, alphaTest: 0.5 }));
  // 布旗随风轻轻摆：离挂点越远摆得越大，沿旗面法线方向（aSway）
  signMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec4 aSway;\nuniform float uTime;\nvoid main() {')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float swayPh = uTime * 2.1 + position.x * 0.7 + position.z * 0.5 + uv.y * 3.0;
        transformed += aSway.xyz * aSway.w * ( sin( swayPh ) * 0.07 + sin( swayPh * 2.3 + 1.0 ) * 0.025 );`,
      );
  };
  signMat.customProgramCacheKey = () => 'street-sign-sway';

  const facade = new Mesher({ uv1: true });
  const roof = new Mesher();
  const trim = new Mesher();
  const wood = new Mesher();
  const metal = new Mesher();
  const fabric = new Mesher();
  const signs = new Mesher({ sway: true });
  /** 木件的颜色（乘在木纹贴图上）：深棕的梁和檐口板、浅一点的檐底板 */
  const WOOD = col(0xb08a6e);
  const SOFFIT = col(0xd2b89e);
  const IRON = col(0x3a3d42);

  // ---- 天空、云、远景（都要倒映在海里：加进反射那一层，见 water.ts）----
  /** 远景：加进场景，同时加进海面反射那一层 */
  const far = <T extends THREE.Object3D>(o: T) => {
    o.traverse((c) => c.layers.enable(REFLECT_LAYER));
    group.add(o);
    return o;
  };
  far(createSky(keep, SUN_DIR, SKY_R));
  // 海那一侧的方位角：从左前方（-150°）绕到右后方（80°）
  const SEA_FROM = THREE.MathUtils.degToRad(-150);
  const SEA_TO = THREE.MathUtils.degToRad(80);
  far(createClouds(keep, SKY_R * 0.88, THREE.MathUtils.degToRad(-140), THREE.MathUtils.degToRad(40)));
  far(createFarLand(keep, SEA_FROM, SEA_TO));
  far(createFarTown(keep, THREE.MathUtils.degToRad(-128), THREE.MathUtils.degToRad(-40)));
  far(createBridge(keep, THREE.MathUtils.degToRad(-128), THREE.MathUtils.degToRad(-108), 160));
  // 灯塔在画面右边、路灯和头之间（插画里的位置）
  const BREAKWATER: [[number, number], [number, number]] = [
    [-40, -206],
    [38, -218],
  ];
  far(createLighthouse(keep, ...BREAKWATER));
  const boats = createBoats(keep);
  far(boats.group);
  const gulls = createGulls(keep);
  group.add(gulls.group);

  // ---- 陆地（身后的小镇和山）：一张 8m 一格的高度场 ----
  {
    const X0 = -1100;
    const X1 = 520;
    const Z0 = -820;
    const Z1 = 1020;
    const CS = 8;
    const nx = Math.round((X1 - X0) / CS);
    const nz = Math.round((Z1 - Z0) / CS);
    const g = keep(new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, nx, nz));
    g.rotateX(-Math.PI / 2);
    g.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
    const p = g.attributes.position;
    const colors: number[] = [];
    const c = new THREE.Color();
    const town = new THREE.Color(0xb9b2a6);
    const grass = new THREE.Color(0x5f9a4c);
    const forest = new THREE.Color(0x3d7442);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const { d } = project(x, z);
      p.setY(i, landY(x, z, d));
      const dl = d - WALL_OUT;
      c.copy(grass).lerp(forest, smoothstep(0.45, 0.62, fbm(x * 0.012, z * 0.012, 3)));
      c.lerp(town, 1 - smoothstep(30, 90, dl));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const land = new THREE.Mesh(g, keep(new THREE.MeshLambertMaterial({ vertexColors: true })));
    land.receiveShadow = true;
    land.name = 'land';
    far(land);
    // 防穿墙：脚下一块平地（镜头压到最低时不钻到地下）
    const cg = new THREE.PlaneGeometry(40, 40);
    cg.rotateX(-Math.PI / 2);
    collider(cg, new THREE.Matrix4());
  }

  // ---- 海：专门的水面着色器（波浪法线、倒映远景的平面反射、菲涅耳、离岸深浅、浪花，见 water.ts）----
  const water = createWater(keep, {
    y: SEA_Y,
    // 水面的高光按 HDRI 里那个低一点的太阳算（离地约 18°，方位和主光一样）：主光离地 46°，它在水面上的倒影
    // 落在护岸脚下、被矮墙挡住，转向太阳那一侧也看不到碎光；低的太阳在海面上拉出一条闪闪的光带
    sunDir: new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z)
      .normalize()
      .multiplyScalar(Math.cos(THREE.MathUtils.degToRad(18)))
      .setY(Math.sin(THREE.MathUtils.degToRad(18))),
    sunColor: new THREE.Color(0xfff3e0),
    // 离护岸多远：护岸外侧往海里为正（陆地上是负的，存成 0）。覆盖她附近的海湾，再远都当深水
    shore: { bounds: [-300, -500, 300, 300], resolution: 256, max: 60, dist: (x, z) => WALL_OUT - project(x, z).d },
    breakwater: BREAKWATER,
  });
  group.add(water.mesh);

  // ---- 路面、路牙、人行道、矮墙、护岸、栏杆：沿路铺的带子 ----
  /** 沿路的采样：近处 0.5m 一个，远处稀一点 */
  const stations = (from: number, to: number) => {
    const out: number[] = [];
    let s = Math.max(0, from);
    const end = Math.min(LEN, to);
    while (s < end) {
      out.push(s);
      const far = Math.abs(s - S0);
      s += far < 120 ? 0.5 : far < 450 ? 2 : 6;
    }
    out.push(end);
    return out;
  };
  /**
   * 一条带子：横断面上 (d0, y0) → (d1, y1) 这条线沿路扫过去。face = 正面朝哪（上 / 下 / 左 = 陆地那侧 / 右 = 海那侧），
   * uv：u 沿横断面（米 / uScale），v 沿路（米 / vScale）
   */
  const strip = (
    m: Mesher,
    from: number,
    to: number,
    [d0, y0]: V2,
    [d1, y1]: V2,
    face: 'up' | 'left' | 'right' | 'down',
    c: THREE.Color,
    uScale = 1,
    vScale = 1,
  ) => {
    m.identity();
    const ss = stations(from, to);
    const span = Math.hypot(d1 - d0, y1 - y0) / uScale;
    let flip: boolean | null = null;
    for (let i = 0; i < ss.length - 1; i++) {
      const a0 = pt(ss[i], d0, y0);
      const a1 = pt(ss[i], d1, y1);
      const b0 = pt(ss[i + 1], d0, y0);
      const b1 = pt(ss[i + 1], d1, y1);
      const va = ss[i] / vScale;
      const vb = ss[i + 1] / vScale;
      if (flip === null) {
        const n = new THREE.Vector3().subVectors(a1, a0).cross(new THREE.Vector3().subVectors(b0, a0));
        const want = face === 'up' ? v3(0, 1, 0) : face === 'down' ? v3(0, -1, 0) : at(ss[i]).l.clone().multiplyScalar(face === 'left' ? 1 : -1);
        flip = n.dot(want) < 0;
      }
      if (!flip)
        m.poly(
          [a0, a1, b1, b0],
          [
            [0, va],
            [span, va],
            [span, vb],
            [0, vb],
          ],
          c,
        );
      else
        m.poly(
          [a0, b0, b1, a1],
          [
            [0, va],
            [0, vb],
            [span, vb],
            [span, va],
          ],
          c,
        );
    }
  };
  const NEAR0 = S0 - 470;
  const NEAR1 = S0 + 360;
  {
    const road = new Mesher();
    const marks = new Mesher();
    const curbs = new Mesher();
    const walks = new Mesher();
    const parapet = new Mesher();
    const wallFace = new Mesher();
    const rails = new Mesher();
    const gutters = new Mesher();
    // uv 都按米（贴图的实际尺寸在材质里换算，见 streetMaterials.ts）
    // 路面一直铺到两头（雾里），路牙、人行道、矮墙在近处 800m 里
    strip(road, 0, LEN, [-ROAD_HALF, 0], [ROAD_HALF, 0], 'up', WHITE);
    // 侧沟：路牙外面一条 42cm 宽的混凝土（日本街道路边常见的 L 形侧沟），隔 15m 一个铁格栅
    const GUTTER = 0.42;
    strip(gutters, NEAR0, NEAR1, [ROAD_HALF - GUTTER, 0.004], [ROAD_HALF, 0.004], 'up', WHITE);
    strip(gutters, NEAR0, NEAR1, [-ROAD_HALF, 0.004], [-ROAD_HALF + GUTTER, 0.004], 'up', WHITE);
    {
      const gm = new THREE.Matrix4();
      const dark = col(0x2b2d30);
      for (let s = NEAR0 + 3; s < NEAR1; s += 15) {
        for (const side of [1, -1]) {
          const a = at(s);
          const p = a.p.clone().addScaledVector(a.l, side * (ROAD_HALF - GUTTER / 2));
          metal.setTransform(gm.makeRotationY(Math.atan2(a.l.x, a.l.z)).setPosition(p.x, 0.004, p.z));
          metal.box(-0.17, 0, -0.32, 0.17, 0.012, 0.32, dark);
          for (let k = -4; k <= 4; k++) metal.box(-0.16, 0.012, k * 0.07 - 0.012, 0.16, 0.018, k * 0.07 + 0.012, IRON);
        }
      }
    }
    // 白色的路边线（侧沟里面一点）；人行横道那一段断开
    const CROSS = S0 + 28;
    for (const d of [ROAD_HALF - 0.55, -(ROAD_HALF - 0.55)]) {
      strip(marks, NEAR0, CROSS - 4.2, [d - 0.075, 0.004], [d + 0.075, 0.004], 'up', WHITE);
      strip(marks, CROSS + 4.2, NEAR1, [d - 0.075, 0.004], [d + 0.075, 0.004], 'up', WHITE);
    }
    // 人行横道（斑马线）+ 两边的停止线
    for (let d = -ROAD_HALF + 0.5; d + 0.45 <= ROAD_HALF - 0.4; d += 0.9) strip(marks, CROSS - 1.6, CROSS + 1.6, [d, 0.004], [d + 0.45, 0.004], 'up', WHITE);
    strip(marks, CROSS - 3.6, CROSS - 3.3, [0.1, 0.004], [ROAD_HALF - 0.3, 0.004], 'up', WHITE);
    strip(marks, CROSS + 3.3, CROSS + 3.6, [-(ROAD_HALF - 0.3), 0.004], [-0.1, 0.004], 'up', WHITE);
    // 路牙（左右各一条，右边那条顶上刷黄线：禁止停车）
    strip(curbs, NEAR0, NEAR1, [ROAD_HALF, 0], [ROAD_HALF, KERB_H], 'right', WHITE);
    strip(curbs, NEAR0, NEAR1, [ROAD_HALF, KERB_H], [ROAD_HALF + CURB, KERB_H], 'up', WHITE);
    strip(curbs, NEAR0, NEAR1, [-ROAD_HALF, KERB_H], [-ROAD_HALF, 0], 'left', WHITE);
    strip(curbs, NEAR0, NEAR1, [-ROAD_HALF - CURB, KERB_H], [-ROAD_HALF, KERB_H], 'up', col(0xf2c94c));
    // 人行道（方石板）：左边一直铺到门脸线里面一点（房子压在上面）
    strip(walks, NEAR0, NEAR1, [ROAD_HALF + CURB, KERB_H], [FRONT + 1.2, KERB_H], 'up', WHITE);
    strip(walks, NEAR0, NEAR1, [WALL_IN, KERB_H], [-ROAD_HALF - CURB, KERB_H], 'up', WHITE);
    // 矮墙（一块块预制的混凝土块）：内侧面、顶面、外侧面；护岸从矮墙外侧一直到水下
    strip(parapet, NEAR0, NEAR1, [WALL_IN, KERB_H], [WALL_IN, WALL_TOP], 'left', WHITE);
    strip(parapet, NEAR0, NEAR1, [WALL_OUT, WALL_TOP], [WALL_IN, WALL_TOP], 'up', WHITE);
    strip(parapet, NEAR0, NEAR1, [WALL_OUT, WALL_TOP], [WALL_OUT, KERB_H], 'right', WHITE);
    strip(wallFace, NEAR0, NEAR1, [WALL_OUT, KERB_H], [WALL_OUT, SEA_Y - 0.6], 'right', WHITE);
    // 远处（近处 800m 以外）的护岸只要一道竖墙，不然路外面是悬空的
    strip(wallFace, 0, NEAR0, [WALL_OUT, 0], [WALL_OUT, SEA_Y - 0.6], 'right', WHITE);
    strip(wallFace, NEAR1, LEN, [WALL_OUT, 0], [WALL_OUT, SEA_Y - 0.6], 'right', WHITE);
    strip(walks, 0, NEAR0, [WALL_OUT, 0], [-ROAD_HALF, 0], 'up', WHITE);
    strip(walks, NEAR1, LEN, [WALL_OUT, 0], [-ROAD_HALF, 0], 'up', WHITE);
    strip(walks, 0, NEAR0, [ROAD_HALF, 0], [FRONT + 7, 0], 'up', WHITE);
    strip(walks, NEAR1, LEN, [ROAD_HALF, 0], [FRONT + 7, 0], 'up', WHITE);
    // 铁栏杆：两道横杆（细的方管）+ 每 2m 一根立柱
    const iron = col(0x2c3036);
    const RAIL_D = (WALL_IN + WALL_OUT) / 2;
    for (const [y, h] of [
      [WALL_TOP + 0.55, 0.05],
      [WALL_TOP + 0.3, 0.035],
    ] as const) {
      strip(rails, NEAR0, NEAR1, [RAIL_D - 0.025, y + h / 2], [RAIL_D + 0.025, y + h / 2], 'up', iron);
      strip(rails, NEAR0, NEAR1, [RAIL_D + 0.025, y - h / 2], [RAIL_D + 0.025, y + h / 2], 'left', iron);
      strip(rails, NEAR0, NEAR1, [RAIL_D - 0.025, y + h / 2], [RAIL_D - 0.025, y - h / 2], 'right', iron);
    }
    const m = new THREE.Matrix4();
    for (let s = NEAR0; s < NEAR1; s += 2) {
      const a = at(s);
      const p = a.p.clone().addScaledVector(a.l, RAIL_D);
      rails.setTransform(m.makeRotationY(Math.atan2(a.l.x, a.l.z)).setPosition(p.x, WALL_TOP, p.z));
      rails.box(-0.03, 0, -0.03, 0.03, 0.6, 0.03, iron);
    }
    const meshOf = (mm: Mesher, mat: THREE.Material, cast: boolean, name: string) => {
      const mesh = new THREE.Mesh(keep(mm.build()), mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.name = name;
      group.add(mesh);
      return mesh;
    };
    meshOf(road, asphaltMaterial(keep, ROAD_HALF), false, 'road');
    const gutterMat = concreteMaterial(keep, 'plain');
    Object.assign(gutterMat, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    meshOf(gutters, gutterMat, false, 'gutters');
    meshOf(
      marks,
      keep(new THREE.MeshStandardMaterial({ color: 0xf6f5f0, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
      false,
      'road-marks',
    );
    meshOf(curbs, concreteMaterial(keep, 'curb'), false, 'curbs');
    meshOf(walks, paverMaterial(keep), false, 'sidewalks');
    meshOf(parapet, concreteMaterial(keep, 'parapet'), true, 'parapet');
    meshOf(wallFace, concreteMaterial(keep, 'seawall'), false, 'seawall');
    meshOf(rails, metalMat, true, 'railing');
  }

  // ---- 房子 ----
  const tmpM = new THREE.Matrix4();
  /** 房子的局部坐标：门脸在 z = 0、朝 +z（朝着路），x 沿着路（往远处为正），y 向上 */
  const building = (b: BuildingSpec) => {
    // 门脸正对着路（沿 s 处的切线摆，宽度就是给的宽度）：弯道内侧离路远的地方，按两头的点连线会折过去
    const center = pt(b.s, FRONT + (b.setback ?? 0));
    const zAxis = at(b.s).l.clone().negate();
    const w = b.w;
    const y0 = b.y ?? -0.1;
    const M = new THREE.Matrix4().makeRotationY(Math.atan2(zAxis.x, zAxis.z)).setPosition(center.x, y0, center.z);
    for (const m of [facade, roof, trim, wood, metal, fabric, signs]) m.setTransform(M);
    const tint = col(b.tint);
    const roofC = col(b.roofTint);
    const hw = w / 2;
    const d = b.depth;
    const bays = b.ground.length;
    const bw = w / bays;
    const GH = 3.2;
    const UH = 2.9;
    const floors = 1 + b.upper.length;
    const H = GH + UH * b.upper.length;
    // 立面：一格一格（开间 × 楼层）
    for (let f = 0; f < floors; f++) {
      const ya = f === 0 ? 0 : GH + UH * (f - 1);
      const yb = f === 0 ? GH : ya + UH;
      for (let i = 0; i < bays; i++) {
        const cell = f === 0 ? b.ground[i] : b.upper[f - 1][i % b.upper[f - 1].length];
        const xa = -hw + i * bw;
        facade.quad(v3(xa, ya, 0), v3(xa + bw, ya, 0), v3(xa + bw, yb, 0), v3(xa, yb, 0), cellUV(cell), tint);
      }
    }
    // 侧墙、后墙：素墙为主，偶尔一扇小窗、一根落水管
    const sideBays = Math.max(1, Math.round(d / 2.8));
    const sbw = d / sideBays;
    const pickSide = () => (r() < 0.55 ? F.SIDE : r() < 0.6 ? F.SIDE_WIN : F.SIDE_PIPE);
    for (let f = 0; f < floors; f++) {
      const ya = f === 0 ? 0 : GH + UH * (f - 1);
      const yb = f === 0 ? GH : ya + UH;
      for (let i = 0; i < sideBays; i++) {
        const za = -i * sbw;
        const zb = za - sbw;
        facade.quad(v3(hw, ya, za), v3(hw, ya, zb), v3(hw, yb, zb), v3(hw, yb, za), cellUV(pickSide()), tint);
        facade.quad(v3(-hw, ya, zb), v3(-hw, ya, za), v3(-hw, yb, za), v3(-hw, yb, zb), cellUV(pickSide()), tint);
      }
      const backBays = Math.max(1, Math.round(w / 2.8));
      const bbw = w / backBays;
      for (let i = 0; i < backBays; i++) {
        const xa = hw - i * bbw;
        facade.quad(v3(xa, ya, -d), v3(xa - bbw, ya, -d), v3(xa - bbw, yb, -d), v3(xa, yb, -d), cellUV(pickSide()), tint);
      }
    }
    // 屋顶
    const pitch = THREE.MathUtils.degToRad(b.pitch ?? 24);
    const tan = Math.tan(pitch);
    /** 带厚度的瓦面：顶面铺瓦（uv 按米：沿檐口 / 沿坡），底面是檐底的木板，四边是檐口板 */
    const slab = (pts: THREE.Vector3[], t = 0.12, c = roofC) => {
      const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
      const ua = new THREE.Vector3().subVectors(pts[1], pts[0]).normalize();
      const va = new THREE.Vector3().crossVectors(n, ua);
      const inPlane = (p: THREE.Vector3): [number, number] => {
        const q = p.clone().sub(pts[0]);
        return [q.dot(ua), q.dot(va)];
      };
      roof.poly(pts, pts.map(inPlane), c);
      const low = pts.map((p) => p.clone().addScaledVector(n, -t));
      const lowR = [...low].reverse();
      wood.poly(lowR, lowR.map(inPlane), SOFFIT);
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const len = pts[i].distanceTo(pts[j]);
        wood.poly(
          [low[i], low[j], pts[j], pts[i]],
          [
            [0, 0],
            [len, 0],
            [len, t],
            [0, t],
          ],
          WOOD,
        );
      }
    };
    const gableTri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) => {
      const [u0, v0, u1, v1] = cellUV(F.GABLE);
      const vh = (y: number) => v0 + ((y - H) / UH) * (v1 - v0);
      facade.poly([p0, p1, p2], [[u0, v0], [u1, v0], [(u0 + u1) / 2, vh(p2.y)]], tint);
    };
    const ov = 0.6;
    const so = 0.35;
    if (b.roof === 'hira' || (b.roof === 'yose' && w < d)) {
      const rise = (d / 2) * tan;
      const ye = H - ov * tan;
      const yr = H + rise;
      slab([v3(-hw - so, ye, ov), v3(hw + so, ye, ov), v3(hw + so, yr, -d / 2), v3(-hw - so, yr, -d / 2)]);
      slab([v3(hw + so, ye, -d - ov), v3(-hw - so, ye, -d - ov), v3(-hw - so, yr, -d / 2), v3(hw + so, yr, -d / 2)]);
      gableTri(v3(hw, H, 0), v3(hw, H, -d), v3(hw, yr, -d / 2));
      gableTri(v3(-hw, H, -d), v3(-hw, H, 0), v3(-hw, yr, -d / 2));
      trim.box(-hw - so - 0.05, yr - 0.02, -d / 2 - 0.14, hw + so + 0.05, yr + 0.2, -d / 2 + 0.14, roofC.clone().multiplyScalar(0.62));
    } else if (b.roof === 'tsuma') {
      const rise = hw * tan;
      const ye = H - ov * tan;
      const yr = H + rise;
      slab([v3(hw + ov, ye, so), v3(hw + ov, ye, -d - so), v3(0, yr, -d - so), v3(0, yr, so)]);
      slab([v3(-hw - ov, ye, -d - so), v3(-hw - ov, ye, so), v3(0, yr, so), v3(0, yr, -d - so)]);
      gableTri(v3(-hw, H, 0), v3(hw, H, 0), v3(0, yr, 0));
      gableTri(v3(hw, H, -d), v3(-hw, H, -d), v3(0, yr, -d));
      trim.box(-0.14, yr - 0.02, -d - so - 0.05, 0.14, yr + 0.2, so + 0.05, roofC.clone().multiplyScalar(0.62));
      // 山墙上的破风板（插画里山墙朝街的那栋，三角形的边是一道深色的木板）
      const len = Math.hypot(hw + ov, rise + ov * tan);
      const ang = Math.atan2(rise + ov * tan, hw + ov);
      for (const sx of [1, -1]) {
        wood.setTransform(
          tmpM
            .copy(M)
            .multiply(new THREE.Matrix4().makeTranslation((sx * (hw + ov)) / 2, (ye + yr) / 2 + 0.06, so + 0.03))
            .multiply(new THREE.Matrix4().makeRotationZ(sx > 0 ? -ang + Math.PI : ang - Math.PI)),
        );
        wood.box(-len / 2, -0.12, -0.04, len / 2, 0.12, 0.04, WOOD, 1);
      }
      wood.setTransform(M);
    } else if (b.roof === 'yose') {
      const rise = (d / 2) * tan;
      const ye = H - ov * tan;
      const yr = H + rise;
      const xr = hw - d / 2;
      const El = -hw - ov;
      const Er = hw + ov;
      slab([v3(El, ye, ov), v3(Er, ye, ov), v3(xr, yr, -d / 2), v3(-xr, yr, -d / 2)]);
      slab([v3(Er, ye, -d - ov), v3(El, ye, -d - ov), v3(-xr, yr, -d / 2), v3(xr, yr, -d / 2)]);
      slab([v3(Er, ye, ov), v3(Er, ye, -d - ov), v3(xr, yr, -d / 2)]);
      slab([v3(El, ye, -d - ov), v3(El, ye, ov), v3(-xr, yr, -d / 2)]);
      if (xr > 0.05) trim.box(-xr - 0.1, yr - 0.02, -d / 2 - 0.13, xr + 0.1, yr + 0.18, -d / 2 + 0.13, roofC.clone().multiplyScalar(0.62));
    } else {
      // 平顶：女儿墙 + 顶面，上面一个水箱
      const pc = tint.clone().multiplyScalar(0.92);
      trim.box(-hw, H, -d, hw, H + 0.02, 0, col(0xa9a69f));
      trim.box(-hw - 0.05, H, -0.15, hw + 0.05, H + 0.55, 0.05, pc);
      trim.box(-hw - 0.05, H, -d - 0.05, hw + 0.05, H + 0.55, -d + 0.15, pc);
      trim.box(-hw - 0.05, H, -d, -hw + 0.15, H + 0.55, 0, pc);
      trim.box(hw - 0.15, H, -d, hw + 0.05, H + 0.55, 0, pc);
      trim.box(hw - 2.2, H, -d + 1.0, hw - 0.9, H + 1.2, -d + 2.2, col(0xd9dad6));
    }
    // 一楼上面的小瓦檐（庇）
    if (b.hisashi) {
      const yb = GH - 0.05;
      slab([v3(-hw - 0.05, yb - 0.3, 0.95), v3(hw + 0.05, yb - 0.3, 0.95), v3(hw + 0.05, yb + 0.12, 0), v3(-hw - 0.05, yb + 0.12, 0)], 0.08);
    }
    // 二楼阳台：木地板 + 木栏杆（竖条）
    if (b.balcony) {
      const [i0, i1] = b.balcony;
      const xa = -hw + i0 * bw + 0.05;
      const xb = -hw + i1 * bw - 0.05;
      const yb = GH;
      const dd = 0.95;
      wood.box(xa, yb - 0.12, 0, xb, yb, dd, WOOD, 1);
      wood.box(xa, yb + 0.92, dd - 0.06, xb, yb + 1.0, dd, WOOD, 1);
      wood.box(xa, yb + 0.05, dd - 0.05, xb, yb + 0.1, dd - 0.01, WOOD, 1);
      for (const x of [xa, xb - 0.06]) wood.box(x, yb, 0, x + 0.06, yb + 1.0, dd, WOOD, 1);
      for (let x = xa + 0.12; x < xb - 0.06; x += 0.13) wood.box(x, yb + 0.1, dd - 0.045, x + 0.035, yb + 0.92, dd - 0.015, WOOD, 1);
    }
    // 布遮阳篷：从墙上斜着伸出来，前面一圈垂边，两头三角形的侧片
    if (b.awning != null) {
      const ac = col(b.awning);
      const top = GH - 0.12;
      const low = GH - 0.72;
      const out = 1.6;
      const xa = -hw + 0.15;
      const xb = hw - 0.15;
      fabric.quad(v3(xa, low, out), v3(xb, low, out), v3(xb, top, 0), v3(xa, top, 0), [0, 0, 1, 1], ac);
      fabric.quad(v3(xa, low - 0.28, out), v3(xb, low - 0.28, out), v3(xb, low, out), v3(xa, low, out), [0, 0, 1, 1], ac.clone().multiplyScalar(0.85));
      fabric.poly([v3(xb, top, 0), v3(xb, low, out), v3(xb, low - 0.28, out), v3(xb, top - 0.2, 0)], [[0, 0], [0, 0], [0, 0], [0, 0]], ac.clone().multiplyScalar(0.8));
      fabric.poly([v3(xa, top - 0.2, 0), v3(xa, low - 0.28, out), v3(xa, low, out), v3(xa, top, 0)], [[0, 0], [0, 0], [0, 0], [0, 0]], ac.clone().multiplyScalar(0.8));
      // 支架（两根细铁杆）
      for (const x of [xa + 0.1, xb - 0.1]) {
        metal.setTransform(tmpM.copy(M).multiply(new THREE.Matrix4().makeTranslation(x, (top + low) / 2 - 0.05, out / 2).multiply(new THREE.Matrix4().makeRotationX(Math.atan2(top - low, out)))));
        metal.box(-0.015, -0.015, -out / 2, 0.015, 0.015, out / 2, IRON);
      }
      metal.setTransform(M);
    }
    // 横招牌：一楼上方（有瓦檐的立在瓦檐后面，二楼窗台下面）
    if (b.sign != null) {
      const [u0, v0, u1, v1] = signUV(b.sign);
      const sw = Math.min(w - 0.6, 3.6);
      const sy = b.hisashi ? GH + 0.12 : GH - 0.72;
      const z = b.hisashi ? 0.06 : 0.04;
      signs.quad(v3(-sw / 2, sy, z), v3(sw / 2, sy, z), v3(sw / 2, sy + sw / 4, z), v3(-sw / 2, sy + sw / 4, z), [u0, v0, u1, v1], WHITE);
      wood.box(-sw / 2 - 0.04, sy - 0.04, 0, sw / 2 + 0.04, sy + sw / 4 + 0.04, z - 0.01, WOOD, 1);
    }
    // 挂在墙上的竖旗：门脸一头伸出一根铁臂，旗子挂在下面，旗面朝着街的方向
    if (b.banner) {
      const [idx, end] = b.banner;
      const x = end ? hw + 0.06 : -hw - 0.06;
      hangingBanner(M, x, idx, GH + 0.55, 0.15, 0.5);
    }
    if (b.solid) {
      const g = new THREE.BoxGeometry(w, H, d);
      g.translate(0, H / 2, -d / 2);
      collider(g, M.clone());
    }
    return { M, w, H, d };
  };

  /**
   * 一面竖旗：挂点 (x, top) 在局部坐标里，旗子从 z0 伸到 z0 + 宽，往下垂 1.6m。
   * 正反两面各一张（uv 左右翻过来，两面的字都是正的），旗面法线沿局部 x（街的方向）
   */
  const hangingBanner = (M: THREE.Matrix4, x: number, idx: number, top: number, z0: number, wide: number) => {
    const [u0, v0, u1, v1] = bannerUV(idx);
    const h = wide * 3.6;
    const za = z0 + 0.06;
    const zb = z0 + wide;
    signs.setTransform(M);
    metal.setTransform(M);
    // 法线方向（世界坐标）：局部 x
    const sw = { dir: v3(1, 0, 0).transformDirection(M), w: [1, 1, 0, 0] };
    signs.poly(
      [v3(x + 0.01, top - h, zb), v3(x + 0.01, top - h, za), v3(x + 0.01, top, za), v3(x + 0.01, top, zb)],
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      WHITE,
      sw,
    );
    signs.poly(
      [v3(x - 0.01, top - h, za), v3(x - 0.01, top - h, zb), v3(x - 0.01, top, zb), v3(x - 0.01, top, za)],
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      WHITE,
      sw,
    );
    // 铁臂：上下两根（下面那根短，压着旗角）
    metal.box(x - 0.02, top, 0, x + 0.02, top + 0.04, zb + 0.06, IRON);
    metal.box(x - 0.015, top - 0.02, 0, x + 0.015, top + 0.02, za, IRON);
  };

  // 近处这一排手摆（构图用），再往两头随机生成
  const near: BuildingSpec[] = [
    // 咖啡店（她身边，左边这一整栋）：一楼大玻璃窗 + 门，深蓝遮阳篷，二楼木框高窗和阳台，旗子挂在远处那头
    {
      s: S0 + 3.2,
      w: 13,
      depth: 10,
      ground: [F.CAFE_WIN, F.CAFE_WIN, F.CAFE_DOOR, F.CAFE_WIN, F.CAFE_WIN],
      upper: [[F.WIN_TALL, F.BALC_DOOR, F.BALC_DOOR, F.BALC_DOOR, F.WIN_TALL]],
      tint: 0xfff3e0,
      roof: 'hira',
      roofTint: 0x5f6672,
      balcony: [1, 4],
      awning: 0x2c3350,
      banner: [0, 1],
      solid: true,
    },
    // 陶器店（山墙朝街，一楼小瓦檐、暖帘）
    {
      s: S0 + 13.8,
      w: 7,
      depth: 9,
      ground: [F.SHOP_WIN, F.NOREN, F.SHOP_WIN],
      upper: [[F.WIN_LATTICE, F.WIN_WOOD, F.WIN_LATTICE]],
      tint: 0xf7efe2,
      roof: 'tsuma',
      roofTint: 0x8ea0bc,
      pitch: 30,
      hisashi: true,
      sign: 1,
      banner: [1, 1],
      solid: true,
    },
    // 住家
    {
      s: S0 + 20.9,
      w: 6.2,
      depth: 8,
      ground: [F.GENKAN, F.WALL_G],
      upper: [[F.WIN_ALU, F.WALL_AC]],
      tint: 0xe9eef2,
      roof: 'hira',
      roofTint: 0x7d8aa0,
      solid: true,
    },
    // 土特产店（蓝色遮阳篷）
    {
      s: S0 + 29,
      w: 8,
      depth: 9,
      ground: [F.SOUVENIR, F.CAFE_DOOR, F.SOUVENIR],
      upper: [[F.WIN_WOOD, F.WIN_ALU, F.WIN_WOOD]],
      tint: 0xfbf2e2,
      roof: 'yose',
      roofTint: 0x8ea0bc,
      awning: 0x3d6fb4,
      sign: 2,
    },
    // 三层的小楼（平顶，一楼卷帘门）
    {
      s: S0 + 36.6,
      w: 6.2,
      depth: 9,
      ground: [F.SHUTTER, F.GENKAN],
      upper: [
        [F.WIN_ALU, F.WIN_ALU],
        [F.WIN_SMALL, F.WALL_AC],
      ],
      tint: 0xeeeeec,
      roof: 'flat',
      roofTint: 0x7d8aa0,
    },
    // 居酒屋（小瓦檐、竖旗）
    {
      s: S0 + 43.4,
      w: 6.4,
      depth: 9,
      ground: [F.IZAKAYA, F.IZAKAYA],
      upper: [[F.WIN_LATTICE, F.WIN_LATTICE]],
      tint: 0xf6e8d2,
      roof: 'hira',
      roofTint: 0x5f6672,
      hisashi: true,
      sign: 4,
      banner: [6, 0],
    },
    // 身后（镜头转过去才看到）：花店、住家
    {
      s: S0 - 7.4,
      w: 6.6,
      depth: 9,
      ground: [F.FLOWER, F.FLOWER],
      upper: [[F.WIN_WOOD, F.WIN_WOOD]],
      tint: 0xffffff,
      roof: 'hira',
      roofTint: 0x8ea0bc,
      awning: 0x4e8a5c,
      sign: 3,
      solid: true,
    },
    {
      s: S0 - 14.6,
      w: 6.8,
      depth: 8.5,
      ground: [F.LATTICE, F.GENKAN],
      upper: [[F.WIN_LATTICE, F.WIN_WOOD]],
      tint: 0xf6e8d2,
      roof: 'yose',
      roofTint: 0x7d8aa0,
      hisashi: true,
      solid: true,
    },
  ];
  // 两头随机：宽 5.5~9m、间隔 0.3~1.2m（偶尔留一块空地种树），两三层，屋顶四种
  const shopsG: Cell[] = [F.SHUTTER, F.SHOP_WIN, F.SOUVENIR, F.GLASS_SHOP, F.FLOWER, F.NOREN, F.IZAKAYA, F.CAFE_WIN];
  const homeG: Cell[] = [F.GENKAN, F.WALL_G, F.LATTICE, F.GENKAN, F.WALL_G];
  const upperC: Cell[] = [F.WIN_WOOD, F.WIN_ALU, F.WIN_LATTICE, F.WALL_U, F.WIN_SMALL, F.WALL_AC, F.WIN_ALU, F.WIN_WOOD];
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const gaps: number[] = [];
  const randomBuilding = (s: number, w: number): BuildingSpec => {
    const bays = Math.max(2, Math.round(w / 2.9));
    const shop = r() < 0.4;
    const floors = r() < 0.12 ? 1 : r() < 0.78 ? 2 : 3;
    const ground: Cell[] = [];
    for (let i = 0; i < bays; i++) ground.push(shop ? (i === 0 || r() < 0.6 ? pick(shopsG) : F.CAFE_DOOR) : pick(homeG));
    if (!shop && !ground.includes(F.GENKAN)) ground[Math.floor(r() * bays)] = F.GENKAN;
    const upper: Cell[][] = [];
    for (let f = 1; f < floors; f++) upper.push(Array.from({ length: bays }, () => pick(upperC)));
    const roofT: RoofType = floors === 3 && r() < 0.6 ? 'flat' : pick(['hira', 'hira', 'yose', 'tsuma'] as const);
    return {
      s,
      w,
      depth: 8 + r() * 3,
      setback: r() < 0.25 ? 0.3 + r() * 0.8 : 0,
      ground,
      upper,
      tint: pick(WALL_TINTS),
      roof: roofT,
      roofTint: pick(ROOF_TINTS),
      pitch: 20 + r() * 10,
      hisashi: floors >= 2 && roofT !== 'flat' && r() < 0.5,
      balcony: floors >= 2 && r() < 0.18 ? [0, bays] : undefined,
      awning: shop && r() < 0.35 ? pick([0x2c3350, 0x3d6fb4, 0xb6463c, 0x4e8a5c, 0x8a5a3c]) : undefined,
      sign: shop && r() < 0.6 ? Math.floor(r() * 6) : undefined,
      banner: shop && r() < 0.3 ? [pick([1, 3, 4, 5, 6]), r() < 0.5 ? 1 : 0] : undefined,
    };
  };
  const specs = [...near];
  {
    // 往远处（+s）：从居酒屋后面接着排，一直到弯道过去
    let s = S0 + 43.4 + 3.2 + 0.6;
    while (s < S0 + 330) {
      const w = 5.5 + r() * 3.5;
      specs.push(randomBuilding(s + w / 2, w));
      s += w;
      const gap = r() < 0.15 ? 3 + r() * 2 : 0.3 + r() * 0.9;
      if (gap > 2.5) gaps.push(s + gap / 2);
      s += gap;
    }
    // 往身后（-s）
    s = S0 - 14.6 - 3.4 - 0.6;
    while (s > S0 - 450) {
      const w = 5.5 + r() * 3.5;
      specs.push(randomBuilding(s - w / 2, w));
      s -= w;
      const gap = r() < 0.15 ? 3 + r() * 2 : 0.3 + r() * 0.9;
      if (gap > 2.5) gaps.push(s - gap / 2);
      s -= gap;
    }
  }
  for (const b of specs) building(b);

  // 第二排往后：小镇沿着山坡往上爬（镜头转到身后、或者从房子之间的缝里看到）
  {
    const rb = rng(55);
    const placed: V2[] = [];
    for (let k = 0, n = 0; k < 900 && n < 90; k++) {
      const s = S0 - 380 + rb() * 600;
      const d = 18 + rb() ** 1.4 * 150;
      const p = pt(s, d);
      if (placed.some(([x, z]) => Math.hypot(x - p.x, z - p.z) < 11)) continue;
      // 离路近的这几排要躲开其他路段（弯道内侧）
      if (project(p.x, p.z).d < 16) continue;
      placed.push([p.x, p.z]);
      const w = 6 + rb() * 3;
      const floors = rb() < 0.7 ? 2 : 1;
      const y = landY(p.x, p.z) - 0.6;
      const spec: BuildingSpec = {
        s,
        w,
        depth: 6 + rb() * 3,
        setback: d - FRONT,
        ground: [pick(homeG), F.GENKAN, ...(w > 8 ? [pick(homeG)] : [])],
        upper: floors === 2 ? [[pick(upperC), pick(upperC)]] : [],
        tint: pick(WALL_TINTS),
        roof: pick(['hira', 'yose', 'hira', 'tsuma'] as const),
        roofTint: pick(ROOF_TINTS),
        pitch: 22 + rb() * 8,
        y,
      };
      building(spec);
    }
  }

  // ---- 咖啡店门口：立式小黑板、长凳、花箱、盆栽；路边插的布旗；自动售货机 ----
  const planks = (() => {
    const tl = new THREE.TextureLoader();
    const t = (file: string, color = false) => {
      const x = keep(tl.load(`${BASE}textures/weathered_brown_planks/${file}`));
      if (color) x.colorSpace = THREE.SRGBColorSpace;
      x.wrapS = x.wrapT = THREE.RepeatWrapping;
      return x;
    };
    const m = keep(new THREE.MeshStandardMaterial({ map: t('diffuse.jpg', true), normalMap: t('nor_gl.jpg'), roughness: 0.85 }));
    m.color.setScalar(1.35);
    return m;
  })();
  const props = new Mesher();
  /** 人行道上 s 处、离中线 d 的一个局部坐标系：x 沿路往远处，z 朝着路（左边人行道上的东西用） */
  const frameAt = (s: number, d: number, y = KERB_H, face: 1 | -1 = 1) => {
    const a = at(s);
    const p = a.p.clone().addScaledVector(a.l, d);
    const z = a.l.clone().multiplyScalar(-face);
    return new THREE.Matrix4().makeRotationY(Math.atan2(z.x, z.z)).setPosition(p.x, y, p.z);
  };
  const plantSpots: Array<{ s: number; d: number; h: number; variant: number }> = [];
  {
    // 立式小黑板（A 字形，两面都是黑板）
    const boardTex = keep(chalkboard());
    const boardMat = keep(new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.9 }));
    const bg = keep(new THREE.PlaneGeometry(0.56, 0.84));
    const sign = new THREE.Group();
    for (const side of [1, -1]) {
      const p = new THREE.Mesh(bg, boardMat);
      p.position.set(0, 0.4, side * 0.17);
      p.rotation.set(-side * 0.2, side > 0 ? 0 : Math.PI, 0);
      p.castShadow = true;
      p.receiveShadow = true;
      sign.add(p);
    }
    // 黑板面朝着往远处看的方向（她身后往远处看，正好是正面；从身后看是另一面）
    const f = frameAt(S0 + 8.6, FRONT - 1.7);
    sign.applyMatrix4(f);
    sign.rotateY(-Math.PI / 2 - 0.35);
    group.add(sign);
    // 长凳（靠着咖啡店的窗）
    props.setTransform(frameAt(S0 + 2.2, FRONT - 0.45));
    const woodC = col(0xffffff);
    props.box(-0.75, 0.42, -0.2, 0.75, 0.47, 0.2, woodC, 1.2);
    for (const x of [-0.62, 0.52]) props.box(x, 0, -0.17, x + 0.1, 0.42, 0.17, woodC, 1.2);
    // 花箱：咖啡店两头各一个，里面种灌木
    for (const s of [S0 - 2.6, S0 + 6.9]) {
      props.setTransform(frameAt(s, FRONT - 0.55));
      props.box(-0.6, 0, -0.25, 0.6, 0.45, 0.25, woodC, 1.2);
      plantSpots.push({ s, d: FRONT - 0.55, h: 0.95, variant: 0 });
    }
    // 陶器店门口一个花箱
    props.setTransform(frameAt(S0 + 11.3, FRONT - 0.4));
    props.box(-0.45, 0, -0.2, 0.45, 0.4, 0.2, woodC, 1.2);
    plantSpots.push({ s: S0 + 11.3, d: FRONT - 0.4, h: 0.8, variant: 1 });
    const mesh = new THREE.Mesh(keep(props.build()), planks);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'props';
    group.add(mesh);
    // 自动售货机：立在住家和土特产店之间的缝里，面朝街
    const vend = new Mesher({ uv1: true });
    vend.setTransform(frameAt(S0 + 24.6, FRONT - 0.45));
    vend.quad(v3(-0.5, 0, 0.38), v3(0.5, 0, 0.38), v3(0.5, 1.83, 0.38), v3(-0.5, 1.83, 0.38), cellUV(F.VENDING), WHITE);
    facade.setTransform(frameAt(S0 + 24.6, FRONT - 0.45));
    trim.setTransform(frameAt(S0 + 24.6, FRONT - 0.45));
    // 侧面刷成蓝色（从路上往远处看，看到的主要是售货机的侧面；第一版灰白的像个空盒子）
    trim.box(-0.52, 0, -0.38, 0.52, 1.86, 0.37, col(0x2f68b0));
    trim.box(-0.53, 1.62, -0.39, 0.53, 1.86, 0.38, col(0xf2f4f5));
    const vm = new THREE.Mesh(keep(vend.build()), facadeMat);
    vm.castShadow = true;
    group.add(vm);
  }
  /** 路边插的布旗：一根细杆、顶上一根横杆，旗面朝着街的方向（d 在哪边人行道上） */
  const nobori = (s: number, d: number, idx: number) => {
    const M = frameAt(s, d, KERB_H);
    const p = new THREE.Vector3().setFromMatrixPosition(M);
    if (inHeadCorridor(p)) return;
    trim.setTransform(M);
    trim.box(-0.02, 0, -0.02, 0.02, 2.55, 0.02, col(0xe9e9e6));
    hangingBanner(M, 0, idx, 2.5, -0.05, 0.6);
  };
  nobori(S0 + 27.2, FRONT - 1.9, 3);
  nobori(S0 + 31.4, FRONT - 1.9, 5);
  nobori(S0 - 9.8, FRONT - 1.9, 5);

  // ---- 电线杆 + 电线 ----
  {
    // 杆身是混凝土（PBR），横担、绝缘子、变压器这些放进铁件那一批
    const poles = new Mesher();
    const dark = col(0x55595e);
    const grey = col(0x8f9499);
    const wires: number[] = [];
    interface Pole {
      top: THREE.Vector3[];
      tel: THREE.Vector3;
      p: THREE.Vector3;
    }
    const list: Pole[] = [];
    for (let s = S0 - 438; s < S0 + 330; s += 28) {
      // 咖啡店和陶器店之间那根（插画左边那根）；别的按间距
      const ss = Math.abs(s - (S0 + 10)) < 14 ? S0 + 10.2 : s;
      const d = FRONT - 0.5;
      const a = at(ss);
      const p = a.p.clone().addScaledVector(a.l, d);
      if (inHeadCorridor(p)) continue;
      const M = new THREE.Matrix4().makeRotationY(Math.atan2(a.l.x, a.l.z)).setPosition(p.x, KERB_H, p.z);
      poles.setTransform(M);
      metal.setTransform(M);
      // 杆子：8 边形的锥台（远看是圆的就够了），uv 按米：u 绕一圈、v 往上
      const H = 10.8;
      const seg = 8;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2;
        const a1 = ((k + 1) / seg) * Math.PI * 2;
        const rb = 0.19;
        const rt = 0.13;
        const perim = 2 * Math.PI * rb;
        poles.quad(
          v3(Math.cos(a1) * rb, 0, Math.sin(a1) * rb),
          v3(Math.cos(a0) * rb, 0, Math.sin(a0) * rb),
          v3(Math.cos(a0) * rt, H, Math.sin(a0) * rt),
          v3(Math.cos(a1) * rt, H, Math.sin(a1) * rt),
          [((k + 1) / seg) * perim, 0, (k / seg) * perim, H],
          WHITE,
        );
      }
      // 横担（垂直于路）+ 绝缘子；第二根短横担；隔一根挂一个变压器
      metal.box(-0.12, H - 0.75, -0.95, 0.06, H - 0.6, 0.95, grey);
      metal.box(-0.12, H - 1.65, -0.6, 0.06, H - 1.5, 0.6, grey);
      const top: THREE.Vector3[] = [];
      for (const z of [-0.85, 0, 0.85]) {
        metal.box(-0.05, H - 0.6, z - 0.04, 0.03, H - 0.42, z + 0.04, col(0xeeeeec));
        top.push(v3(-0.01, H - 0.42, z).applyMatrix4(M));
      }
      if (list.length % 2 === 0) {
        metal.box(0.2, H - 3.4, -0.32, 0.8, H - 2.4, 0.32, grey);
        metal.box(0.12, H - 2.4, -0.04, 0.2, H - 2.3, 0.04, dark);
      }
      // 电话线（低一些、粗一点的黑线）挂在杆子朝路那一侧
      const tel = v3(0.2, 6.2, 0).applyMatrix4(M);
      metal.box(0.12, 6.1, -0.05, 0.24, 6.3, 0.05, dark);
      list.push({ top, tel, p });
      if (r() < 0.6 && Math.abs(ss - S0) < 300) {
        // 引到房子墙上的入户线
        const q = pt(ss + (r() - 0.5) * 6, FRONT + 0.05, 5.4);
        sag(wires, v3(0.1, H - 1.55, 0.4).applyMatrix4(M), q, 0.25);
      }
    }
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (a.p.distanceTo(b.p) > 45) continue;
      for (let k = 0; k < 3; k++) sag(wires, a.top[k], b.top[k], 0.55);
      sag(wires, a.tel, b.tel, 0.7);
    }
    const pm = new THREE.Mesh(keep(poles.build()), concreteMaterial(keep, 'plain'));
    pm.castShadow = true;
    pm.receiveShadow = true;
    pm.name = 'poles';
    group.add(pm);
    const wg = keep(new THREE.BufferGeometry());
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    const lines = new THREE.LineSegments(wg, keep(new THREE.LineBasicMaterial({ color: 0x2a2c31 })));
    lines.name = 'wires';
    group.add(lines);
    // 近处的电线杆挡镜头
    for (const p of list) {
      if (p.p.length() > 14) continue;
      const g = new THREE.CylinderGeometry(0.25, 0.25, 11, 8);
      g.translate(0, 5.5, 0);
      collider(g, new THREE.Matrix4().makeTranslation(p.p.x, 0, p.p.z));
    }
  }
  /** 两点之间垂下来的一根线（悬链线用抛物线近似），按线段存 */
  function sag(out: number[], a: THREE.Vector3, b: THREE.Vector3, depth: number) {
    const n = 14;
    let prev = a;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = a.clone().lerp(b, t);
      p.y -= depth * 4 * t * (1 - t);
      out.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
    }
  }

  // ---- 合并：立面、屋顶、小部件、遮阳篷、旗子 ----
  const finish = (m: Mesher, mat: THREE.Material, name: string, cast = true) => {
    if (m.empty) return;
    const mesh = new THREE.Mesh(keep(m.build()), mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.name = name;
    group.add(mesh);
  };

  // ---- 合批（树、灌木、路灯）----
  const { batch, cull } = createBatcher(group, keep, SUN_DIR, -0.3);
  /** 行道树、庭院树、灌木的位置：[世界 x, z, 变体, 缩放, 朝向] */
  interface Spot {
    x: number;
    z: number;
    y: number;
    variant: number;
    scale: number;
    ry: number;
  }
  const trees: Spot[] = [];
  const bushes: Spot[] = [];
  const lampSpots: Array<{ s: number; p: THREE.Vector3; l: THREE.Vector3 }> = [];
  {
    // 右边人行道：路灯和行道树交替，中间一溜灌木（贴着矮墙）
    const D_LAMP = -4.45;
    const taken: number[] = [];
    // S0 + 15.5 那盏：半身景别里在画面右边，旗子正对镜头（插画右边那盏）
    for (let s = S0 - 444.5; s < S0 + 330; s += 20) {
      const a = at(s);
      const p = a.p.clone().addScaledVector(a.l, D_LAMP);
      if (inHeadCorridor(p)) continue;
      lampSpots.push({ s, p, l: a.l.clone() });
      taken.push(s);
    }
    // 行道树：路灯之间（插画右上角那棵大树 —— 她右后方那棵的树冠伸到画面右上角）
    for (const s of [S0 - 31, S0 - 11, S0 + 8.5, S0 + 47, S0 + 88, S0 - 71, S0 - 131, S0 - 191]) {
      const a = at(s);
      const p = a.p.clone().addScaledVector(a.l, -4.3);
      if (inHeadCorridor(p)) continue;
      trees.push({ x: p.x, z: p.z, y: KERB_H, variant: trees.length % 2, scale: 0.9 + r() * 0.2, ry: r() * Math.PI * 2 });
      taken.push(s);
    }
    for (let s = S0 - 300; s < S0 + 200; s += 2.6 + r() * 2) {
      if (taken.some((t) => Math.abs(t - s) < 1.8)) continue;
      const a = at(s);
      const p = a.p.clone().addScaledVector(a.l, WALL_IN + 0.35 + r() * 0.15);
      bushes.push({ x: p.x, z: p.z, y: KERB_H, variant: 2 + (r() < 0.5 ? 1 : 0), scale: 0.8 + r() * 0.4, ry: r() * Math.PI * 2 });
    }
    // 房子之间空地上的庭院树
    for (const s of gaps) {
      const p = pt(s, FRONT + 3 + r() * 2);
      if (inHeadCorridor(p)) continue;
      trees.push({ x: p.x, z: p.z, y: -0.05, variant: 2, scale: 0.85 + r() * 0.3, ry: r() * Math.PI * 2 });
    }
    // 后面山坡上零星几棵
    for (let k = 0; k < 40; k++) {
      const s = S0 - 300 + r() * 450;
      const d = 22 + r() * 60;
      const p = pt(s, d);
      if (project(p.x, p.z).d < 16) continue;
      trees.push({ x: p.x, z: p.z, y: landY(p.x, p.z) - 0.1, variant: 2, scale: 0.8 + r() * 0.4, ry: r() * Math.PI * 2 });
    }
    // 花箱里的灌木
    for (const sp of plantSpots) {
      const p = pt(sp.s, sp.d);
      bushes.push({ x: p.x, z: p.z, y: KERB_H + 0.4, variant: 2 + sp.variant, scale: sp.h, ry: r() * Math.PI * 2 });
    }
  }
  const TREE_VARIANTS = [
    { preset: 'Ash Medium', seed: 37, height: 8.5, leaves: 1.4 },
    { preset: 'Oak Medium', seed: 41, height: 7.5, leaves: 1.4 },
    { preset: 'Oak Medium', seed: 53, height: 6.5, leaves: 1.2 },
    { preset: 'Bush 1', seed: 61, height: 1.0, leaves: 1 },
    { preset: 'Bush 1', seed: 67, height: 0.85, leaves: 1 },
  ] as const;
  void import('@dgreenheck/ez-tree').then(({ Tree }) => {
    if (disposed) return;
    const make = createTreeMaker(Tree, { wind, sunDir: SUN_DIR, keep, leafTint: LEAF_TINT });
    const up = new THREE.Vector3(0, 1, 0);
    const plant = (v: TreeVariant, spots: Spot[], solid: boolean) => {
      if (!spots.length) return;
      const matrices = spots.map((spot) => {
        const s = v.scale * spot.scale;
        if (solid && Math.hypot(spot.x, spot.z) < 12) {
          const rr = Math.max(0.2, v.trunk * s * 1.3);
          const g = new THREE.CylinderGeometry(rr, rr, 5, 8);
          g.translate(0, 2.5, 0);
          collider(g, new THREE.Matrix4().makeTranslation(spot.x, 0, spot.z));
        }
        return new THREE.Matrix4().compose(v3(spot.x, spot.y - 0.05, spot.z), new THREE.Quaternion().setFromAxisAngle(up, spot.ry), v3(s, s, s));
      });
      const { branchesMesh: b, leavesMesh: l } = v.tree;
      batch(b.geometry, b.material as THREE.Material, matrices, {});
      batch(l.geometry, l.material as THREE.Material, matrices, { depth: v.depth });
    };
    // 灌木的 spot.variant 是 2/3（加了 1 的偏移，和树分开），这里换成灌木变体 3/4
    const all = [...trees, ...bushes.map((b) => ({ ...b, variant: b.variant + 1 }))];
    TREE_VARIANTS.forEach((tv, i) => {
      const v = make(tv.preset, tv.seed, tv.height, null, tv.leaves);
      plant(
        v,
        all.filter((s) => s.variant === i),
        i < 3,
      );
    });
  });

  // ---- 路灯（公园那盏欧式路灯，放大一点），灯杆上挂旗 ----
  const loader = new GLTFLoader();
  const own = (root: THREE.Object3D) =>
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      keep(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        keep(m);
        for (const val of Object.values(m)) if (val instanceof THREE.Texture) keep(val);
      }
    });
  const LAMP_SCALE = 1.25;
  {
    lampSpots.forEach(({ s, p, l }) => {
      // 旗子挂在灯杆朝路的那一侧，旗面朝着街的方向
      const z = l.clone();
      const M = new THREE.Matrix4().makeRotationY(Math.atan2(z.x, z.z)).setPosition(p.x, KERB_H, p.z);
      // 海の見える街 / 潮風通り 隔一盏换一面（她身后右边那盏是"海の見える街"）
      hangingBanner(M, 0, Math.round((s - S0 - 15.5) / 20) % 2 === 0 ? 2 : 7, 3.75, 0.12, 0.5);
      if (p.length() < 12) {
        const g = new THREE.CylinderGeometry(0.15, 0.15, 4.8, 6);
        g.translate(0, 2.4, 0);
        collider(g, new THREE.Matrix4().makeTranslation(p.x, 0, p.z));
      }
    });
  }
  loader.load(`${BASE}models/street_lamp_01/street_lamp_01.gltf`, (gltf) => {
    own(gltf.scene);
    if (disposed) return;
    gltf.scene.updateMatrixWorld(true);
    const places = lampSpots.map(({ p, l }) =>
      new THREE.Matrix4().compose(v3(p.x, KERB_H, p.z), new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), Math.atan2(l.x, l.z) + Math.PI / 2), v3(LAMP_SCALE, LAMP_SCALE, LAMP_SCALE)),
    );
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      batch(mesh.geometry, mat, places.map((m) => m.clone().multiply(mesh.matrixWorld)), mat.transparent ? null : {});
    });
  });
  // 咖啡店门口的盆栽（Poly Pizza 的低多边形绿植，咖啡店场景里那几盆）
  for (const [file, s, d, h] of [
    ['houseplant_1', S0 + 1.4, FRONT - 0.35, 0.9],
    ['houseplant_3', S0 + 4.9, FRONT - 0.35, 1.05],
    ['houseplant_2', S0 + 17.2, FRONT - 0.3, 0.7],
  ] as const) {
    loader.load(`${BASE}polypizza/${file}.glb`, (gltf) => {
      own(gltf.scene);
      if (disposed) return;
      const o = gltf.scene;
      o.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(o);
      o.scale.setScalar(h / Math.max(1e-6, box.max.y - box.min.y));
      const p = pt(s, d, KERB_H);
      o.position.set(p.x, KERB_H - box.min.y * o.scale.y, p.z);
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      group.add(o);
    });
  }

  finish(facade, facadeMat, 'facades');
  finish(roof, roofMat, 'roofs');
  finish(trim, trimMat, 'trim');
  finish(wood, woodMat, 'wood');
  finish(metal, metalMat, 'metal');
  finish(fabric, fabricMat, 'awnings');
  finish(signs, signMat, 'signs');

  // ---- 脚下的接触阴影 ----
  {
    const tex = keep(
      canvasTexture(128, 128, (g) => {
        const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grd.addColorStop(0, 'rgba(0,0,0,0.45)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 128, 128);
      }),
    );
    const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.9, 0.6)), keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.006;
    group.add(m);
  }

  let time = 0;
  return {
    group,
    lights: [],
    colliders,
    // 天光偏蓝、地面反光偏暖灰（柏油和石板）。和公园一样压低环境光、太阳调亮，影子才清楚
    hemisphere: { sky: 0xdcecff, ground: 0x8f8a84, intensity: 0.5 },
    // 雾只管远景：100m 以内不受影响，对岸的小镇（1km）淡三成，山再淡一层，和地平线同色
    fog: new THREE.Fog(HAZE, 100, 2800),
    // 海边晴天的 HDRI（Poly Haven Furry Clouds）：玻璃、铁件反射的是它。转 20°：让它里面的太阳和舞台主光（太阳）在同一个方位
    environment: { url: `${BASE}hdri/furry_clouds_1k.hdr`, intensity: 0.35, rotation: THREE.MathUtils.degToRad(20) },
    shadowBounds: 3,
    sun: { color: 0xfff3e0, intensity: 2.5, bounds: 22, position: SUN_POS, fill: 0.3, rim: 0.4 },
    far: SKY_R + 200,
    // 不设像素预算：满屏逐像素算光的只有右上角那点树叶，GPU 每帧 2~4ms（同样 340 万像素下公园要 8ms），
    // 留着 Retina 的满分辨率，旗子和招牌上的字更清楚
    update(dt: number) {
      time += dt;
      wind.uTime.value = time;
      water.update(time);
      boats.update(time);
      gulls.update(time);
    },
    beforeRender(view, shadow) {
      // 海面反射那一趟嵌套渲染也会走到这里：镜像相机只画远景那一层，合批的树不用按它剔除（剔了主画面的树会闪）
      if (water.reflecting) return;
      cull(view, shadow);
    },
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose();
    },
  };
}
