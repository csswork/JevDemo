import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { canvasTexture, rng, type Backdrop, type LiveLighting } from './common';
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
  createSkyEnv,
  farShore,
  fbm,
  skyUniforms,
} from './seaside';
import { createPalette, createSkyMapping, dirOf, moonIllum, morningTint, samplePalette } from './streetTime';
import { createLights, lampLit, type LightAnchor } from './streetLights';
import { buildingGlowMaterial, kitLight, kitMaterials, loadKit, type KitItem } from './streetKit';
import KIT from './kit/kitSpec.json';
import HERO from './kit/heroSpecs.json';
import type { TimeState } from '../timeOfDay';
import { F, WINDOWS, bannerUV, cellUV, chalkboard, facadeAtlas, holeRects, signAtlas, signUV, type Cell } from './streetTextures';
import { ROOMS, clearGlassMaterial, interiorGlassMaterial, roomAtlas, type GlassNight } from './glass';
import { buildCafeInterior } from './streetInterior';
import { REFLECT_LAYER, createWater } from './water';
import {
  asphaltMaterial,
  concreteMaterial,
  facadeDepthMaterial,
  facadeMaterial,
  metalMaterial,
  paverMaterial,
  roofMaterial,
  woodMaterial,
} from './streetMaterials';

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
 *   路灯      右边人行道上的海边复古柱灯（Blender 做的，乳白灯罩夜里发光），灯杆上挂"海の見える街"的旗
 *   街道设施  电线杆、变压器、杆上的小路灯、售货机、小黑板、长凳、花箱、格栅、井盖、栏杆立柱、旗杆
 *             都是 Blender 做的（scripts/blender/street_props.py），按材质槽换成这里的材质、实例化合批
 *   树        右边人行道的行道树、房子之间的庭院树、栏杆边一溜灌木（ez-tree，和公园同一套合批、透光、随风）
 *   远景      海、对岸的小镇和两层山、灯塔和防波堤、跨海桥、积云（seaside.ts）；身后的小镇往山坡上爬
 *
 * 坐标和舞台一致：角色站在原点、面朝 +Z，主相机在 +Z 方向往 -Z 看，半身景别里看到的是她身后：
 * 她站在路上靠左那条车道（离左边路牙 1.4m），身后左边是咖啡店往后的一排店面，右边是栏杆和海，
 * 正后方是路的尽头 —— 路在那里往左拐，头后面是海、对岸和山，没有竖着的东西（视线走廊，和公园一样）。
 *
 * 灯光：舞台的主光当太阳用（白天右侧偏前、离地约 46°），左边一排店面朝着太阳、是亮的，遮阳篷和瓦檐在墙上投影；
 * 行道树在路面上投斑驳的影子。天光偏蓝、地面反光偏暖灰。
 *
 * 昼夜：太阳、天空、雾、海、云、环境光都按时间变（调色表和方位见 streetTime.ts，舞台每帧照着 lighting 设灯），
 * 天黑了路灯、店门口、窗里、售货机、灯塔、船灯、对岸的灯一盏盏亮起来（streetLights.ts）。
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
  /** 一楼是真的 3D 店内（透明玻璃）：她身边那家咖啡店。别的房子的窗都是室内映射（glass.ts） */
  interior?: boolean;
  /** 她身边那 8 栋：整栋是 Blender 精建的（hero_buildings.py），building() 照常走一遍（随机数的用法不变）但不出几何体 */
  hero?: string;
}

/**
 * 一个网格的数据：位置、法线、uv、颜色（可选：旗子的摆动参数、按米铺的第二套 uv）。所有房子按材质各攒一个，最后各合成一个几何体。
 * poly 的点按"从正面看逆时针"给，法线由前三个点算。
 * uv1：墙面的灰泥贴图用（立面图集用 uv）。按变换前的局部坐标算：u = 沿着这个面的水平方向（米），v = 高度（米），
 * 同一面墙上一格挨一格的接得上
 */
const _gm = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
class Mesher {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  uv1: number[] | null;
  col: number[] = [];
  idx: number[] = [];
  sway: number[] | null;
  /** 每个顶点再带三个数（房子构件的灯：几时亮，见 streetKit.ts 的 buildingGlowMaterial） */
  ext: number[] | null;
  private m = new THREE.Matrix4();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly t = new THREE.Vector3();
  private readonly w = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  constructor({ sway = false, uv1 = false, ext = false }: { sway?: boolean; uv1?: boolean; ext?: boolean } = {}) {
    this.sway = sway ? [] : null;
    this.uv1 = uv1 ? [] : null;
    this.ext = ext ? [] : null;
  }
  /**
   * 把一份几何体（Blender 构件的一个零件）变换以后并进来：local = 零件 → 这个 Mesher 的局部坐标（再乘 setTransform 的变换）。
   * 可以不等比缩放（开间宽窄不一）：法线按逆转置变换。顶点色乘 tint；ext = 每个顶点带的三个数
   */
  addGeometry(geo: THREE.BufferGeometry, local: THREE.Matrix4, tint?: THREE.Color, ext?: [number, number, number], plasterUV?: readonly number[]) {
    const base = this.pos.length / 3;
    const M = _gm.multiplyMatrices(this.m, local);
    const N = _nm.getNormalMatrix(M);
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const col = geo.attributes.color;
    const p = this.a;
    const n = this.b;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(M);
      this.pos.push(p.x, p.y, p.z);
      n.fromBufferAttribute(nrm, i).applyMatrix3(N).normalize();
      this.nrm.push(n.x, n.y, n.z);
      // 灰泥（墙）：模型的 uv（按米）放进 uv1，uv 指着立面图集里素墙那一格（墙的材质按 uv1 铺灰泥、按 uv 盖图集）
      if (plasterUV) this.uv.push((plasterUV[0] + plasterUV[2]) / 2, (plasterUV[1] + plasterUV[3]) / 2);
      else this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      const r = col ? col.getX(i) : 1;
      const g = col ? col.getY(i) : 1;
      const bl = col ? col.getZ(i) : 1;
      this.col.push(r * (tint?.r ?? 1), g * (tint?.g ?? 1), bl * (tint?.b ?? 1));
      if (this.uv1) this.uv1.push(plasterUV && uv ? uv.getX(i) : 0, plasterUV && uv ? uv.getY(i) : 0);
      if (this.sway) this.sway.push(0, 0, 0, 0);
      if (this.ext) this.ext.push(...(ext ?? [0, 0, 24]));
    }
    const idx = geo.index;
    if (idx) for (let i = 0; i < idx.count; i++) this.idx.push(base + idx.getX(i));
    else for (let i = 0; i < pos.count; i++) this.idx.push(base + i);
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
    if (this.ext) g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.ext, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * 室内映射玻璃的网格：位置、法线 + 每个顶点的房间参数（见 glass.ts 的 interiorGlassMaterial）。
 * 一扇窗一块（窗棂是挡在前面的几何体），房间按房子的一层算（同一层的几扇窗看进去是同一个房间）
 */
interface RoomParams {
  /** 房间左墙、地板在局部坐标里的位置 */
  left: number;
  floor: number;
  /** 宽、高、深 */
  size: [number, number, number];
  /** 种类（图集的行）、变体、灯的亮度、窗帘 */
  info: [number, number, number, number];
}
class GlassMesher {
  pos: number[] = [];
  nrm: number[] = [];
  roomPos: number[] = [];
  roomSize: number[] = [];
  roomInfo: number[] = [];
  winUv: number[] = [];
  idx: number[] = [];
  private m = new THREE.Matrix4();
  private readonly n = new THREE.Vector3();
  setTransform(m: THREE.Matrix4) {
    this.m.copy(m);
    return this;
  }
  /** 一块玻璃：局部坐标 [x0, x1] × [y0, y1]，在 z 平面上、朝 +z */
  pane(x0: number, y0: number, x1: number, y1: number, z: number, room: RoomParams) {
    const base = this.pos.length / 3;
    this.n.set(0, 0, 1).transformDirection(this.m);
    (
      [
        [x0, y0, 0, 0],
        [x1, y0, 1, 0],
        [x1, y1, 1, 1],
        [x0, y1, 0, 1],
      ] as const
    ).forEach(([x, y, u, v]) => {
      const p = v3(x, y, z).applyMatrix4(this.m);
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(this.n.x, this.n.y, this.n.z);
      this.roomPos.push(x - room.left, y - room.floor);
      this.roomSize.push(...room.size);
      this.roomInfo.push(...room.info);
      this.winUv.push(u, v);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /**
   * 构件里的玻璃（pane 槽）：frame = 开间 → 房子的局部坐标，cell = 零件 → 开间的局部坐标（x 沿墙、y 向上、墙面 z = 0）。
   * 房间参数按开间的局部坐标算（room.left、floor 也是开间坐标），rect = 窗洞（窗帘按它铺）
   */
  addGeometry(geo: THREE.BufferGeometry, frame: THREE.Matrix4, cell: THREE.Matrix4, room: RoomParams, rect: [number, number, number, number]) {
    const base = this.pos.length / 3;
    const toBay = cell;
    const M = _gm.multiplyMatrices(this.m, frame).multiply(cell);
    const N = _nm.getNormalMatrix(M);
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const q = new THREE.Vector3();
    const p = new THREE.Vector3();
    const [x0, y0, x1, y1] = rect;
    for (let i = 0; i < pos.count; i++) {
      q.fromBufferAttribute(pos, i).applyMatrix4(toBay);
      p.fromBufferAttribute(pos, i).applyMatrix4(M);
      this.pos.push(p.x, p.y, p.z);
      this.n.fromBufferAttribute(nrm, i).applyMatrix3(N).normalize();
      this.nrm.push(this.n.x, this.n.y, this.n.z);
      this.roomPos.push(q.x - room.left, q.y - room.floor);
      this.roomSize.push(...room.size);
      this.roomInfo.push(...room.info);
      this.winUv.push((q.x - x0) / Math.max(1e-3, x1 - x0), (q.y - y0) / Math.max(1e-3, y1 - y0));
    }
    const idx = geo.index;
    if (idx) for (let i = 0; i < idx.count; i++) this.idx.push(base + idx.getX(i));
    else for (let i = 0; i < pos.count; i++) this.idx.push(base + i);
  }
  get empty() {
    return this.idx.length === 0;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aRoomPos', new THREE.Float32BufferAttribute(this.roomPos, 2));
    g.setAttribute('aRoomSize', new THREE.Float32BufferAttribute(this.roomSize, 3));
    g.setAttribute('aRoomInfo', new THREE.Float32BufferAttribute(this.roomInfo, 4));
    g.setAttribute('aWinUv', new THREE.Float32BufferAttribute(this.winUv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
const col = (hex: number) => new THREE.Color(hex);
/** 一楼墙根石台基的颜色 */
const STONE = new THREE.Color(0xa59f95);
const Y_UP = new THREE.Vector3(0, 1, 0);
const X_POS = new THREE.Vector3(1, 0, 0);
const X_NEG = new THREE.Vector3(-1, 0, 0);
const Z_POS = new THREE.Vector3(0, 0, 1);
const Z_NEG = new THREE.Vector3(0, 0, -1);

/** 房子构件的规格（kit/kitSpec.json，Blender 的 building_kit.py 也读它） */
interface KitModule {
  floor: string;
  hole: number[] | null;
  room: string;
  glow?: number[];
}
/** 格子编号 → 名字（构件按名字找） */
const CELL_NAME = Object.fromEntries(Object.entries(F).map(([k, v]) => [v, k])) as Record<number, string>;
/** 一格要拼的构件（模型到了再拼，见 bakeBuildings） */
interface KitBay {
  name: string;
  lod: number;
  /** 房子的变换、开间 → 房子、零件 → 开间（含按开间宽窄的缩放） */
  M: THREE.Matrix4;
  frame: THREE.Matrix4;
  cell: THREE.Matrix4;
  room: RoomParams | null;
  rect: [number, number, number, number];
  /** 她身边那家咖啡店的一楼：透明玻璃（后面是真的 3D 店内） */
  clear: boolean;
  glow: number[];
  onAt: number;
  lights: boolean;
  /** 瓦的颜色（屋顶零件） */
  tint?: THREE.Color;
}

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
  const holes = holeRects();
  const facadeMat = facadeMaterial(keep, atlas, holes);
  const rooms = keep(roomAtlas());
  /** 按时间变的几个量（天黑了多少、几点），几个着色器共用 */
  const night: GlassNight = { uLights: { value: 0 }, uHour: { value: 15 } };
  const interiorGlassMat = interiorGlassMaterial(keep, rooms, night);
  // ---- 夜里的灯（三档：真实点光源、材质里的轻量灯、光晕，见 streetLights.ts）----
  const nightLights = createLights(keep, { focus: v3(0, 1.2, 0), reflectLayer: REFLECT_LAYER });
  group.add(nightLights.glow);
  /** 灯的随机（错开亮灯的时刻）：单独一个随机数，不动布局用的 r() 的顺序 */
  const rl = rng(911);
  const warm = (hex: number) => new THREE.Color(hex);
  const light = (a: Omit<LightAnchor, 'color'> & { color: number }) => nightLights.add({ ...a, color: warm(a.color) });
  /**
   * Blender 做的街道设施（scripts/blender/street_props.py → models/street/props.glb）：先把每样东西放在哪记下来，
   * 模型到了一起合批（每个材质槽一次绘制），模型里标的光源登记进夜里的灯
   */
  const kitPlace: Array<{ name: string; at: THREE.Matrix4[]; shadow: boolean }> = [];
  const place = (name: string, at: THREE.Matrix4[], shadow = true) => {
    if (at.length) kitPlace.push({ name, at, shadow });
  };
  const kitNight = { uLights: night.uLights, uGlowGain: { value: 2.2 }, uBoxGain: { value: 0.6 } };
  /** 房子构件的拼装记录（building() 里记，模型到了 bakeBuildings 拼），和它们自己的随机数（不动布局用的 r()） */
  const kitBays: KitBay[] = [];
  const rk = rng(4242);
  /** 没有现成房间的窗（侧墙的小窗、只有新构件的一层）：单独一间（开间的局部坐标），kind = null 是住家 */
  const kitRoom = (w: number, ya: number, kind: string | null): RoomParams => {
    const home = kind == null;
    return {
      left: -w / 2 + 0.1,
      floor: ya + 0.05,
      size: [Math.max(0.6, w - 0.2), home ? 2.6 : 3.0, home ? 3.2 : 4.5],
      info: [ROOMS.indexOf((home ? (rk() < 0.55 ? 'home' : 'home2') : kind) as (typeof ROOMS)[number]), rk(), home ? (rk() < 0.2 ? 0.6 : 0.16 + rk() * 0.24) : 0.8, home && rk() < 0.75 ? 1 : 0],
    };
  };
  const clearGlassMat = clearGlassMaterial(keep);
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
  const glassI = new GlassMesher();
  const glassC = new Mesher();
  /** 不出几何体的"垃圾桶"（精建的那 8 栋走 building() 时，墙、屋顶、构件写进这里，最后扔掉） */
  const sink = new Mesher({ uv1: true, sway: true });
  /** 精建的那 8 栋：摆在哪、每层的房间（窗里看进去的） */
  const heroPlace: Array<{ id: string; M: THREE.Matrix4; rooms: Array<RoomParams | null>; b: BuildingSpec; w: number; d: number }> = [];
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
  // 天空（按时间变：渐变、太阳、月亮、星星），和烘环境贴图的小场景共用参数；白天的反射混进 HDRI（Furry Clouds，
  // 转 20°：让它里面的太阳和舞台主光在同一个方位），玻璃、铁件反射的云和太阳和加时间之前一样
  const skyU = skyUniforms();
  skyU.uHdriRot.value = THREE.MathUtils.degToRad(20);
  far(createSky(keep, SKY_R, skyU));
  const envScene = createSkyEnv(keep, skyU);
  let hdriReady = false;
  new HDRLoader().load(`${BASE}hdri/furry_clouds_1k.hdr`, (hdr) => {
    keep(hdr);
    if (disposed) return;
    skyU.uHdri.value = hdr;
    hdriReady = true;
  });
  // 海那一侧的方位角：从左前方（-150°）绕到右后方（80°）
  const SEA_FROM = THREE.MathUtils.degToRad(-150);
  const SEA_TO = THREE.MathUtils.degToRad(80);
  const clouds = far(createClouds(keep, SKY_R * 0.88, THREE.MathUtils.degToRad(-140), THREE.MathUtils.degToRad(40)));
  const cloudMats: THREE.MeshBasicMaterial[] = [];
  clouds.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (m && !cloudMats.includes(m)) cloudMats.push(m);
  });
  far(createFarLand(keep, SEA_FROM, SEA_TO));
  const TOWN_FROM = THREE.MathUtils.degToRad(-128);
  const TOWN_TO = THREE.MathUtils.degToRad(-40);
  const farTown = far(createFarTown(keep, TOWN_FROM, TOWN_TO, 900, night.uLights));
  const bridge = far(createBridge(keep, THREE.MathUtils.degToRad(-128), THREE.MathUtils.degToRad(-108), 160));
  // 对岸沿海一串路灯的光点（只有光晕）：暖黄的钠灯、白的 LED 混着
  for (let a = TOWN_FROM; a < TOWN_TO; a += 0.026 + rl() * 0.01) {
    const rr = farShore(a) + 5 + rl() * 6;
    light({ pos: v3(Math.cos(a) * rr, 5.5, Math.sin(a) * rr), color: rl() < 0.6 ? 0xffb060 : 0xfff0dd, intensity: 0, radius: 0, glow: 2.6, glowGain: 1.4, onAt: 0.1 + rl() * 0.5 });
  }
  // 桥面一排路灯
  {
    bridge.updateMatrixWorld(true);
    bridge.geometry.computeBoundingBox();
    const bb = bridge.geometry.boundingBox!;
    for (let x = bb.min.x + 10; x < bb.max.x - 5; x += 32) {
      for (const z of [-4.2, 4.2]) {
        light({ pos: v3(x, 13.5, z).applyMatrix4(bridge.matrixWorld), color: 0xffd8a0, intensity: 0, radius: 0, glow: 3, glowGain: 1.2, onAt: 0.2 });
      }
    }
  }
  // 灯塔在画面右边、路灯和头之间（插画里的位置）
  const BREAKWATER: [[number, number], [number, number]] = [
    [-40, -206],
    [38, -218],
  ];
  const lighthouse = createLighthouse(keep, ...BREAKWATER, night.uLights);
  far(lighthouse.group);
  // 灯塔的灯：转到正对着她这边的那一下最亮（光晕跟着光束的朝向变）
  light({ pos: lighthouse.lamp, color: 0xfff4e0, intensity: 0, radius: 0, glow: 5, glowGain: 2.5, onAt: 0.15, gain: () => lighthouse.facing() });
  // 渔船、海鸥是异步载入的模型：反射层在载入后才加得上，所以把层号传进去
  const alive = () => !disposed;
  const boats = createBoats(keep, alive, REFLECT_LAYER);
  far(boats.group);
  const gulls = createGulls(keep, alive);
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
      const grates: THREE.Matrix4[] = [];
      for (let s = NEAR0 + 3; s < NEAR1; s += 15) {
        for (const side of [1, -1]) {
          const a = at(s);
          const p = a.p.clone().addScaledVector(a.l, side * (ROAD_HALF - GUTTER / 2));
          grates.push(new THREE.Matrix4().makeRotationY(Math.atan2(a.l.x, a.l.z)).setPosition(p.x, 0.004, p.z));
        }
      }
      place('grate', grates, false);
      // 井盖：两条车道的中间轮流，四十米上下一个；她脚下、人行横道上不放
      const manholes: THREE.Matrix4[] = [];
      let k = 0;
      for (let s = NEAR0 + 20; s < NEAR1; s += 37 + (k % 3) * 6) {
        k++;
        if (Math.abs(s - S0) < 5 || Math.abs(s - (S0 + 28)) < 5) continue; // S0 + 28 = 人行横道（CROSS，在下面）
        const a = at(s);
        const p = a.p.clone().addScaledVector(a.l, k % 2 ? 1.5 : -1.5);
        manholes.push(new THREE.Matrix4().makeRotationY(s * 0.37).setPosition(p.x, 0, p.z));
      }
      place('manhole', manholes, false);
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
    // 立柱（Blender 做的圆管、底座法兰、顶上的圆球）每 2m 一根
    const posts: THREE.Matrix4[] = [];
    for (let s = NEAR0; s < NEAR1; s += 2) {
      const a = at(s);
      const p = a.p.clone().addScaledVector(a.l, RAIL_D);
      posts.push(new THREE.Matrix4().makeRotationY(Math.atan2(a.l.x, a.l.z)).setPosition(p.x, WALL_TOP, p.z));
    }
    place('rail_post', posts);
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
    for (const m of [facade, roof, trim, wood, metal, fabric, signs, glassI, glassC]) m.setTransform(M);
    // 她身边那 8 栋是 Blender 整栋精建的：这里照常走一遍（随机数一个不少地用掉），墙、屋顶、构件都丢进 sink（不出几何体）；
    // 招牌的字（signs）、旗子、碰撞体照常
    const ghost = !!b.hero;
    const fac = ghost ? sink : facade;
    const rf = ghost ? sink : roof;
    const tr = ghost ? sink : trim;
    const wd = ghost ? sink : wood;
    const mt = ghost ? sink : metal;
    const fb = ghost ? sink : fabric;
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
    // 立面：一格一格（开间 × 楼层），每一格交给 bay()：墙面在这里真的开洞（灰泥），洞里和墙外的东西是 Blender 的构件
    // （kitSpec.json 的规格，模型到了再拼，见后面的 bakeBuildings）。同一层的窗共用一个房间
    const floorRooms = Array.from({ length: floors }, (_, f) => floorRoom(f));
    // 远处（离她 60m 以外）和山坡上的房子用简化的构件；也不放瓦当、檐沟、落水管（远看分不出来）
    const lod = b.y != null || center.length() > 60 ? 1 : 0;
    const basis = (ox: number, oz: number, X: THREE.Vector3, Z: THREE.Vector3) => new THREE.Matrix4().makeBasis(X, Y_UP, Z).setPosition(ox, 0, oz);
    for (let f = 0; f < floors; f++) {
      const ya = f === 0 ? 0 : GH + UH * (f - 1);
      const yb = f === 0 ? GH : ya + UH;
      for (let i = 0; i < bays; i++) {
        const cell = f === 0 ? b.ground[i] : b.upper[f - 1][i % b.upper[f - 1].length];
        const cx = -hw + (i + 0.5) * bw;
        const room = floorRooms[f];
        bay(basis(cx, 0, X_POS, Z_POS), bw, ya, yb, cell, f, room ? { ...room, left: room.left - cx } : null);
      }
    }
    // 侧墙、后墙：素墙为主，偶尔一扇小窗、一根落水管（随机数的用法和原来一样）
    const sideBays = Math.max(1, Math.round(d / 2.8));
    const sbw = d / sideBays;
    const pickSide = () => (r() < 0.55 ? F.SIDE : r() < 0.6 ? F.SIDE_WIN : F.SIDE_PIPE);
    for (let f = 0; f < floors; f++) {
      const ya = f === 0 ? 0 : GH + UH * (f - 1);
      const yb = f === 0 ? GH : ya + UH;
      for (let i = 0; i < sideBays; i++) {
        const zc = -(i + 0.5) * sbw;
        bay(basis(hw, zc, Z_NEG, X_POS), sbw, ya, yb, pickSide(), f, null);
        bay(basis(-hw, zc, Z_POS, X_NEG), sbw, ya, yb, pickSide(), f, null);
      }
      const backBays = Math.max(1, Math.round(w / 2.8));
      const bbw = w / backBays;
      for (let i = 0; i < backBays; i++) bay(basis(hw - (i + 0.5) * bbw, -d, X_NEG, Z_NEG), bbw, ya, yb, pickSide(), f, null);
    }
    /**
     * 一个开间：frame = 开间的局部坐标（x 沿墙、原点在开间中心的墙根、z 朝外）→ 房子的局部坐标。
     * 墙面挖掉构件的洞（四块灰泥围着洞）、洞口四周的窗套；一楼的墙根一道石台基；构件的拼装记下来（bakeBuildings）
     */
    function bay(frame: THREE.Matrix4, bwid: number, ya: number, yb: number, cell: Cell, f: number, room: RoomParams | null) {
      const name = CELL_NAME[cell];
      const spec = KIT.modules[name as keyof typeof KIT.modules] as KitModule | undefined;
      const toB = (x: number, y: number, z = 0) => v3(x, y, z).applyMatrix4(frame);
      const h2 = bwid / 2;
      const su = cellUV(F.SIDE);
      const rect: [number, number, number, number] | null = spec?.hole
        ? [-h2 + spec.hole[0] * bwid, ya + spec.hole[1] * (yb - ya), -h2 + spec.hole[2] * bwid, ya + spec.hole[3] * (yb - ya)]
        : null;
      const wallQ = (x0: number, y0: number, x1: number, y1: number) => {
        if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
        fac.quad(toB(x0, y0), toB(x1, y0), toB(x1, y1), toB(x0, y1), su, tint);
      };
      if (!rect) wallQ(-h2, ya, h2, yb);
      else {
        const [x0, y0, x1, y1] = rect;
        wallQ(-h2, ya, x0, yb);
        wallQ(x1, ya, h2, yb);
        wallQ(x0, ya, x1, y0);
        wallQ(x0, y1, x1, yb);
        // 窗套：开口的四个内侧面（灰泥），18cm 深（窗框在 12cm，纸拉门在更里面一点）
        const zg = -0.18;
        if (y0 > ya + 0.01) fac.quad(toB(x0, y0), toB(x1, y0), toB(x1, y0, zg), toB(x0, y0, zg), su, tint);
        fac.quad(toB(x0, y1, zg), toB(x1, y1, zg), toB(x1, y1), toB(x0, y1), su, tint.clone().multiplyScalar(0.85));
        fac.quad(toB(x0, y0), toB(x0, y0, zg), toB(x0, y1, zg), toB(x0, y1), su, tint.clone().multiplyScalar(0.92));
        fac.quad(toB(x1, y0, zg), toB(x1, y0), toB(x1, y1), toB(x1, y1, zg), su, tint.clone().multiplyScalar(0.92));
      }
      // 一楼的墙根：一道比墙面凸出 3cm 的石台基（洞开到地面的地方断开）
      if (f === 0) {
        tr.setTransform(tmpM.copy(M).multiply(frame));
        const plinth = (x0: number, x1: number) => x1 - x0 > 0.02 && tr.box(x0, 0, -0.01, x1, 0.3, 0.03, STONE);
        if (rect && rect[1] < 0.3) {
          plinth(-h2, rect[0]);
          plinth(rect[2], h2);
        } else plinth(-h2, h2);
        tr.setTransform(M);
      }
      // 她身边那家咖啡店的门：玻璃后面挂一块 OPEN 的小木牌
      if (b.interior && cell === F.CAFE_DOOR) {
        const sy = 1.446;
        signs.quad(toB(-0.22, sy, -0.15), toB(0.22, sy, -0.15), toB(0.22, sy + 0.11, -0.15), toB(-0.22, sy + 0.11, -0.15), signUV(6), WHITE);
      }
      if (!spec) return;
      const H0 = spec.floor === 'ground' ? KIT.groundH : KIT.upperH;
      const home = !room && spec.room === 'home';
      if (!ghost)
        kitBays.push({
        name,
        lod,
        M,
        frame,
        cell: new THREE.Matrix4().makeTranslation(0, ya, 0).multiply(new THREE.Matrix4().makeScale(bwid / KIT.cellW, (yb - ya) / H0, 1)),
        room: room ?? (spec.room !== 'none' ? kitRoom(bwid, ya, home || spec.room === 'home' ? null : spec.room) : null),
        rect: rect ?? [-h2, ya, h2, yb],
        clear: !!b.interior && f === 0,
        glow: spec.glow ?? [0, 24],
        onAt: 0.1 + rk() * 0.5,
        lights: !b.interior,
      });
    }
    /**
     * 这一层的房间（窗户里看进去的）：按整栋楼的宽度算，同一层几扇窗共用；一楼的店深一点。
     * 住家随机选客厅 / 卧室，有的亮灯有的没开，大多挂着窗帘
     */
    function floorRoom(f: number): RoomParams | null {
      const cells = f === 0 ? b.ground : b.upper[f - 1];
      const spec = cells.map((c) => WINDOWS[c]).find(Boolean);
      if (!spec) return null;
      const home = spec.room === 'home';
      const kind = home ? (r() < 0.55 ? 'home' : 'home2') : spec.room;
      const floor = f === 0 ? 0.25 : GH + UH * (f - 1) + 0.05;
      return {
        left: -hw + 0.2,
        floor,
        size: [w - 0.4, home ? 2.6 : 3.0, Math.min(home ? 3.6 : 5, d - 0.8)],
        // 白天的住家大多没开灯：屋里比外面暗得多，玻璃上看到的主要是反射；偶尔一间亮着灯。店里开着灯
        info: [ROOMS.indexOf(kind), r(), home ? (r() < 0.2 ? 0.6 : 0.16 + r() * 0.24) : 0.8, home && r() < 0.75 ? 1 : 0],
      };
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
      rf.poly(pts, pts.map(inPlane), c);
      const low = pts.map((p) => p.clone().addScaledVector(n, -t));
      const lowR = [...low].reverse();
      wd.poly(lowR, lowR.map(inPlane), SOFFIT);
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const len = pts[i].distanceTo(pts[j]);
        wd.poly(
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
      const [u0, v0, u1, v1] = cellUV(F.SIDE);
      const vh = (y: number) => v0 + ((y - H) / UH) * (v1 - v0);
      fac.poly([p0, p1, p2], [[u0, v0], [u1, v0], [(u0 + u1) / 2, vh(p2.y)]], tint);
    };
    const ov = 0.6;
    const so = 0.35;
    // 屋顶的 Blender 零件（屋脊、鬼瓦、瓦当、檐沟、落水管）：和构件一起记下来，模型到了再拼；瓦乘这栋的瓦色
    const part = (name: string, local: THREE.Matrix4) => {
      if (!ghost) kitBays.push({ name, lod, M, frame: local, cell: new THREE.Matrix4(), room: null, rect: [0, 0, 0, 0], clear: false, glow: [0, 24], onAt: 0, lights: false, tint: roofC });
    };
    /** 沿一条线排一段段 1m 的零件：mid = 中点，out = 朝外的水平方向（零件的 +z），pitch = 往里抬的坡度 */
    const runAlong = (name: string, mid: THREE.Vector3, len: number, out: THREE.Vector3, pitch = 0) => {
      const X = new THREE.Vector3().crossVectors(Y_UP, out);
      const n = Math.max(1, Math.round(len));
      for (let k = 0; k < n; k++) {
        const c = mid.clone().addScaledVector(X, -len / 2 + ((k + 0.5) * len) / n);
        part(name, new THREE.Matrix4().makeBasis(X, Y_UP, out).setPosition(c).multiply(new THREE.Matrix4().makeRotationX(pitch)).multiply(new THREE.Matrix4().makeScale(len / n, 1, 1)));
      }
    };
    /** 屋脊：一段段脊瓦，两头各一个鬼瓦 */
    const ridgeRun = (mid: THREE.Vector3, len: number, out: THREE.Vector3) => {
      runAlong('ridge', mid, len, out);
      const X = new THREE.Vector3().crossVectors(Y_UP, out);
      part('ridge_end', new THREE.Matrix4().makeBasis(X, Y_UP, out).setPosition(mid.clone().addScaledVector(X, len / 2)));
      part('ridge_end', new THREE.Matrix4().makeBasis(X.clone().negate(), Y_UP, out.clone().negate()).setPosition(mid.clone().addScaledVector(X, -len / 2)));
    };
    /** 檐口：一排瓦当（顺着坡），檐下一道檐沟 */
    const eaveRun = (mid: THREE.Vector3, len: number, out: THREE.Vector3, gutter = true) => {
      if (lod) return;
      runAlong('eave_tiles', mid, len, out, pitch);
      if (gutter) runAlong('gutter', mid.clone().addScaledVector(out, 0.03).setY(mid.y - 0.15), len, out);
    };
    /** 落水管：檐沟到地面 */
    const downpipe = (x: number, z: number, top: number) => lod || part('pipe', new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeScale(1, top, 1)));
    if (b.roof === 'hira' || (b.roof === 'yose' && w < d)) {
      const rise = (d / 2) * tan;
      const ye = H - ov * tan;
      const yr = H + rise;
      slab([v3(-hw - so, ye, ov), v3(hw + so, ye, ov), v3(hw + so, yr, -d / 2), v3(-hw - so, yr, -d / 2)]);
      slab([v3(hw + so, ye, -d - ov), v3(-hw - so, ye, -d - ov), v3(-hw - so, yr, -d / 2), v3(hw + so, yr, -d / 2)]);
      gableTri(v3(hw, H, 0), v3(hw, H, -d), v3(hw, yr, -d / 2));
      gableTri(v3(-hw, H, -d), v3(-hw, H, 0), v3(-hw, yr, -d / 2));
      ridgeRun(v3(0, yr - 0.04, -d / 2), w + 2 * so, Z_POS);
      eaveRun(v3(0, ye, ov), w + 2 * so, Z_POS);
      eaveRun(v3(0, ye, -d - ov), w + 2 * so, Z_NEG, lod === 0);
      for (const x of [-hw + 0.12, hw - 0.12]) downpipe(x, 0.07, ye - 0.15);
    } else if (b.roof === 'tsuma') {
      const rise = hw * tan;
      const ye = H - ov * tan;
      const yr = H + rise;
      slab([v3(hw + ov, ye, so), v3(hw + ov, ye, -d - so), v3(0, yr, -d - so), v3(0, yr, so)]);
      slab([v3(-hw - ov, ye, -d - so), v3(-hw - ov, ye, so), v3(0, yr, so), v3(0, yr, -d - so)]);
      gableTri(v3(-hw, H, 0), v3(hw, H, 0), v3(0, yr, 0));
      gableTri(v3(hw, H, -d), v3(-hw, H, -d), v3(0, yr, -d));
      ridgeRun(v3(0, yr - 0.04, -d / 2), d + 2 * so, X_POS);
      eaveRun(v3(hw + ov, ye, -d / 2), d + 2 * so, X_POS, lod === 0);
      eaveRun(v3(-hw - ov, ye, -d / 2), d + 2 * so, X_NEG, lod === 0);
      // 山墙上的破风板（插画里山墙朝街的那栋，三角形的边是一道深色的木板）
      const len = Math.hypot(hw + ov, rise + ov * tan);
      const ang = Math.atan2(rise + ov * tan, hw + ov);
      for (const sx of [1, -1]) {
        wd.setTransform(
          tmpM
            .copy(M)
            .multiply(new THREE.Matrix4().makeTranslation((sx * (hw + ov)) / 2, (ye + yr) / 2 + 0.06, so + 0.03))
            .multiply(new THREE.Matrix4().makeRotationZ(sx > 0 ? -ang + Math.PI : ang - Math.PI)),
        );
        wd.box(-len / 2, -0.12, -0.04, len / 2, 0.12, 0.04, WOOD, 1);
      }
      wd.setTransform(M);
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
      if (xr > 0.05) ridgeRun(v3(0, yr - 0.04, -d / 2), 2 * xr, Z_POS);
      eaveRun(v3(0, ye, ov), Er - El, Z_POS);
      eaveRun(v3(0, ye, -d - ov), Er - El, Z_NEG, false);
      if (lod === 0) {
        eaveRun(v3(Er, ye, -d / 2), d + 2 * ov, X_POS, false);
        eaveRun(v3(El, ye, -d / 2), d + 2 * ov, X_NEG, false);
      }
      for (const x of [-hw + 0.12, hw - 0.12]) downpipe(x, 0.07, ye - 0.15);
    } else {
      // 平顶：女儿墙 + 顶面，上面一个水箱
      const pc = tint.clone().multiplyScalar(0.92);
      tr.box(-hw, H, -d, hw, H + 0.02, 0, col(0xa9a69f));
      tr.box(-hw - 0.05, H, -0.15, hw + 0.05, H + 0.55, 0.05, pc);
      tr.box(-hw - 0.05, H, -d - 0.05, hw + 0.05, H + 0.55, -d + 0.15, pc);
      tr.box(-hw - 0.05, H, -d, -hw + 0.15, H + 0.55, 0, pc);
      tr.box(hw - 0.15, H, -d, hw + 0.05, H + 0.55, 0, pc);
      tr.box(hw - 2.2, H, -d + 1.0, hw - 0.9, H + 1.2, -d + 2.2, col(0xd9dad6));
    }
    // 一楼上面的小瓦檐（庇）
    if (b.hisashi) {
      const yb = GH - 0.05;
      slab([v3(-hw - 0.05, yb - 0.3, 0.95), v3(hw + 0.05, yb - 0.3, 0.95), v3(hw + 0.05, yb + 0.12, 0), v3(-hw - 0.05, yb + 0.12, 0)], 0.08);
      if (!lod) runAlong('eave_tiles', v3(0, yb - 0.3, 0.95), w + 0.1, Z_POS, Math.atan2(0.42, 0.95));
    }
    // 二楼阳台：木地板 + 木栏杆（竖条）
    if (b.balcony) {
      const [i0, i1] = b.balcony;
      const xa = -hw + i0 * bw + 0.05;
      const xb = -hw + i1 * bw - 0.05;
      const yb = GH;
      const dd = 0.95;
      wd.box(xa, yb - 0.12, 0, xb, yb, dd, WOOD, 1);
      wd.box(xa, yb + 0.92, dd - 0.06, xb, yb + 1.0, dd, WOOD, 1);
      wd.box(xa, yb + 0.05, dd - 0.05, xb, yb + 0.1, dd - 0.01, WOOD, 1);
      for (const x of [xa, xb - 0.06]) wd.box(x, yb, 0, x + 0.06, yb + 1.0, dd, WOOD, 1);
      for (let x = xa + 0.12; x < xb - 0.06; x += 0.13) wd.box(x, yb + 0.1, dd - 0.045, x + 0.035, yb + 0.92, dd - 0.015, WOOD, 1);
    }
    // 布遮阳篷：从墙上斜着伸出来，前面一圈垂边，两头三角形的侧片
    if (b.awning != null) {
      const ac = col(b.awning);
      const top = GH - 0.12;
      const low = GH - 0.72;
      const out = 1.6;
      const xa = -hw + 0.15;
      const xb = hw - 0.15;
      fb.quad(v3(xa, low, out), v3(xb, low, out), v3(xb, top, 0), v3(xa, top, 0), [0, 0, 1, 1], ac);
      fb.quad(v3(xa, low - 0.28, out), v3(xb, low - 0.28, out), v3(xb, low, out), v3(xa, low, out), [0, 0, 1, 1], ac.clone().multiplyScalar(0.85));
      fb.poly([v3(xb, top, 0), v3(xb, low, out), v3(xb, low - 0.28, out), v3(xb, top - 0.2, 0)], [[0, 0], [0, 0], [0, 0], [0, 0]], ac.clone().multiplyScalar(0.8));
      fb.poly([v3(xa, top - 0.2, 0), v3(xa, low - 0.28, out), v3(xa, low, out), v3(xa, top, 0)], [[0, 0], [0, 0], [0, 0], [0, 0]], ac.clone().multiplyScalar(0.8));
      // 支架（两根细铁杆）
      for (const x of [xa + 0.1, xb - 0.1]) {
        mt.setTransform(tmpM.copy(M).multiply(new THREE.Matrix4().makeTranslation(x, (top + low) / 2 - 0.05, out / 2).multiply(new THREE.Matrix4().makeRotationX(Math.atan2(top - low, out)))));
        mt.box(-0.015, -0.015, -out / 2, 0.015, 0.015, out / 2, IRON);
      }
      mt.setTransform(M);
    }
    // 横招牌：一楼上方（有瓦檐的立在瓦檐后面，二楼窗台下面）
    if (b.sign != null) {
      const [u0, v0, u1, v1] = signUV(b.sign);
      const sw = Math.min(w - 0.6, 3.6);
      const sy = b.hisashi ? GH + 0.12 : GH - 0.72;
      const z = b.hisashi ? 0.06 : 0.04;
      signs.quad(v3(-sw / 2, sy, z), v3(sw / 2, sy, z), v3(sw / 2, sy + sw / 4, z), v3(-sw / 2, sy + sw / 4, z), [u0, v0, u1, v1], WHITE);
      wd.box(-sw / 2 - 0.04, sy - 0.04, 0, sw / 2 + 0.04, sy + sw / 4 + 0.04, z - 0.01, WOOD, 1);
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
    if (b.hero) heroPlace.push({ id: b.hero, M, rooms: floorRooms, b, w, d });
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
  // 她身边那 8 栋（咖啡店、陶器店、住家、土特产店、三层小楼、居酒屋、身后的花店和住家）：规格在 kit/heroSpecs.json
  // （Blender 的 hero_buildings.py 照着整栋精建，这里照着摆；building() 还是走一遍：随机数的用法不能变，招牌的字、旗子、碰撞体也在那里）
  const hex = (c: string | undefined) => (c == null ? undefined : parseInt(c.slice(1), 16));
  const cellOf = (n: string) => F[n as keyof typeof F];
  const near: BuildingSpec[] = HERO.buildings.map((h) => {
    const x = h as typeof h & { pitch?: number; hisashi?: boolean; balcony?: number[]; awning?: string; sign?: number; banner?: number[]; solid?: boolean; interior?: boolean };
    return {
      s: S0 + x.s,
      w: x.w,
      depth: x.depth,
      ground: x.ground.map(cellOf),
      upper: x.upper.map((row) => row.map(cellOf)),
      tint: hex(x.tint)!,
      roof: x.roof as RoofType,
      roofTint: hex(x.roofTint)!,
      pitch: x.pitch,
      hisashi: x.hisashi,
      balcony: x.balcony as [number, number] | undefined,
      awning: hex(x.awning),
      sign: x.sign,
      banner: x.banner as [number, number] | undefined,
      solid: x.solid,
      interior: x.interior,
      hero: x.id,
    };
  });
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
  /** 她身边那家咖啡店（一楼是真的 3D 店内，模型到了再摆，见后面的 buildCafeInterior） */
  let heroCafe: { M: THREE.Matrix4; w: number; d: number; door: [number, number] } | null = null;
  for (const b of specs) {
    const built = building(b);
    if (b.interior) {
      const doorBay = b.ground.indexOf(F.CAFE_DOOR);
      const bw = built.w / b.ground.length;
      heroCafe = { M: built.M, w: built.w, d: built.d, door: [-built.w / 2 + doorBay * bw, -built.w / 2 + (doorBay + 1) * bw] };
      // 咖啡店的大玻璃窗透出来的暖光：照在门口的人行道上，也照在她身上（离她最近的光源，第 1 档的真实点光源）
      for (const x of [-4.4, 0, 4.4]) {
        light({ pos: v3(x, 1.6, 1.0).applyMatrix4(built.M), color: 0xffcf96, intensity: 7, radius: 9, glow: 0, hours: [7, 23], onAt: 0.05 });
      }
    }
  }

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
  /** 店门口木头家具的木纹（公园那张旧木板，调亮一点）：Blender 模型的 wood 槽用，uv 按米（1.8m 一张） */
  const planks = (() => {
    const tl = new THREE.TextureLoader();
    const t = (file: string, color = false) => {
      const x = keep(tl.load(`${BASE}textures/weathered_brown_planks/${file}`));
      if (color) x.colorSpace = THREE.SRGBColorSpace;
      x.wrapS = x.wrapT = THREE.RepeatWrapping;
      x.repeat.setScalar(1 / 1.8);
      return x;
    };
    const m = keep(new THREE.MeshStandardMaterial({ map: t('diffuse.jpg', true), normalMap: t('nor_gl.jpg'), roughness: 0.85, vertexColors: true }));
    m.color.setScalar(1.35);
    return m;
  })();
  /** 人行道上 s 处、离中线 d 的一个局部坐标系：x 沿路往远处，z 朝着路（左边人行道上的东西用） */
  const frameAt = (s: number, d: number, y = KERB_H, face: 1 | -1 = 1) => {
    const a = at(s);
    const p = a.p.clone().addScaledVector(a.l, d);
    const z = a.l.clone().multiplyScalar(-face);
    return new THREE.Matrix4().makeRotationY(Math.atan2(z.x, z.z)).setPosition(p.x, y, p.z);
  };
  const plantSpots: Array<{ s: number; d: number; h: number; variant: number }> = [];
  /** 小黑板的黑板面（canvas 画的），Blender 模型的 board 槽用 */
  const boardMat = keep(new THREE.MeshStandardMaterial({ map: keep(chalkboard()), roughness: 0.9 }));
  {
    // 立式小黑板（A 字形，两面都是黑板）：黑板面朝着往远处看的方向（她身后往远处看，正好是正面；从身后看是另一面）
    place('board', [frameAt(S0 + 8.6, FRONT - 1.7).multiply(new THREE.Matrix4().makeRotationY(-Math.PI / 2 - 0.35))]);
    // 长凳（靠着咖啡店的窗）
    place('bench', [frameAt(S0 + 2.2, FRONT - 0.45)]);
    // 花箱：咖啡店两头各一个大的、陶器店门口一个小的，里面种灌木
    place('planter_l', [frameAt(S0 - 2.6, FRONT - 0.55), frameAt(S0 + 6.9, FRONT - 0.55)]);
    plantSpots.push({ s: S0 - 2.6, d: FRONT - 0.55, h: 0.95, variant: 0 }, { s: S0 + 6.9, d: FRONT - 0.55, h: 0.95, variant: 0 });
    place('planter_s', [frameAt(S0 + 11.3, FRONT - 0.4)]);
    plantSpots.push({ s: S0 + 11.3, d: FRONT - 0.4, h: 0.8, variant: 1 });
    // 自动售货机：立在住家和土特产店之间的缝里，面朝街（灯箱一直亮着，夜里照亮脚下的人行道 —— 光源标在模型里）
    place('vending', [frameAt(S0 + 24.6, FRONT - 0.45)]);
  }
  /** 路边插的布旗：一根细杆、顶上一根横杆，旗面朝着街的方向（d 在哪边人行道上） */
  const noboriAt: THREE.Matrix4[] = [];
  const nobori = (s: number, d: number, idx: number) => {
    const M = frameAt(s, d, KERB_H);
    const p = new THREE.Vector3().setFromMatrixPosition(M);
    if (inHeadCorridor(p)) return;
    noboriAt.push(M);
    hangingBanner(M, 0, idx, 2.5, -0.05, 0.6);
  };
  nobori(S0 + 27.2, FRONT - 1.9, 3);
  nobori(S0 + 31.4, FRONT - 1.9, 5);
  nobori(S0 - 9.8, FRONT - 1.9, 5);
  // 旗杆和注水底座是 Blender 做的
  place('nobori', noboriAt);

  // ---- 电线杆 + 电线 ----
  // 杆子、变压器、杆上的小路灯是 Blender 做的（模型到了再摆，见后面的 loadKit）；电线挂在模型里标的绝缘子上，也等模型到了再画
  interface PoleSpot {
    M: THREE.Matrix4;
    p: THREE.Vector3;
    s: number;
    /** 引到房子墙上的入户线的另一头（没有就是 null） */
    drop: THREE.Vector3 | null;
  }
  const poleSpots: PoleSpot[] = [];
  /** 电线杆的混凝土（Blender 模型的 concrete 槽） */
  const poleConcrete = concreteMaterial(keep, 'plain');
  {
    for (let s = S0 - 438; s < S0 + 330; s += 28) {
      // 咖啡店和陶器店之间那根（插画左边那根）；别的按间距
      const ss = Math.abs(s - (S0 + 10)) < 14 ? S0 + 10.2 : s;
      const d = FRONT - 0.5;
      const a = at(ss);
      const p = a.p.clone().addScaledVector(a.l, d);
      if (inHeadCorridor(p)) continue;
      const M = new THREE.Matrix4().makeRotationY(Math.atan2(a.l.x, a.l.z)).setPosition(p.x, KERB_H, p.z);
      // 引到房子墙上的入户线（随机数的用法和原来一样，不打乱后面的布局）
      let drop: THREE.Vector3 | null = null;
      if (r() < 0.6 && Math.abs(ss - S0) < 300) drop = pt(ss + (r() - 0.5) * 6, FRONT + 0.05, 5.4);
      poleSpots.push({ M, p, s: ss, drop });
    }
    place('pole', poleSpots.map((q) => q.M));
    // 隔一根挂一个变压器；近处（前后 300m）的杆子都有一盏小路灯（防犯灯，陆地那一侧夜里也有灯）
    place('transformer', poleSpots.filter((_, i) => i % 2 === 0).map((q) => q.M));
    place('pole_lamp', poleSpots.filter((q) => Math.abs(q.s - S0) < 300).map((q) => q.M));
    // 近处的电线杆挡镜头
    for (const q of poleSpots) {
      if (q.p.length() > 14) continue;
      const g = new THREE.CylinderGeometry(0.25, 0.25, 11, 8);
      g.translate(0, 5.5, 0);
      collider(g, new THREE.Matrix4().makeTranslation(q.p.x, 0, q.p.z));
    }
  }
  /** 电线：相邻两根杆子之间三根电线、一根电话线（挂点按模型里标的 wire0..2、tel），入户线从 drop 拉到墙上 */
  const buildWires = (pole: KitItem | undefined) => {
    if (!pole) return;
    const mk = (n: string) => pole.marks.find((m) => m.name.startsWith(n))?.pos;
    const tops = [mk('wire0'), mk('wire1'), mk('wire2')];
    const tel = mk('tel');
    const drop = mk('drop');
    const wires: number[] = [];
    for (let i = 0; i + 1 < poleSpots.length; i++) {
      const a = poleSpots[i];
      const b = poleSpots[i + 1];
      if (a.p.distanceTo(b.p) > 45) continue;
      for (const t of tops) if (t) sag(wires, t.clone().applyMatrix4(a.M), t.clone().applyMatrix4(b.M), 0.55);
      if (tel) sag(wires, tel.clone().applyMatrix4(a.M), tel.clone().applyMatrix4(b.M), 0.7);
    }
    if (drop) for (const q of poleSpots) if (q.drop) sag(wires, drop.clone().applyMatrix4(q.M), q.drop, 0.25);
    const wg = keep(new THREE.BufferGeometry());
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    const lines = new THREE.LineSegments(wg, keep(new THREE.LineBasicMaterial({ color: 0x2a2c31 })));
    lines.name = 'wires';
    group.add(lines);
  };
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
    if (m.empty) return null;
    const mesh = new THREE.Mesh(keep(m.build()), mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.name = name;
    group.add(mesh);
    return mesh;
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
  /** 树叶透光乘多少（太阳的亮度）、树叶的材质（按时间调自发光） */
  const leafLight = { value: 1 };
  let leafMats: THREE.MeshPhongMaterial[] = [];
  const TREE_VARIANTS = [
    { preset: 'Ash Medium', seed: 37, height: 8.5, leaves: 1.4 },
    { preset: 'Oak Medium', seed: 41, height: 7.5, leaves: 1.4 },
    { preset: 'Oak Medium', seed: 53, height: 6.5, leaves: 1.2 },
    { preset: 'Bush 1', seed: 61, height: 1.0, leaves: 1 },
    { preset: 'Bush 1', seed: 67, height: 0.85, leaves: 1 },
  ] as const;
  void import('@dgreenheck/ez-tree').then(({ Tree }) => {
    if (disposed) return;
    const make = createTreeMaker(Tree, { wind, sunDir: SUN_DIR, keep, leafTint: LEAF_TINT, leafLight });
    leafMats = make.leaves;
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

  // ---- 路灯（Blender 做的海边复古柱灯），灯杆上挂旗 ----
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
  // 路灯本身：Blender 做的海边复古柱灯（灯罩夜里发光，光源标在模型里）
  place(
    'lamp',
    lampSpots.map(({ p, l }) => new THREE.Matrix4().makeRotationY(Math.atan2(l.x, l.z) + Math.PI / 2).setPosition(p.x, KERB_H, p.z)),
  );
  // ---- 街道设施的模型到了：按材质槽合批（每个槽一次绘制、自带剔除和投影），登记光源，画电线 ----
  const kitMat = kitMaterials(keep, { metal: metalMat, wood: planks, concrete: poleConcrete, board: boardMat }, kitNight);
  void loadKit(`${BASE}models/street/props.glb`, keep).then((kit) => {
    if (disposed) return;
    for (const { name, at: list, shadow } of kitPlace) {
      const item = kit.get(name);
      if (!item) continue;
      for (const part of item.parts) batch(part.geo, kitMat(part.slot), list.map((m) => m.clone().multiply(part.local)), shadow && part.slot !== 'glass' ? {} : null);
      for (const mark of item.marks) if (mark.name.startsWith('light')) for (const m of list) nightLights.add(kitLight(mark, m));
    }
    buildWires(kit.get('pole'));
  });
  // ---- 房子的构件（scripts/blender/building_kit.py → models/building_kit/kit.glb）：模型到了按记录拼进几个大网格 ----
  const buildingGlowMat = buildingGlowMaterial(keep, { uLights: night.uLights, uHour: night.uHour, uGlowGain: { value: 0.85 } });
  const bakeBuildings = (kit: Map<string, KitItem>) => {
    // 近处（精细的构件）、远处（简化的）各一套网格：远处的不投影 —— 合成一整块的网格，阴影那一趟会把整块再画一遍，
    // 远处的房子本来也在阴影范围（±22m）外面
    const meshers = () => ({
      wood: new Mesher(),
      metal: new Mesher(),
      paint: new Mesher(),
      fabric: new Mesher(),
      tile: new Mesher(),
      concrete: new Mesher(),
      glow: new Mesher({ ext: true }),
      clear: new Mesher(),
    });
    const sets = [meshers(), meshers()];
    const panes = new GlassMesher();
    const at = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    for (const r of kitBays) {
      const item = (r.lod ? kit.get(`${r.name}_lod1`) : undefined) ?? kit.get(r.name);
      if (!item) continue;
      world.multiplyMatrices(r.M, r.frame);
      const ms = sets[r.lod];
      for (const part of item.parts) {
        at.multiplyMatrices(r.cell, part.local);
        const slot = part.slot;
        if (slot === 'pane') {
          if (r.clear) ms.clear.setTransform(world).addGeometry(part.geo, at);
          else if (r.room) panes.setTransform(r.M).addGeometry(part.geo, r.frame, at, r.room, r.rect);
        } else if (slot === 'frost' || slot === 'glow') {
          ms.glow.setTransform(world).addGeometry(part.geo, at, undefined, [r.onAt, r.glow[0], r.glow[1]]);
        } else {
          const m = ms[slot as keyof typeof ms] ?? ms.paint;
          m.setTransform(world).addGeometry(part.geo, at, slot === 'tile' ? r.tint : undefined);
        }
      }
      // 构件里标的光源（店里透出来的光、门灯、灯笼）：光源只标在精细那一档里
      if (r.lights) {
        const full = kit.get(r.name);
        if (full) for (const mark of full.marks) if (mark.name.startsWith('light')) nightLights.add(kitLight(mark, world.clone().multiply(r.cell)));
      }
    }
    const add = (m: Mesher, mat: THREE.Material, name: string, cast = true) => {
      if (m.empty) return;
      const mesh = new THREE.Mesh(keep(m.build()), mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.name = name;
      group.add(mesh);
    };
    sets.forEach((ms, lodIdx) => {
      const cast = lodIdx === 0;
      const tag = lodIdx === 0 ? 'kit' : 'kit-far';
      add(ms.wood, woodMat, `${tag}-wood`, cast);
      add(ms.metal, metalMat, `${tag}-metal`, cast);
      add(ms.paint, trimMat, `${tag}-paint`, cast);
      add(ms.fabric, fabricMat, `${tag}-fabric`, cast);
      add(ms.tile, roofMat, `${tag}-tiles`, cast);
      add(ms.concrete, poleConcrete, `${tag}-concrete`, cast);
      add(ms.glow, buildingGlowMat, `${tag}-glow`, cast);
      add(ms.clear, clearGlassMat, `${tag}-glass-clear`, false);
    });
    if (!panes.empty) {
      const gm = new THREE.Mesh(keep(panes.build()), interiorGlassMat);
      gm.receiveShadow = true;
      gm.name = 'kit-glass';
      group.add(gm);
    }
  };
  void loadKit(`${BASE}models/building_kit/kit.glb`, keep).then((kit) => {
    if (!disposed) bakeBuildings(kit);
  });
  // 她身边那家咖啡店的店内（真的 3D，透过一楼的透明玻璃看得到）
  const ppCache = new Map<string, Promise<THREE.Object3D | null>>();
  const loadPP = (file: string) => {
    let p = ppCache.get(file);
    if (!p) {
      p = loader
        .loadAsync(`${BASE}polypizza/${file}.glb`)
        .then((gltf) => {
          own(gltf.scene);
          return disposed ? null : gltf.scene;
        })
        .catch(() => null);
      ppCache.set(file, p);
    }
    return p.then((src) => (disposed ? null : src));
  };
  const interiorLights: THREE.Light[] = [];
  if (heroCafe) {
    const { lights } = buildCafeInterior({ group, keep, M: heroCafe.M, w: heroCafe.w, d: heroCafe.d, floorY: 0.25, ceilY: 3.12, load: loadPP, door: heroCafe.door });
    interiorLights.push(...lights);
  }
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

  const facadeMesh = finish(facade, facadeMat, 'facades');
  // 墙挖了洞（窗、店门）：投影也要挖，阳光才照得进店里
  if (facadeMesh) facadeMesh.customDepthMaterial = facadeDepthMaterial(keep, holes);
  if (!glassI.empty) {
    const gm = new THREE.Mesh(keep(glassI.build()), interiorGlassMat);
    gm.receiveShadow = true;
    gm.name = 'glass-interior';
    group.add(gm);
  }
  finish(glassC, clearGlassMat, 'glass-clear', false);
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

  // ---- 按时间变的灯光（舞台每帧照着 lighting 设主光、补光、轮廓光、半球光、环境光，见 common.ts 的 LiveLighting）----
  const fog = new THREE.Fog(HAZE, 100, 2800);
  const lighting: LiveLighting = {
    sun: { color: new THREE.Color(0xfff3e0), intensity: 2.5, position: new THREE.Vector3(...SUN_POS), shadow: 1 },
    fill: { color: new THREE.Color(0xdfe8ff), intensity: 0.3 },
    rim: { color: new THREE.Color(0xffe9d6), intensity: 0.4 },
    hemisphere: { sky: new THREE.Color(0xdcecff), ground: new THREE.Color(0x8f8a84), intensity: 0.5 },
    environmentIntensity: 0.35,
    envScene,
    envVersion: 0,
  };
  const pal = createPalette();
  const mapping = createSkyMapping(SUN_POS);
  const sunW = new THREE.Vector3();
  const moonW = new THREE.Vector3();
  const keyDir = new THREE.Vector3();
  const glintDir = new THREE.Vector3();
  const MOON_COL = new THREE.Color(0xb4c4ec);
  const wu = water.uniforms;
  let envSig = '';
  let lastHours = -1;
  /** 街道的材质加上轻量灯（第 2 档）：新载入的模型（路灯、盆栽、树……）隔一会儿补一遍。远景（反射层）、店里不加 */
  const lampDone = new WeakSet<THREE.Material>();
  const noLamps = new Set<THREE.Material>([interiorGlassMat, clearGlassMat]);
  let lampScan = 0;
  const litAll = () => {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.layers.isEnabled(REFLECT_LAYER) || mesh === nightLights.glow) return;
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (p.name === 'cafe-interior') return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (lampDone.has(m) || noLamps.has(m)) continue;
        if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(m as THREE.MeshPhongMaterial).isMeshPhongMaterial && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial) continue;
        lampDone.add(m);
        lampLit(m, nightLights.uniforms);
        m.needsUpdate = true;
      }
    });
  };
  litAll();
  /** 渔船的航行灯（模型载入以后按顶点色找：桅顶最高处白灯、绿的右舷灯、和它一样高的红的左舷灯；第 5 期重建时由模型标出来） */
  let boatLights = false;
  const findBoatLights = () => {
    const boat0 = boats.group.children[0];
    if (!boat0) return;
    boatLights = true;
    let mesh: THREE.Mesh | null = null;
    boat0.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh;
    });
    if (!mesh) return;
    const g = (mesh as THREE.Mesh).geometry;
    const pos = g.attributes.position;
    const colA = g.attributes.color;
    if (!colA) return;
    const top = new THREE.Vector3(0, -1e9, 0);
    const green = new THREE.Vector3();
    const red: THREE.Vector3[] = [];
    let ng = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y > top.y) top.copy(v);
      const r = colA.getX(i);
      const gg = colA.getY(i);
      const bb = colA.getZ(i);
      if (gg > 0.25 && r < 0.15 && bb < 0.35) {
        green.add(v);
        ng++;
      } else if (r > 0.35 && gg < 0.12 && bb < 0.12) red.push(v.clone());
    }
    if (!ng) return;
    green.divideScalar(ng);
    const port = red.filter((p) => Math.abs(p.y - green.y) < 0.25 && Math.abs(p.x - green.x) < 0.6);
    const portC = port.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(Math.max(1, port.length));
    top.y -= 0.05;
    for (const b of boats.group.children) {
      light({ pos: top.clone(), follow: b, color: 0xfff6e8, intensity: 0, radius: 0, glow: 1.6, glowGain: 1.6, onAt: 0.2 });
      light({ pos: green.clone(), follow: b, color: 0x40ff70, intensity: 0, radius: 0, glow: 1.1, glowGain: 1.4, onAt: 0.2 });
      if (port.length) light({ pos: portC.clone(), follow: b, color: 0xff3a30, intensity: 0, radius: 0, glow: 1.1, glowGain: 1.4, onAt: 0.2 });
    }
  };

  let time = 0;
  return {
    group,
    // 4 盏真实点光源（夜里分给离她最近的灯）+ 咖啡店里的一盏暖光
    lights: [...nightLights.real, ...interiorLights],
    colliders,
    // 下面几样是刚换上这个背景那一刻的值；之后每帧由 lighting 按时间盖掉
    hemisphere: { sky: 0xdcecff, ground: 0x8f8a84, intensity: 0.5 },
    // 雾只管远景：100m 以内不受影响，对岸的小镇（1km）淡三成，山再淡一层，和地平线同色（颜色按时间变）
    fog,
    shadowBounds: 3,
    sun: { color: 0xfff3e0, intensity: 2.5, bounds: 22, position: SUN_POS, fill: 0.3, rim: 0.4 },
    lighting,
    far: SKY_R + 200,
    // 不设像素预算：满屏逐像素算光的只有右上角那点树叶，GPU 每帧 2~4ms（同样 340 万像素下公园要 8ms），
    // 留着 Retina 的满分辨率，旗子和招牌上的字更清楚
    update(dt: number, t: TimeState) {
      time += dt;
      wind.uTime.value = time;
      water.update(time);
      boats.update(time);
      gulls.update(time);
      if (!boatLights) findBoatLights();
      if ((lampScan -= dt) <= 0) {
        lampScan = 0.5;
        litAll();
      }

      // ---- 时间 → 颜色、方向 ----
      const elev = t.sunElev;
      samplePalette(elev, pal);
      morningTint(pal, t.hours, elev);
      mapping.sun(t, sunW);
      mapping.moon(t, moonW);
      const moonElev = Math.asin(moonW.y) / (Math.PI / 180);
      const illum = moonIllum(t.moonPhase);
      /** 天黑了多少（开灯）：太阳 +4° 开始，-5° 全开 */
      const lightsOn = smoothstep(4, -5, elev);
      // 主光：太阳还在天上就是太阳；落下去以后换成月亮（光照方向按月亮的方位、但抬高到 30° 以上 ——
      // 月亮挂得很低，真按它的高度打光，整条街的影子都拖得老长）。换灯的那一下亮度、影子都淡到 0
      const w = smoothstep(-3, 1, elev);
      if (w >= 0.5) {
        keyDir.copy(sunW);
        lighting.sun.color.copy(pal.sunCol);
        lighting.sun.intensity = pal.sunI * smoothstep(0.5, 1, w);
        lighting.sun.shadow = smoothstep(0.5, 0.9, w);
      } else {
        dirOf(Math.atan2(moonW.z, moonW.x) / (Math.PI / 180), Math.max(moonElev, 32), keyDir);
        const k = smoothstep(0.5, 1, 1 - w);
        lighting.sun.color.copy(MOON_COL);
        lighting.sun.intensity = (0.12 + 0.12 * illum) * k;
        lighting.sun.shadow = 0.5 * k;
      }
      SUN_DIR.copy(keyDir);
      lighting.sun.position.copy(keyDir).multiplyScalar(3.2);
      lighting.fill.color.copy(pal.fillCol);
      lighting.fill.intensity = pal.fillI;
      lighting.rim.color.copy(pal.rimCol);
      lighting.rim.intensity = pal.rimI;
      lighting.hemisphere.sky.copy(pal.hemiSky);
      lighting.hemisphere.ground.copy(pal.hemiGround);
      lighting.hemisphere.intensity = pal.hemiI;
      lighting.environmentIntensity = pal.env;

      // 天空
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
      skyU.uTime.value = time;
      skyU.uHdriMix.value = hdriReady ? pal.hdri : 0;
      skyU.uHdriTint.value.copy(pal.cloud);
      skyU.uGround.value.copy(pal.ground);
      skyU.uTownGlow.value = lightsOn * 0.05;
      // 环境贴图：太阳高度每变 0.25° 重烘一次（切时段的 3 秒里舞台限到 10 次 / 秒）
      const sig = `${Math.round(elev * 4)}|${hdriReady}|${Math.round(t.moonPhase * 20)}|${Math.round(moonElev)}`;
      if (sig !== envSig) {
        envSig = sig;
        lighting.envVersion++;
      }
      fog.color.copy(pal.fog);
      for (const m of cloudMats) m.color.copy(pal.cloud);
      (farTown.material as THREE.MeshLambertMaterial).emissiveIntensity = pal.town;

      // 海：颜色、浪花；高光白天按太阳（离地最多 18°，原来那条光带），夜里按月亮（碎光宽一些、暗一些）
      wu.uDeep.value.copy(pal.deep);
      wu.uShallow.value.copy(pal.shallow);
      wu.uScatter.value.copy(pal.scatter);
      wu.uFoam.value = pal.foam;
      wu.uStretch.value = lightsOn;
      if (w >= 0.5) {
        glintDir.copy(sunW).setY(0).normalize().multiplyScalar(Math.cos(Math.min(elev, 18) * (Math.PI / 180)));
        glintDir.y = Math.sin(Math.min(elev, 18) * (Math.PI / 180));
        wu.uSunDir.value.copy(glintDir);
        wu.uSunColor.value.copy(pal.sunCol).multiplyScalar(pal.sunI / 2.5);
        wu.uGlint.value.set(900, 30, 90, 0.35);
      } else {
        wu.uSunDir.value.copy(moonW);
        wu.uSunColor.value.copy(MOON_COL).multiplyScalar(0.55 * illum * skyU.uMoon.value);
        wu.uGlint.value.set(260, 14, 28, 0.3);
      }
      gulls.group.visible = elev > -3;

      // 窗里的店内、树叶、立面上画的灯（暖帘、灯笼、售货机）、店里的灯
      night.uLights.value = lightsOn;
      night.uHour.value = t.hours;
      leafLight.value = pal.leaf;
      for (const m of leafMats) m.emissiveIntensity = 0.3 * pal.leafE;
      facadeMat.emissiveIntensity = 0.85 + 0.5 * lightsOn;
      for (const l of interiorLights) l.intensity = 7 * (1 + 0.8 * lightsOn);
      kitNight.uBoxGain.value = 0.6 + 0.5 * lightsOn;
      // 灯：时间是一下跳过去的（截图、刚打开）就不闪
      let dh = Math.abs(t.hours - lastHours);
      if (dh > 12) dh = 24 - dh;
      const jump = lastHours < 0 || dh > 0.25;
      lastHours = t.hours;
      nightLights.update(lightsOn, t.hours, time, dt, jump);
      lighthouse.update(time, lightsOn);
    },
    beforeRender(view, shadow, camera, size) {
      // 海面反射那一趟嵌套渲染也会走到这里：镜像相机只画远景那一层，合批的树不用按它剔除（剔了主画面的树会闪）
      if (water.reflecting) return;
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) nightLights.setPixel((camera as THREE.PerspectiveCamera).fov, size.y);
      cull(view, shadow);
    },
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose();
    },
  };
}
