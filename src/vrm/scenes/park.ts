import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture, rng, type Backdrop } from './common';

/**
 * 背景场景：城市公园里的木栈道（照着一张实拍的公园照片搭的）。和咖啡店一样全部程序生成，
 * 没有外部模型、贴图和 HDRI —— 写实素材和动漫角色放在一起很突兀（咖啡店试过），
 * 树叶、草地、木板都是 canvas 画的平涂风格。
 *
 * 坐标和舞台一致：角色站在原点、面朝 +Z，主相机在 +Z 方向往 -Z 看，所以半身景别里看到的是她身后：
 *   脚下        一块木平台（木板横铺），身边有一个树桩凳、一张石板长凳，平台上落着黄叶
 *   身后（-Z）  木栈道从平台后沿出发，先往左、再往右弯着伸进远处；两边是草坪（离路远的地方微微隆起，
 *              左边是个缓坡），石头、圆灌木、一丛红叶灌木、一棵云片造型的罗汉松，几盏欧式路灯（最近那盏是灰色的）
 *   四周        几十棵大树，树冠很密，阳光从左后方斜着照下来，树冠在路面和草地上投出斑驳的光影
 *   左（-X）    一条岔路往左边去
 *   最远处      雾里淡淡的城市楼群
 *
 * 头后面不放竖着的东西（树干、灯杆）：半身景别里，头在远处背景上的投影随距离变宽（20m 外约 3.4m 宽），
 * 树和灯都避开这条"视线走廊"，免得一根杆子从头顶长出来（咖啡店第一版就踩过：店招挂低了像光环）。
 *
 * 树冠：每棵树几团深绿的"芯"（填住缝，不透光）+ 几百片"叶片卡"（一张画了二三十片叶子的透明贴图），
 * 卡片朝外、上面的亮下面的暗；全场的叶片卡、芯各是一个 InstancedMesh（一次绘制）。
 *
 * 灯光：一盏从左后上方照下来的太阳（暖白、投软阴影，范围覆盖角色身边 ±18m —— 树冠的影子就是斑驳光影的来源），
 * 半球光换成天蓝 / 草绿，环境光（IBL）用天空球 + 草地烘出来（不用下载 HDRI）。舞台的主光照常照着角色、
 * 但不投影（太阳投），所以角色的影子朝着太阳的反方向落在平台上 —— 逆光，脸靠主光和补光打亮，和户外人像的做法一样。
 * 远处一层淡绿灰的雾，接上天空的地平线颜色。
 */

type V2 = [number, number];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- 布局 ----

/** 主栈道（从平台后沿往远处）、左边的岔路 */
const MAIN_PATH: V2[] = [
  [-0.4, -1.2],
  [-1.6, -5],
  [-0.6, -8.6],
  [2.2, -11.2],
  [3.2, -15],
  [1.4, -20],
  [-1.2, -26],
  [-2.5, -34],
  [-2, -46],
];
const BRANCH_PATH: V2[] = [
  [-2.6, -0.6],
  [-5.5, -1.6],
  [-8.5, -4],
  [-12, -5],
  [-16, -4.4],
  [-21, -6],
  [-28, -5],
];
const PATH_W = 2.3;
/** 角色脚下的平台 */
const DECK = { x0: -3.2, x1: 2.8, z0: -2.2, z1: 2.2 };
/** 平台、栈道的面高（地面在 -0.1） */
const DECK_Y = 0;

/** 主相机（舞台的默认机位）z，用来算"头后面的视线走廊" */
const CAM_Z = 1.58;

const curveOf = (pts: V2[]) =>
  new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, DECK_Y, z)),
    false,
    'centripetal',
  );

// ---- 贴图 ----

/** 木板：横着一条条，8 条一张，有缝、木纹、接缝和钉子，颜色偏旧、几条带点红 */
function planks(seed: number, repeat?: [number, number]) {
  const r = rng(seed);
  return canvasTexture(
    512,
    512,
    (g) => {
      const ph = 64;
      for (let i = 0; i < 8; i++) {
        const y = i * ph;
        const red = r() < 0.3;
        const l = 34 + r() * 14;
        g.fillStyle = red ? `hsl(${10 + r() * 8}, ${28 + r() * 10}%, ${l - 4}%)` : `hsl(${24 + r() * 8}, ${16 + r() * 14}%, ${l}%)`;
        g.fillRect(0, y, 512, ph);
        // 木纹
        for (let k = 0; k < 9; k++) {
          const yy = y + 4 + r() * (ph - 8);
          g.strokeStyle = `rgba(${r() < 0.5 ? '40,25,15' : '255,235,210'},${0.08 + r() * 0.1})`;
          g.lineWidth = 0.8 + r() * 1.2;
          g.beginPath();
          g.moveTo(0, yy);
          g.bezierCurveTo(170, yy + r() * 4 - 2, 340, yy + r() * 4 - 2, 512, yy);
          g.stroke();
        }
        // 风化的浅色斑
        for (let k = 0; k < 14; k++) {
          g.fillStyle = `rgba(230,220,200,${0.04 + r() * 0.06})`;
          g.fillRect(r() * 512, y + r() * ph, 20 + r() * 80, 2 + r() * 5);
        }
        // 接缝 + 钉子
        const jx = r() * 512;
        g.fillStyle = 'rgba(20,12,8,0.6)';
        g.fillRect(jx, y, 2, ph);
        g.fillStyle = 'rgba(30,30,30,0.7)';
        for (const nx of [jx - 10, jx + 10]) {
          g.fillRect(nx, y + 12, 3, 3);
          g.fillRect(nx, y + ph - 15, 3, 3);
        }
        // 板缝
        g.fillStyle = 'rgba(15,10,6,0.75)';
        g.fillRect(0, y + ph - 3, 512, 3);
      }
    },
    repeat,
  );
}

/** 草地：密密的短笔触 */
function grass() {
  const r = rng(5);
  return canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#6aa443';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 9000; i++) {
        const x = r() * 512;
        const y = r() * 512;
        const len = 4 + r() * 8;
        const a = -Math.PI / 2 + (r() - 0.5) * 0.9;
        g.strokeStyle = `hsl(${80 + r() * 28}, ${40 + r() * 22}%, ${28 + r() * 28}%)`;
        g.lineWidth = 1 + r() * 0.8;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
      }
    },
    [42, 42],
  );
}

/** 树皮：竖着的深浅条纹 + 一点灰绿的地衣 */
function bark() {
  const r = rng(9);
  return canvasTexture(
    128,
    256,
    (g) => {
      g.fillStyle = '#5a4838';
      g.fillRect(0, 0, 128, 256);
      for (let i = 0; i < 70; i++) {
        const x = r() * 128;
        g.fillStyle = r() < 0.5 ? `rgba(30,20,14,${0.25 + r() * 0.3})` : `rgba(140,120,100,${0.12 + r() * 0.15})`;
        g.fillRect(x, 0, 1 + r() * 4, 256);
      }
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(${120 + r() * 40},${130 + r() * 30},${100 + r() * 20},${0.15 + r() * 0.2})`;
        g.beginPath();
        g.ellipse(r() * 128, r() * 256, 3 + r() * 8, 4 + r() * 12, 0, 0, Math.PI * 2);
        g.fill();
      }
    },
    [2, 3],
  );
}

/** 石头：灰褐色的斑点 */
function stone() {
  const r = rng(13);
  return canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#a39888';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2500; i++) {
        const v = 90 + r() * 100;
        g.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.15 + r() * 0.25})`;
        g.fillRect(r() * 256, r() * 256, 1 + r() * 4, 1 + r() * 4);
      }
    },
    [2, 2],
  );
}

/**
 * 一簇叶子（透明底）：从中间往外放射的二三十片叶子，叶脉一条亮线、下半片压暗一点。
 * 画得偏亮，颜色由每片卡片的 instanceColor 去染
 */
function leafCluster(seed: number, palette: string[], count: number, size: number) {
  const r = rng(seed);
  return canvasTexture(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 0.6) * (118 - size * 0.6);
      const cx = 128 + Math.cos(a) * d;
      const cy = 128 + Math.sin(a) * d;
      const L = size * (0.75 + r() * 0.5);
      const W = L * (0.38 + r() * 0.14);
      g.save();
      g.translate(cx, cy);
      g.rotate(a + (r() - 0.5) * 0.9);
      g.fillStyle = palette[Math.floor(r() * palette.length)];
      g.beginPath();
      g.moveTo(-L / 2, 0);
      g.quadraticCurveTo(0, -W, L / 2, 0);
      g.quadraticCurveTo(0, W, -L / 2, 0);
      g.fill();
      // 下半片暗一点
      g.fillStyle = 'rgba(0,0,0,0.13)';
      g.beginPath();
      g.moveTo(-L / 2, 0);
      g.quadraticCurveTo(0, W, L / 2, 0);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(255,255,230,0.22)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-L / 2, 0);
      g.lineTo(L / 2, 0);
      g.stroke();
      g.restore();
    }
  });
}

/** 一片落叶 */
function fallenLeaf() {
  return canvasTexture(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.translate(32, 32);
    g.rotate(-0.6);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(-26, 0);
    g.quadraticCurveTo(0, -13, 26, 0);
    g.quadraticCurveTo(0, 13, -26, 0);
    g.fill();
    g.strokeStyle = 'rgba(120,90,30,0.5)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-26, 0);
    g.lineTo(26, 0);
    g.stroke();
  });
}

const GREEN_LEAVES = ['#c6e39a', '#b4d886', '#d4eba8', '#a6cf78', '#bfe08f', '#e0f0b4'];
const RED_LEAVES = ['#c4473b', '#a9343b', '#d36a4c', '#8f2e36', '#b8503f', '#7f9a52'];

// ---- 场景 ----

interface Tree {
  x: number;
  z: number;
  /** 树冠底部的高度（主干长度） */
  h: number;
  /** 主干半径 */
  r: number;
  /** 树冠半径 */
  crown: number;
  /** 往哪边歪（x, z） */
  lean: V2;
  seed: number;
}

/** 叶片卡 / 芯的一个实例 */
interface Inst {
  m: THREE.Matrix4;
  c: THREE.Color;
}

export function createPark(): Backdrop {
  const group = new THREE.Group();
  group.name = 'park';
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const add = <T extends THREE.Mesh>(mesh: T, shadow = true) => {
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const r = rng(2026);

  const main = curveOf(MAIN_PATH);
  const branch = curveOf(BRANCH_PATH);
  // 路的采样点：算"离路多远"（放树、草地隆起都要用）
  const samples: V2[] = [];
  for (const c of [main, branch]) {
    const n = Math.ceil(c.getLength() / 0.3);
    for (const p of c.getSpacedPoints(n)) samples.push([p.x, p.z]);
  }
  const nearestPath = (x: number, z: number) => {
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    for (const [sx, sz] of samples) {
      const d = (sx - x) ** 2 + (sz - z) ** 2;
      if (d < best) {
        best = d;
        bx = sx;
        bz = sz;
      }
    }
    return { d: Math.sqrt(best), x: bx, z: bz };
  };
  const deckDist = (x: number, z: number) => {
    const dx = Math.max(DECK.x0 - x, 0, x - DECK.x1);
    const dz = Math.max(DECK.z0 - z, 0, z - DECK.z1);
    return Math.hypot(dx, dz);
  };
  /** 离路面 / 平台边缘还有多远（在路上、平台上为 ≤ 0） */
  const clearance = (x: number, z: number) => Math.min(nearestPath(x, z).d - PATH_W / 2, deckDist(x, z));
  /** 把一个点从路上 / 平台上推开，直到留出 gap 的距离 */
  const pushClear = (x: number, z: number, gap: number): V2 => {
    for (let i = 0; i < 12; i++) {
      const c = clearance(x, z);
      if (c >= gap) break;
      const np = nearestPath(x, z);
      let dx = x - np.x;
      let dz = z - np.z;
      if (deckDist(x, z) < np.d - PATH_W / 2) {
        dx = x - (DECK.x0 + DECK.x1) / 2;
        dz = z - (DECK.z0 + DECK.z1) / 2;
      }
      const l = Math.hypot(dx, dz) || 1;
      x += (dx / l) * (gap - c + 0.05);
      z += (dz / l) * (gap - c + 0.05);
    }
    return [x, z];
  };
  /** 头后面的视线走廊：竖着的东西（树干、灯杆）不进去 */
  const inHeadCorridor = (x: number, z: number) => z < 0.5 && Math.abs(x) < 0.15 * ((CAM_Z - z) / CAM_Z) + 0.6;

  /** 地面高度：路边是平的（-0.1，比木栈道低 10cm），离路越远越起伏，左边是个缓坡 */
  const groundY = (x: number, z: number, clear = clearance(x, z)) => {
    const m =
      0.22 * (1 + Math.sin(x * 0.21 + 0.5) * Math.cos(z * 0.17 - 0.3)) +
      0.12 * Math.sin(x * 0.09 - z * 0.07 + 2) +
      0.12 +
      0.9 * smoothstep(-5, -16, x) * (0.6 + 0.4 * Math.sin(z * 0.12));
    return -0.1 + m * smoothstep(1.2, 5, clear);
  };

  // ---- 材质 ----
  const woodTex = keep(planks(31));
  const deckMat = keep(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 }));
  const skirtMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 0.9, side: THREE.DoubleSide }));
  const barkMat = keep(new THREE.MeshStandardMaterial({ map: keep(bark()), roughness: 0.95 }));
  const rockMat = keep(new THREE.MeshStandardMaterial({ map: keep(stone()), roughness: 0.92 }));
  const seatMat = keep(new THREE.MeshStandardMaterial({ map: keep(planks(77, [0.4, 0.4])), color: 0xd9b48c, roughness: 0.8 }));
  const stumpMat = keep(new THREE.MeshStandardMaterial({ map: keep(planks(91, [0.3, 1])), color: 0xc9a27c, roughness: 0.85 }));
  const leafMats = {
    big: keep(
      new THREE.MeshStandardMaterial({
        map: keep(leafCluster(3, GREEN_LEAVES, 34, 34)),
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.75,
      }),
    ),
    small: keep(
      new THREE.MeshStandardMaterial({
        map: keep(leafCluster(4, GREEN_LEAVES, 70, 22)),
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.75,
      }),
    ),
    red: keep(
      new THREE.MeshStandardMaterial({
        map: keep(leafCluster(6, RED_LEAVES, 64, 22)),
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    ),
  };
  const coreMat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }));
  const cards: Record<keyof typeof leafMats, Inst[]> = { big: [], small: [], red: [] };
  const cores: Inst[] = [];

  // ---- 天空 ----
  const SKY_TOP = new THREE.Color(0x8fc1ea);
  const HORIZON = new THREE.Color(0xe3ece2);
  const skyDome = (radius: number) => {
    const g = keep(new THREE.SphereGeometry(radius, 32, 16));
    const p = g.attributes.position;
    const col: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      c.copy(HORIZON).lerp(SKY_TOP, smoothstep(0, 0.55, p.getY(i) / radius));
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  };
  const skyMat = keep(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  const sky = new THREE.Mesh(skyDome(150), skyMat);
  sky.renderOrder = -1;
  group.add(sky);

  // ---- 平台 + 栈道 ----
  {
    const w = DECK.x1 - DECK.x0;
    const d = DECK.z1 - DECK.z0;
    const top = keep(new THREE.PlaneGeometry(w, d));
    top.rotateX(-Math.PI / 2);
    top.translate((DECK.x0 + DECK.x1) / 2, DECK_Y, (DECK.z0 + DECK.z1) / 2);
    // 木板横铺（沿 x 方向），贴图按世界坐标铺：一条板 0.16m 宽、一张贴图 8 条
    const uv = top.attributes.uv;
    const pos = top.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 3, pos.getZ(i) / (0.16 * 8));
    add(new THREE.Mesh(top, deckMat), false);
    // 平台四边的边板
    const edge = (sx: number, sz: number, x: number, z: number) => {
      const m = add(new THREE.Mesh(keep(new THREE.BoxGeometry(sx, 0.2, sz)), skirtMat));
      m.position.set(x, DECK_Y - 0.1 - 0.002, z);
    };
    edge(w + 0.06, 0.06, (DECK.x0 + DECK.x1) / 2, DECK.z1);
    edge(w + 0.06, 0.06, (DECK.x0 + DECK.x1) / 2, DECK.z0);
    edge(0.06, d, DECK.x0, (DECK.z0 + DECK.z1) / 2);
    edge(0.06, d, DECK.x1, (DECK.z0 + DECK.z1) / 2);
  }
  /** 一条栈道：沿曲线铺一条带子，木板横着（垂直于路的方向），两边各一条边板 */
  const boardwalk = (curve: THREE.CatmullRomCurve3) => {
    const len = curve.getLength();
    const n = Math.ceil(len / 0.25);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const skirt: number[] = [];
    const skirtIdx: number[] = [];
    // 比平台低 2mm：和平台搭接的那一段被平台盖住，不打架
    const y = DECK_Y - 0.002;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const nx = -tan.z;
      const nz = tan.x;
      const l = Math.hypot(nx, nz) || 1;
      const ox = (nx / l) * (PATH_W / 2);
      const oz = (nz / l) * (PATH_W / 2);
      pos.push(p.x + ox, y, p.z + oz, p.x - ox, y, p.z - oz);
      const v = (t * len) / (0.16 * 8);
      uv.push(0, v, PATH_W / 3, v);
      for (const s of [1, -1]) skirt.push(p.x + s * ox, y, p.z + s * oz, p.x + s * ox, y - 0.2, p.z + s * oz);
      if (i < n) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        const b = i * 4;
        // 两条边板各自一个四边形带
        skirtIdx.push(b, b + 1, b + 4, b + 1, b + 5, b + 4, b + 2, b + 3, b + 6, b + 3, b + 7, b + 6);
      }
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // 法线朝下就翻一下绕序（曲线方向不同，左右会反）
    if (g.attributes.normal.getY(0) < 0) {
      g.setIndex(idx.map((_, k) => idx[k - (k % 3) + 2 - (k % 3)]));
      g.computeVertexNormals();
    }
    const top = add(new THREE.Mesh(g, deckMat), false);
    const sg = keep(new THREE.BufferGeometry());
    sg.setAttribute('position', new THREE.Float32BufferAttribute(skirt, 3));
    sg.setIndex(skirtIdx);
    sg.computeVertexNormals();
    add(new THREE.Mesh(sg, skirtMat), false);
    return top;
  };
  const walkMain = boardwalk(main);
  const walkBranch = boardwalk(branch);

  // ---- 树 ----
  const trees: Tree[] = [];
  const tryTree = (t: Tree, force = false) => {
    const [x, z] = pushClear(t.x, t.z, t.r + 0.6);
    if (!force && inHeadCorridor(x, z)) return false;
    if (trees.some((o) => Math.hypot(o.x - x, o.z - z) < (o.crown + t.crown) * 0.62)) return false;
    trees.push({ ...t, x, z });
    return true;
  };
  // 构图里重要的几棵（照片左边那棵老树、右边几棵细高的），再随机补满
  const hand: Array<[number, number, number, number, number, V2]> = [
    // x, z, 主干高, 主干半径, 树冠半径, 歪向
    [-4.8, -4.2, 4.2, 0.5, 5.2, [0.5, 0.1]],
    [3.9, -4.6, 5.0, 0.3, 3.8, [-0.2, -0.1]],
    [-4.4, -10.8, 4.6, 0.4, 4.4, [0.3, 0]],
    [6.3, -9.6, 5.2, 0.34, 4.0, [-0.3, 0.1]],
    [5.6, -16.5, 5.6, 0.32, 4.2, [-0.1, 0]],
    [-5.2, -17.8, 5.0, 0.42, 4.6, [0.2, 0]],
    [-5.2, 4.6, 4.4, 0.45, 4.6, [0.2, -0.3]],
    [4.6, 5.6, 4.6, 0.4, 4.2, [-0.2, -0.2]],
  ];
  for (const [x, z, h, rr, crown, lean] of hand) tryTree({ x, z, h, r: rr, crown, lean, seed: Math.floor(r() * 1e6) });
  for (let i = 0; i < 260 && trees.length < 42; i++) {
    const x = (r() - 0.5) * 96;
    const z = -58 + r() * 84;
    if (Math.hypot(x, z) < 7) continue;
    if (clearance(x, z) < 1.4 || inHeadCorridor(x, z)) continue;
    const crown = 3.2 + r() * 2.4;
    tryTree({
      x,
      z,
      h: 4 + r() * 2.2,
      r: 0.22 + r() * 0.26,
      crown,
      lean: [(r() - 0.5) * 0.6, (r() - 0.5) * 0.6],
      seed: Math.floor(r() * 1e6),
    });
  }

  const UP = new THREE.Vector3(0, 1, 0);
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  /** 主干在高度比例 u 处的中心（带弯） */
  const trunkCenter = (t: Tree, u: number, base: number) =>
    new THREE.Vector3(
      t.x + t.lean[0] * u * u * t.h * 0.3 + Math.sin(u * 4 + t.seed) * 0.06,
      base + u * t.h,
      t.z + t.lean[1] * u * u * t.h * 0.3 + Math.cos(u * 3 + t.seed) * 0.06,
    );
  const trunkGeos: THREE.BufferGeometry[] = [];
  const TREE_TINTS = [
    new THREE.Color(0.58, 0.8, 0.4),
    new THREE.Color(0.5, 0.74, 0.36),
    new THREE.Color(0.64, 0.84, 0.42),
    new THREE.Color(0.46, 0.68, 0.34),
    new THREE.Color(0.7, 0.86, 0.46),
  ];
  for (const t of trees) {
    const tr = rng(t.seed);
    const base = groundY(t.x, t.z) - 0.15;
    // 主干：一根细分的圆柱，按高度弯、根部张开
    const g = new THREE.CylinderGeometry(t.r * 0.55, t.r, t.h * 1.08, 12, 10, true);
    g.translate(0, (t.h * 1.08) / 2, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const u = y / t.h;
      const flare = 1 + 0.9 * Math.pow(Math.max(0, 1 - u / 0.16), 2.5);
      const c = trunkCenter(t, u, base);
      p.setXYZ(i, c.x + p.getX(i) * flare, c.y, c.z + p.getZ(i) * flare);
    }
    g.computeVertexNormals();
    trunkGeos.push(g);
    // 树冠：几团分叉的"瓣"，每瓣一个深色的芯 + 表面一圈叶片卡
    const top = trunkCenter(t, 1, base);
    const tint = TREE_TINTS[Math.floor(tr() * TREE_TINTS.length)];
    const lobes = 4 + Math.floor(tr() * 3);
    for (let k = 0; k < lobes; k++) {
      const a = (k / lobes) * Math.PI * 2 + tr() * 0.8;
      const off = k === 0 ? 0 : t.crown * (0.32 + tr() * 0.18);
      const center = new THREE.Vector3(
        top.x + Math.cos(a) * off,
        top.y + t.crown * (0.3 + tr() * 0.25) - (k === 0 ? 0 : t.crown * 0.08),
        top.z + Math.sin(a) * off,
      );
      const rad = new THREE.Vector3(t.crown * (0.55 + tr() * 0.15), t.crown * (0.38 + tr() * 0.12), t.crown * (0.55 + tr() * 0.15));
      // 树枝：从主干上部伸到这一瓣
      if (k > 0) {
        const from = trunkCenter(t, 0.72 + tr() * 0.2, base);
        const to = center.clone().lerp(from, 0.3);
        const dir = to.clone().sub(from);
        const blen = dir.length();
        const bg = new THREE.CylinderGeometry(t.r * 0.18, t.r * 0.32, blen, 7, 1, true);
        bg.applyQuaternion(tmpQ.setFromUnitVectors(UP, dir.normalize()));
        bg.translate(from.x + (dir.x * blen) / 2, from.y + (dir.y * blen) / 2, from.z + (dir.z * blen) / 2);
        trunkGeos.push(bg);
      }
      cores.push({
        m: new THREE.Matrix4().compose(center, tmpQ.identity(), tmpS.copy(rad).multiplyScalar(0.8)),
        c: tint.clone().multiplyScalar(0.42),
      });
      const n = Math.round(rad.x * rad.z * 6.5);
      for (let i = 0; i < n; i++) {
        // 朝外的方向，下半球少一点
        const dir = new THREE.Vector3(tr() * 2 - 1, tr() * 2 - 1, tr() * 2 - 1);
        if (dir.y < -0.2 && tr() < 0.5) dir.y = -dir.y;
        dir.normalize();
        const pos = center.clone().add(dir.clone().multiply(rad).multiplyScalar(0.82 + tr() * 0.28));
        const face = dir
          .clone()
          .add(new THREE.Vector3(tr() - 0.5, tr() - 0.5, tr() - 0.5).multiplyScalar(0.9))
          .normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), face);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tr() * Math.PI * 2));
        const s = (0.95 + tr() * 0.6) * (t.crown / 4.5);
        const light = 0.72 + 0.4 * (dir.y * 0.5 + 0.5);
        cards.big.push({
          m: new THREE.Matrix4().compose(pos, q, tmpS.set(s, s, s)),
          c: tint.clone().multiplyScalar(light * (0.92 + tr() * 0.16)),
        });
      }
    }
  }
  add(new THREE.Mesh(keep(mergeGeometries(trunkGeos)), barkMat));
  for (const g of trunkGeos) g.dispose();

  // ---- 灌木、红叶丛、罗汉松 ----
  /** 一团灌木：椭球里几瓣，每瓣一个芯 + 表面的小叶片卡 */
  const shrub = (x0: number, z0: number, rx: number, ry: number, rz: number, kind: 'small' | 'red', seed: number) => {
    const sr = rng(seed);
    const [x, z] = pushClear(x0, z0, Math.max(rx, rz) * 0.9);
    const y = groundY(x, z);
    const tint = kind === 'red' ? new THREE.Color(1, 0.92, 0.9) : TREE_TINTS[Math.floor(sr() * TREE_TINTS.length)];
    const lobes = Math.max(2, Math.round((rx + rz) * 1.6));
    for (let k = 0; k < lobes; k++) {
      const c = new THREE.Vector3(x + (sr() - 0.5) * rx * 1.1, y + ry * (0.55 + sr() * 0.3), z + (sr() - 0.5) * rz * 1.1);
      const rad = new THREE.Vector3(rx * (0.45 + sr() * 0.2), ry * (0.6 + sr() * 0.2), rz * (0.45 + sr() * 0.2));
      cores.push({
        m: new THREE.Matrix4().compose(c, tmpQ.identity(), tmpS.copy(rad).multiplyScalar(0.85)),
        c: tint.clone().multiplyScalar(kind === 'red' ? 0.3 : 0.4).add(kind === 'red' ? new THREE.Color(0.12, 0, 0) : new THREE.Color()),
      });
      const n = Math.round((rad.x * rad.z + rad.y * (rad.x + rad.z)) * 26);
      for (let i = 0; i < n; i++) {
        const dir = new THREE.Vector3(sr() * 2 - 1, Math.abs(sr() * 2 - 1) * 0.9 + 0.1, sr() * 2 - 1).normalize();
        const pos = c.clone().add(dir.clone().multiply(rad).multiplyScalar(0.85 + sr() * 0.25));
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          dir.clone().add(new THREE.Vector3(sr() - 0.5, sr() - 0.5, sr() - 0.5)).normalize(),
        );
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sr() * Math.PI * 2));
        const s = 0.42 + sr() * 0.22;
        cards[kind].push({
          m: new THREE.Matrix4().compose(pos, q, tmpS.set(s, s, s)),
          c: tint.clone().multiplyScalar((0.75 + 0.35 * (dir.y * 0.5 + 0.5)) * (0.9 + sr() * 0.2)),
        });
      }
    }
  };
  shrub(-0.6, -13.4, 1.7, 0.42, 0.65, 'red', 101);
  shrub(3.6, -7.8, 0.8, 0.55, 0.8, 'small', 102);
  shrub(4.9, -11.8, 1.0, 0.6, 0.9, 'small', 103);
  shrub(-3.4, -5.8, 0.7, 0.5, 0.7, 'small', 104);
  shrub(5.8, -3.6, 0.8, 0.55, 0.8, 'small', 105);
  shrub(-6.4, -8.0, 1.1, 0.6, 1.0, 'small', 106);
  shrub(2.6, -18.2, 2.2, 0.5, 0.8, 'small', 107);
  shrub(-3.8, 3.0, 0.9, 0.55, 0.9, 'small', 108);
  shrub(-2.8, -12.6, 0.8, 0.5, 0.8, 'small', 109);
  // 罗汉松：一根细干，四层压扁的"云片"，一层比一层小
  {
    const [x, z] = pushClear(-2.2, -15, 1);
    const y = groundY(x, z);
    const stem = new THREE.CylinderGeometry(0.06, 0.1, 2.4, 8, 1, true);
    stem.translate(x, y + 1.2, z);
    const tiers: Array<[number, number, number, number]> = [
      [1.0, 0.75, 0.25, 0],
      [1.55, 0.6, -0.2, 0.15],
      [2.0, 0.45, 0.15, -0.1],
      [2.35, 0.3, 0, 0],
    ];
    const tg: THREE.BufferGeometry[] = [stem];
    const tint = new THREE.Color(0.72, 0.88, 0.5);
    tiers.forEach(([h, rad, dx, dz], k) => {
      const c = new THREE.Vector3(x + dx, y + h, z + dz);
      cores.push({ m: new THREE.Matrix4().compose(c, tmpQ.identity(), tmpS.set(rad, rad * 0.42, rad)), c: tint.clone().multiplyScalar(0.42) });
      const n = Math.round(rad * rad * 90);
      for (let i = 0; i < n; i++) {
        const dir = new THREE.Vector3(r() * 2 - 1, (r() * 2 - 1) * 0.6, r() * 2 - 1).normalize();
        const pos = c.clone().add(new THREE.Vector3(dir.x * rad, dir.y * rad * 0.45, dir.z * rad).multiplyScalar(1.05));
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        const s = 0.32 + r() * 0.12;
        cards.small.push({ m: new THREE.Matrix4().compose(pos, q, tmpS.set(s, s, s)), c: tint.clone().multiplyScalar(0.8 + 0.3 * (dir.y * 0.5 + 0.5)) });
      }
      if (k > 0) {
        const arm = new THREE.CylinderGeometry(0.025, 0.04, Math.hypot(dx, 0.3, dz) + 0.1, 6, 1, true);
        arm.translate(x + dx / 2, y + h - 0.15, z + dz / 2);
        tg.push(arm);
      }
    });
    add(new THREE.Mesh(keep(mergeGeometries(tg)), barkMat));
    for (const g of tg) g.dispose();
  }

  // 所有叶片卡、芯：每种一个 InstancedMesh
  const cardGeo = keep(new THREE.PlaneGeometry(1, 1));
  for (const kind of ['big', 'small', 'red'] as const) {
    const list = cards[kind];
    const im = new THREE.InstancedMesh(cardGeo, leafMats[kind], list.length);
    list.forEach((it, i) => {
      im.setMatrixAt(i, it.m);
      im.setColorAt(i, it.c);
    });
    im.computeBoundingSphere();
    add(im);
  }
  {
    const g = keep(new THREE.IcosahedronGeometry(1, 1));
    const im = new THREE.InstancedMesh(g, coreMat, cores.length);
    cores.forEach((it, i) => {
      im.setMatrixAt(i, it.m);
      im.setColorAt(i, it.c);
    });
    im.computeBoundingSphere();
    add(im);
  }

  // ---- 石头 ----
  const rockGeos: THREE.BufferGeometry[] = [];
  const rocks: Array<[number, number, number]> = [
    [-2.4, -9.6, 0.55],
    [2.1, -8.4, 0.5],
    [-3.4, -3.0, 0.4],
    [4.7, -6.8, 0.6],
    [0.6, -12.3, 0.45],
    [0.4, -16.6, 0.7],
    [-3.3, -16.2, 0.5],
    [5.3, -17.6, 0.45],
    [-1.9, 3.2, 0.5],
    [3.4, -12.6, 0.4],
    [-7.2, -2.8, 0.55],
  ];
  rocks.forEach(([x0, z0, s], i) => {
    const [x, z] = pushClear(x0, z0, s * 0.9);
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position;
    const seed = i * 1.7 + 0.3;
    for (let k = 0; k < p.count; k++) {
      const vx = p.getX(k);
      const vy = p.getY(k);
      const vz = p.getZ(k);
      const d = 1 + 0.16 * Math.sin(vx * 3.1 + seed) * Math.sin(vy * 2.3 + seed * 2) + 0.08 * Math.sin(vz * 5.3 + seed * 3);
      p.setXYZ(k, vx * d, vy * d, vz * d);
    }
    g.scale(s, s * 0.62, s * 0.82);
    g.rotateY(seed * 2.1);
    g.translate(x, groundY(x, z) + s * 0.25, z);
    g.computeVertexNormals();
    rockGeos.push(g);
  });
  const rockMesh = add(new THREE.Mesh(keep(mergeGeometries(rockGeos)), rockMat));
  for (const g of rockGeos) g.dispose();

  // ---- 路灯（欧式：底座、细杆、六角玻璃灯罩、伞形顶、尖顶）----
  const lampParts = { dark: [] as THREE.BufferGeometry[], gray: [] as THREE.BufferGeometry[], glass: [] as THREE.BufferGeometry[] };
  const poles: THREE.Mesh[] = [];
  const lamp = (x0: number, z0: number, tone: 'dark' | 'gray') => {
    const [x, z] = pushClear(x0, z0, 0.35);
    const y = groundY(x, z);
    const metal = lampParts[tone];
    const at = (geo: THREE.BufferGeometry, h: number) => (geo.translate(x, y + h, z), geo);
    metal.push(at(new THREE.CylinderGeometry(0.11, 0.16, 0.36, 12), 0.18));
    metal.push(at(new THREE.CylinderGeometry(0.045, 0.06, 3.0, 10), 1.86));
    metal.push(at(new THREE.CylinderGeometry(0.08, 0.055, 0.14, 12), 3.42));
    metal.push(at(new THREE.CylinderGeometry(0.13, 0.08, 0.06, 6), 3.5));
    lampParts.glass.push(at(new THREE.CylinderGeometry(0.17, 0.13, 0.44, 6, 1, true), 3.75));
    // 灯罩的六根竖框
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      // 灯罩上宽下窄，竖框跟着往外斜一点
      const bar = new THREE.BoxGeometry(0.018, 0.46, 0.018);
      bar.rotateZ(-Math.cos(a) * 0.09);
      bar.rotateX(Math.sin(a) * 0.09);
      bar.translate(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15);
      metal.push(at(bar, 3.75));
    }
    metal.push(at(new THREE.ConeGeometry(0.25, 0.17, 6), 4.05));
    metal.push(at(new THREE.SphereGeometry(0.045, 10, 8), 4.17));
    metal.push(at(new THREE.ConeGeometry(0.025, 0.12, 8), 4.26));
    const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.08, 0.08, 4.2, 6)));
    pole.position.set(x, y + 2.1, z);
    pole.updateMatrixWorld();
    poles.push(pole);
  };
  lamp(2.3, -2.7, 'gray');
  lamp(-3.1, -7.4, 'dark');
  lamp(4.6, -13.2, 'dark');
  lamp(-3.0, -22, 'dark');
  lamp(-8, -1.6, 'dark');
  lamp(5.2, 3.4, 'dark');
  const metalMats = {
    dark: keep(new THREE.MeshStandardMaterial({ color: 0x1e2623, metalness: 0.55, roughness: 0.45 })),
    gray: keep(new THREE.MeshStandardMaterial({ color: 0x8b9196, metalness: 0.5, roughness: 0.4 })),
  };
  for (const tone of ['dark', 'gray'] as const) {
    add(new THREE.Mesh(keep(mergeGeometries(lampParts[tone])), metalMats[tone]));
    for (const g of lampParts[tone]) g.dispose();
  }
  const glassMat = keep(
    new THREE.MeshStandardMaterial({
      color: 0xdfe6e4,
      roughness: 0.08,
      metalness: 0.2,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    }),
  );
  add(new THREE.Mesh(keep(mergeGeometries(lampParts.glass)), glassMat), false);
  for (const g of lampParts.glass) g.dispose();

  // ---- 平台上的座位：树桩凳、石板长凳 ----
  const seats: THREE.Mesh[] = [];
  const seat = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
    const m = add(new THREE.Mesh(keep(geo), mat));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    seats.push(m);
    return m;
  };
  seat(new THREE.CylinderGeometry(0.17, 0.19, 0.42, 14), stumpMat, 1.2, DECK_Y + 0.21, -1.25);
  seat(new THREE.BoxGeometry(0.44, 0.07, 0.38), seatMat, 1.2, DECK_Y + 0.455, -1.25, 0.15);
  {
    const bx = 2.15;
    const bz = 0.45;
    const ry = -0.25;
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    for (const dx of [-0.42, 0.42]) seat(new THREE.BoxGeometry(0.26, 0.4, 0.32), stumpMat, bx + dx * c, DECK_Y + 0.2, bz - dx * s, ry);
    seat(new THREE.BoxGeometry(1.3, 0.09, 0.5), seatMat, bx, DECK_Y + 0.445, bz, ry);
  }

  // ---- 落叶（平台和栈道上）----
  {
    const leafMat = keep(new THREE.MeshStandardMaterial({ map: keep(fallenLeaf()), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }));
    const geo = keep(new THREE.PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < 220; i++) spots.push(new THREE.Vector3(DECK.x0 + r() * (DECK.x1 - DECK.x0), DECK_Y + 0.004, DECK.z0 + r() * (DECK.z1 - DECK.z0)));
    for (const [c, count] of [
      [main, 260],
      [branch, 120],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const t = r();
        const p = c.getPointAt(t);
        const tan = c.getTangentAt(t);
        const side = (r() - 0.5) * PATH_W * 0.95;
        spots.push(new THREE.Vector3(p.x - tan.z * side, DECK_Y + 0.003, p.z + tan.x * side));
      }
    }
    const im = new THREE.InstancedMesh(geo, leafMat, spots.length);
    const colors = [0xe9c64b, 0xd9b23a, 0xc98f3a, 0xb7a14a, 0xa8b452];
    spots.forEach((p, i) => {
      const s = 0.05 + r() * 0.04;
      im.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(UP, r() * Math.PI * 2), tmpS.set(s, 1, s)));
      im.setColorAt(i, new THREE.Color(colors[Math.floor(r() * colors.length)]));
    });
    im.computeBoundingSphere();
    add(im, false);
  }

  // ---- 草地 ----
  const shadeNear = (x: number, z: number) => {
    let s = 0;
    for (const t of trees) {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < t.crown * 1.2) s = Math.max(s, 1 - smoothstep(t.crown * 0.3, t.crown * 1.2, d));
    }
    return s;
  };
  {
    const size = 170;
    const seg = 170;
    const g = keep(new THREE.PlaneGeometry(size, size, seg, seg));
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -12);
    const p = g.attributes.position;
    const col: number[] = [];
    const dark = new THREE.Color(0.62, 0.78, 0.5);
    const light = new THREE.Color(1.0, 1.0, 0.82);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      // 离得远的点不用算到路的精确距离（只影响起伏），粗算一下省时间
      const clear = Math.abs(x) > 40 || z < -60 ? 10 : clearance(x, z);
      p.setY(i, groundY(x, z, clear));
      const patch = 0.5 + 0.5 * Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2) * Math.cos(z * 0.27 - x * 0.05);
      c.copy(dark).lerp(light, 0.25 + patch * 0.45);
      c.multiplyScalar(1 - 0.32 * shadeNear(x, z));
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    add(new THREE.Mesh(g, keep(new THREE.MeshStandardMaterial({ map: keep(grass()), vertexColors: true, roughness: 0.95 }))), false);
  }

  // ---- 远处的城市（雾里很淡）----
  {
    const geos: THREE.BufferGeometry[] = [];
    const cityMat = keep(new THREE.MeshBasicMaterial({ vertexColors: true }));
    for (let i = 0; i < 22; i++) {
      const w = 6 + r() * 10;
      const h = 8 + r() * 26;
      const g = new THREE.BoxGeometry(w, h, 6 + r() * 6);
      const x = -80 + i * 7.6 + (r() - 0.5) * 3;
      const z = -62 - r() * 12;
      g.translate(x, h / 2 - 0.2, z);
      const shade = new THREE.Color(0xc8d2d6).lerp(new THREE.Color(0xe6ebe8), r());
      const col: number[] = [];
      for (let k = 0; k < g.attributes.position.count; k++) col.push(shade.r, shade.g, shade.b);
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geos.push(g);
    }
    group.add(new THREE.Mesh(keep(mergeGeometries(geos)), cityMat));
    for (const g of geos) g.dispose();
  }

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
    m.position.set(0, DECK_Y + 0.006, 0);
    group.add(m);
  }

  // ---- 太阳 ----
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
  sun.target.position.set(0, 0, -5);
  sun.position.copy(sun.target.position).add(new THREE.Vector3(-0.5, 1.0, -0.62).normalize().multiplyScalar(40));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 5, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  group.add(sun.target);

  // ---- 环境光：天空球 + 草地，舞台拿它烘 PMREM ----
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(skyDome(80), skyMat));
  const envGround = new THREE.Mesh(keep(new THREE.CircleGeometry(80, 32)), keep(new THREE.MeshBasicMaterial({ color: 0x5b7d3c })));
  envGround.rotation.x = -Math.PI / 2;
  envGround.position.y = -1;
  envScene.add(envGround);

  // ---- 防穿墙：身边一小块地面（按真实起伏）、平台、栈道、近处的树干、灯杆、座位、石头 ----
  const colliders: THREE.Object3D[] = [walkMain, walkBranch, rockMesh, ...seats, ...poles];
  {
    const g = keep(new THREE.PlaneGeometry(14, 14, 28, 28));
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, Math.max(groundY(p.getX(i), p.getZ(i)), DECK_Y - 0.1));
    const ground = new THREE.Mesh(g);
    ground.updateMatrixWorld();
    colliders.push(ground);
    const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(DECK.x1 - DECK.x0, 0.2, DECK.z1 - DECK.z0)));
    deck.position.set((DECK.x0 + DECK.x1) / 2, DECK_Y - 0.1, (DECK.z0 + DECK.z1) / 2);
    deck.updateMatrixWorld();
    colliders.push(deck);
    for (const t of trees) {
      if (Math.hypot(t.x, t.z) > 10) continue;
      const m = new THREE.Mesh(keep(new THREE.CylinderGeometry(t.r * 1.3, t.r * 1.6, t.h + 1, 8)));
      m.position.set(t.x, groundY(t.x, t.z) + (t.h + 1) / 2, t.z);
      m.updateMatrixWorld();
      colliders.push(m);
    }
  }
  return {
    group,
    lights: [sun],
    colliders,
    hemisphere: { sky: 0xe2f0ff, ground: 0x6a8a48, intensity: 0.85 },
    fog: new THREE.Fog(0xdfe9dc, 14, 80),
    environment: { scene: envScene, intensity: 0.7 },
    shadowBounds: 3,
    keyShadow: false,
    far: 170,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
