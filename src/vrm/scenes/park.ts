import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture, rng, type Backdrop } from './common';
import { AMBIENCE_VOLUME } from '../../speech/ambience';
import { createDust, createLightShafts, type Shaft } from './sunlight';
import { createBatcher, createTreeMaker, windDepth, windShader, type TreeVariant } from './foliage';

/**
 * 背景场景：城市公园里的木栈道（照着一张实拍的公园照片搭的），全 3D：
 *
 *   树 / 灌木  ez-tree（npm @dgreenheck/ez-tree，MIT）程序生成：真实的树皮贴图、一片片的叶子卡片、自然分叉，
 *             叶子随风轻轻摆（影子也跟着摆）、逆光时透光。一棵大树 1.4 万~2.2 万个三角形、生成 6~30ms。
 *             生成几个变体，同一个变体的几十棵树合成一批画（见 batch）。
 *             模块 4MB（树皮和树叶贴图打包在里面），只在选了公园时才动态加载
 *   草坪      近处是一丛丛 3D 的草（ez-tree 演示场景里的草丛模型，public/scene/eztree/，MIT），也随风摆；
 *             远处铺 Poly Haven 的草地材质（aerial_grass_rock）
 *   鲜花      近景一簇一簇的白、蓝、黄小花（同样来自 ez-tree 的演示场景），平台四周、栈道两侧、灌木前面
 *   近处      旧木平台和栈道（Poly Haven weathered_brown_planks）、欧式路灯（street_lamp_01）、青苔石头
 *             （rock_moss_set_01 里挑几块缩小）、树桩凳和长凳、落叶
 *   天空      平滑的渐变（天空球，太阳那一侧发亮），雾从 20m 开始、和地平线同色，远处的树一层比一层淡
 *   阳光      树冠里斜着漏下来的光柱（丁达尔效应）和光里飘的尘埃，见 sunlight.ts
 *
 * 试过的另外两版：全程序生成（几何体 + canvas 画的叶子，树冠一团一团的，很假）；
 * Poly Haven 的公园全景照片投影成地面和天空（远景一张图，太糊）。
 *
 * 坐标和舞台一致：角色站在原点、面朝 +Z，主相机在 +Z 方向往 -Z 看，所以半身景别里看到的是她身后：
 * 木栈道从平台后沿出发，先往左、再往右弯着伸进远处，两边草坪、树、灌木、路灯。
 * 头后面不放竖着的东西（树干、灯杆）：头在远处背景上的投影随距离变宽，树和灯都避开这条"视线走廊"。
 *
 * 灯光：舞台的主光当太阳用（右侧偏前、离地约 43°、暖白、投软阴影，范围覆盖身边 ±18m —— 树冠的影子就是斑驳的光影，
 * 平台上空留了一块树冠的空隙让阳光照进来）。半球光换成天蓝 / 草绿（树和草是 Phong 材质，环境光主要靠它），
 * 环境光（IBL）用名古屋公园那张全景的 1k HDR（只用来打光，不显示）。
 * 试过另加一盏从左后方照来的太阳（照片里是逆光）：它也照在脸上，2.2 时脸发白、五官的明暗全没了；
 * 舞台主光不投影，又把地上的影子冲淡到看不出来 —— 见 common.ts 的 Backdrop.sun
 */

const BASE = `${import.meta.env.BASE_URL}scene/`;

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
  [1, -62],
  [-1.5, -84],
  [0, -150],
];
const BRANCH_PATH: V2[] = [
  [-2.6, -0.6],
  [-5.5, -1.6],
  [-8.5, -4],
  [-12, -5],
  [-16, -4.4],
  [-21, -6],
  [-28, -5],
  [-44, -9],
  [-70, -6],
  [-150, -12],
];
/** 平台前沿往前（镜头转过来时看到）的一条：也一直伸到雾里 */
const FRONT_PATH: V2[] = [
  [0.8, 1.6],
  [1.6, 7],
  [-0.6, 14],
  [1.2, 24],
  [-0.5, 40],
  [0.5, 150],
];
const PATH_W = 2.3;
/** 角色脚下的平台（面高 0，地面在 -0.1） */
const DECK = { x0: -3.2, x1: 2.8, z0: -2.2, z1: 2.2 };
/** 主相机（舞台的默认机位）z，用来算"头后面的视线走廊" */
const CAM_Z = 1.58;
/** 木板贴图一张 1.8m 见方 */
const TILE = 1.8;
/**
 * 太阳（舞台的主光当太阳用）：右侧偏前、离地约 43°。
 * 主光原本在右前方 37°（顺光）：影子都落在人和凳子正后方，从正面看被挡住，看上去"没有影子"；
 * 挪到侧面，影子落在左后方，正面就看得到。脸多了侧光的立体感，另一侧有补光
 * 平台上空留了一块树冠的空隙让阳光照进来（见 blocksSun）：之前平台整个罩在树荫里，
 * 她自己的影子落在树荫里看不出来，地面也没有明暗
 */
const SUN_POS: [number, number, number] = [2.1, 2.0, 0.5];
const SUN_AZ = new THREE.Vector2(SUN_POS[0], SUN_POS[2]).normalize();
const SUN_DIR = new THREE.Vector3(...SUN_POS).normalize();

/**
 * 树冠里漏下来的光柱：[落地点 x, z, 宽度, 亮度]。光柱从落地点往太阳方向（右上）斜着伸进树冠。
 * 半身景别看到的是她身后很窄的一条（长焦 24°），光柱要落在画面里才看得到：近处的放在两侧，
 * 中景、远景的才往中间放 —— 头后面那块不放亮的，脸的对比要留着。
 */
const SHAFTS: Array<[number, number, number, number]> = [
  // 平台边：右后方从树冠空隙照到平台上的那一束，左边一束细的
  [1.6, -1.4, 1.2, 0.65],
  [-2.7, -3.2, 0.9, 0.75],
  // 中景：画面两侧（中间那两根穿过头后面，压暗）
  [-3.8, -4.6, 1.0, 0.8],
  [3.0, -5.5, 1.1, 0.75],
  [-4.6, -6.4, 1.7, 0.9],
  [0.9, -7.8, 1.0, 0.36],
  [-2.0, -10.2, 2.2, 0.5],
  [2.6, -12.2, 1.4, 0.75],
  [-6.8, -13.0, 2.6, 0.85],
  [-1.2, -14.5, 1.6, 0.6],
  // 远景：粗一些，被雾吃掉一半
  [-3.2, -17.5, 3.0, 0.65],
  [1.4, -21.0, 2.4, 0.55],
  [-8.5, -22.0, 3.6, 0.62],
  [-2.2, -28.0, 4.2, 0.52],
  [4.2, -30.0, 3.4, 0.45],
];

/**
 * 树的变体：ez-tree 的预设 + 种子 + 真实高度（米）+ 叶子多几倍。
 * 只用白蜡（Ash）和橡树（Oak）：照片里是阔叶树；Aspen 是白桦树皮，第一版混进来几棵白树干，不像
 */
const TREE_VARIANTS = [
  { preset: 'Ash Large', seed: 11, height: 15, leaves: 1.5 },
  { preset: 'Oak Large', seed: 23, height: 13, leaves: 1.5 },
  { preset: 'Ash Medium', seed: 37, height: 12, leaves: 1.4 },
  { preset: 'Oak Medium', seed: 41, height: 10.5, leaves: 1.4 },
  { preset: 'Ash Large', seed: 97, height: 16, leaves: 1.5 },
] as const;
/** 远处那一圈树：中等大小的两种，叶子不加，省三角形 */
const FAR_VARIANTS = [2, 3] as const;
const BUSH_VARIANTS = [
  { preset: 'Bush 1', seed: 61, height: 1.3, tint: null },
  { preset: 'Bush 1', seed: 67, height: 1.1, tint: null },
  // 红叶灌木（照片中间那丛）：叶子染成红褐色
  { preset: 'Bush 1', seed: 71, height: 0.95, tint: 0xd0604a },
] as const;
/** 叶子的颜色：照片里是逆光下发亮的黄绿色（Phong 的颜色可以超过 1） */
const LEAF_TINT = new THREE.Color(1.25, 1.35, 0.95);

const curveOf = (pts: V2[]) =>
  new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'centripetal',
  );

/** 一片落叶（白色剪影，颜色由 instanceColor 染） */
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

export function createPark(): Backdrop {
  const group = new THREE.Group();
  group.name = 'park';
  const disposables: Array<{ dispose(): void }> = [];
  let disposed = false;
  // 树和模型是异步加载的：换走场景之后才到的，直接释放
  const keep = <T extends { dispose(): void }>(x: T) => {
    if (disposed) x.dispose();
    else disposables.push(x);
    return x;
  };
  const r = rng(2026);
  const add = <T extends THREE.Object3D>(o: T, cast = true) => {
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        c.castShadow = cast;
        c.receiveShadow = true;
      }
    });
    group.add(o);
    return o;
  };
  const colliders: THREE.Object3D[] = [];
  /** 不加进场景、只给防穿墙用的简化形状 */
  const collider = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(keep(geo));
    m.position.set(x, y, z);
    m.updateMatrixWorld();
    colliders.push(m);
  };

  // ---- 路：离路多远（放树、草、地面起伏都要用）----
  const main = curveOf(MAIN_PATH);
  const branch = curveOf(BRANCH_PATH);
  const front = curveOf(FRONT_PATH);
  const samples: V2[] = [];
  for (const c of [main, branch, front]) {
    const n = Math.ceil(c.getLength() / 0.5);
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
  const deckDist = (x: number, z: number) =>
    Math.hypot(Math.max(DECK.x0 - x, 0, x - DECK.x1), Math.max(DECK.z0 - z, 0, z - DECK.z1));
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
  /**
   * 这棵树的树冠会不会挡住照到平台上的阳光：阳光从平台斜着穿过树冠那一层（离地 5~14m）时，
   * 在地面上的投影是从角色往太阳方向的一段（约 8m 长）；树冠半径 5~7m，离这段太近的树就不种
   */
  const blocksSun = (x: number, z: number) => {
    // 离地 45°：穿过 5~14m 那一层时，水平方向走了 4~13m
    const L = 12;
    const t = Math.max(0, Math.min(L, x * SUN_AZ.x + z * SUN_AZ.y));
    return Math.hypot(x - SUN_AZ.x * t, z - SUN_AZ.y * t) < 6.2;
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
  const tl = new THREE.TextureLoader();
  const pbr = (dir: string, repeat = 1) => {
    const t = (file: string, color = false) => {
      const x = keep(tl.load(`${BASE}textures/${dir}/${file}`));
      if (color) x.colorSpace = THREE.SRGBColorSpace;
      x.wrapS = x.wrapT = THREE.RepeatWrapping;
      x.repeat.set(repeat, repeat);
      x.anisotropy = 8;
      return x;
    };
    const arm = t('arm.jpg');
    return { map: t('diffuse.jpg', true), normalMap: t('nor_gl.jpg'), aoMap: arm, roughnessMap: arm, metalnessMap: arm };
  };
  const deckMat = keep(new THREE.MeshStandardMaterial(pbr('weathered_brown_planks')));
  // 原图偏暗：亮一点，太阳照到的地方和影子才拉得开
  deckMat.color.setScalar(1.25);
  const sideMat = keep(deckMat.clone());
  sideMat.color.setScalar(0.7);

  // ---- 天空 ----
  {
    const SKY_TOP = new THREE.Color(0x86bff0);
    // 地平线和雾同色（雾接得上），偏暖：晴天午后的薄雾
    const HORIZON = new THREE.Color(0xc4d5b6);
    // 太阳那一侧的天空发亮（光晕），转到侧面、背面时看得到
    const GLOW = new THREE.Color(0xfff3d6);
    const g = keep(new THREE.SphereGeometry(150, 48, 24));
    const p = g.attributes.position;
    const col: number[] = [];
    const c = new THREE.Color();
    const dir = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      c.copy(HORIZON).lerp(SKY_TOP, smoothstep(0, 0.55, p.getY(i) / 150));
      dir.fromBufferAttribute(p, i).normalize();
      // 光晕收窄、减弱：宽屏转到太阳那一侧时，太强的光晕和雾连成一片白
      c.lerp(GLOW, 0.4 * Math.max(0, dir.dot(SUN_DIR)) ** 10);
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const sky = new THREE.Mesh(g, keep(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    sky.renderOrder = -1;
    group.add(sky);
  }

  // ---- 云：天空球前面一圈半透明的云片（canvas 画的积云，正对角色），哪个方向看都不是一片空天 ----
  {
    const rc = rng(53);
    const cloudTex = (seed: number) => {
      const rr = rng(seed);
      return keep(
        canvasTexture(512, 256, (g) => {
          // 一团团白色的圆叠起来，底部压平；下半部稍微偏灰蓝（云的背光面）
          for (let k = 0; k < 26; k++) {
            const t = k / 25;
            const x = 70 + t * 372 + (rr() - 0.5) * 40;
            const top = 1 - Math.abs(t - 0.5) * 2;
            const rad = 34 + top * 58 + rr() * 26;
            const y = 190 - rad * (0.55 + rr() * 0.25);
            const grd = g.createRadialGradient(x, y - rad * 0.2, 0, x, y, rad);
            grd.addColorStop(0, 'rgba(255,255,255,0.9)');
            grd.addColorStop(0.55, 'rgba(250,251,255,0.55)');
            grd.addColorStop(1, 'rgba(240,244,252,0)');
            g.fillStyle = grd;
            g.beginPath();
            g.arc(x, y, rad, 0, Math.PI * 2);
            g.fill();
          }
          // 底边：从下往上淡出，云底是平的
          g.globalCompositeOperation = 'destination-out';
          const fade = g.createLinearGradient(0, 256, 0, 170);
          fade.addColorStop(0, 'rgba(0,0,0,1)');
          fade.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = fade;
          g.fillRect(0, 170, 512, 86);
          g.globalCompositeOperation = 'source-atop';
          const shade = g.createLinearGradient(0, 80, 0, 200);
          shade.addColorStop(0, 'rgba(255,255,255,0)');
          shade.addColorStop(1, 'rgba(196,208,226,0.55)');
          g.fillStyle = shade;
          g.fillRect(0, 0, 512, 256);
        }),
      );
    };
    const texes = [cloudTex(1), cloudTex(2), cloudTex(3)];
    const geo = keep(new THREE.PlaneGeometry(1, 0.5));
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + (rc() - 0.5) * 0.35;
      const elev = THREE.MathUtils.degToRad(5 + rc() * 14);
      const d = 132;
      const w = 34 + rc() * 40;
      const mat = keep(
        new THREE.MeshBasicMaterial({
          map: texes[k % texes.length],
          transparent: true,
          depthWrite: false,
          fog: false,
          opacity: 0.55 + rc() * 0.35,
        }),
      );
      const m = new THREE.Mesh(geo, mat);
      m.position.set(Math.cos(a) * Math.cos(elev) * d, Math.sin(elev) * d, Math.sin(a) * Math.cos(elev) * d);
      m.scale.set(w * (rc() < 0.5 ? -1 : 1), w, 1);
      m.lookAt(0, m.position.y * 0.6, 0);
      m.renderOrder = -0.5;
      group.add(m);
    }
  }

  // ---- 阳光：光柱 + 光里的尘埃（见 sunlight.ts）----
  const shafts = keep(
    createLightShafts(
      SHAFTS.map(([x, z, width, intensity], i): Shaft => ({
        ground: [x, groundY(x, z), z],
        // 顶端埋进树冠（离地 12~15m）
        length: (12 + (i % 4)) / SUN_DIR.y,
        width,
        // 滤色混合比加色暗（亮的底色上加得少），整体提一点
        intensity: intensity * 1.35,
      })),
      SUN_DIR,
    ),
  );
  group.add(shafts.mesh);
  const dust = (() => {
    // 单独的随机数：和树、花共用一个的话，后面所有东西的位置都会变
    const rd = rng(77);
    const pts: THREE.Vector3[] = [];
    const lum: number[] = [];
    /** 头前面、头后面那一条不放：粒子糊在脸上很脏 */
    const nearFace = (p: THREE.Vector3) => p.z > -0.7 && Math.abs(p.x) < 0.9;
    const side = new THREE.Vector3();
    const up = new THREE.Vector3();
    // 光柱里：沿光柱轴（地面往上 0.3~4.5m）撒，横向不出光柱
    for (const [x, z, width] of SHAFTS) {
      if (z < -14) continue;
      const g = new THREE.Vector3(x, groundY(x, z), z);
      side.crossVectors(SUN_DIR, new THREE.Vector3(0, 0, 1)).normalize();
      up.crossVectors(side, SUN_DIR).normalize();
      const n = Math.round(70 * width);
      for (let k = 0; k < n; k++) {
        const h = 0.3 + rd() * 4.2;
        const a = rd() * Math.PI * 2;
        const rad = Math.sqrt(rd()) * width * 0.4;
        const pt = g.clone().addScaledVector(SUN_DIR, h / SUN_DIR.y)
          .addScaledVector(side, Math.cos(a) * rad)
          .addScaledVector(up, Math.sin(a) * rad);
        if (nearFace(pt)) continue;
        pts.push(pt);
        lum.push(0.8 + rd() * 0.7);
      }
    }
    // 光柱外：平台四周零星的几颗，暗一些
    for (let k = 0; k < 260; k++) {
      const pt = new THREE.Vector3(-4.5 + rd() * 9, 0.3 + rd() * 3, -8 + rd() * 8.6);
      if (nearFace(pt)) continue;
      pts.push(pt);
      lum.push(0.25 + rd() * 0.3);
    }
    return keep(createDust(pts, lum));
  })();
  group.add(dust.points);

  // ---- 平台 + 栈道 ----
  {
    const w = DECK.x1 - DECK.x0;
    const d = DECK.z1 - DECK.z0;
    const cx = (DECK.x0 + DECK.x1) / 2;
    const cz = (DECK.z0 + DECK.z1) / 2;
    const top = keep(new THREE.PlaneGeometry(w, d));
    top.rotateX(-Math.PI / 2);
    top.translate(cx, 0, cz);
    // 按世界坐标铺：木板横着（沿 x）
    const uv = top.attributes.uv;
    const pos = top.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / TILE, pos.getZ(i) / TILE);
    add(new THREE.Mesh(top, deckMat), false);
    const edge = (sx: number, sz: number, x: number, z: number) => add(new THREE.Mesh(keep(new THREE.BoxGeometry(sx, 0.18, sz)), sideMat)).position.set(x, -0.093, z);
    edge(w + 0.08, 0.08, cx, DECK.z1);
    edge(w + 0.08, 0.08, cx, DECK.z0);
    edge(0.08, d, DECK.x0, cz);
    edge(0.08, d, DECK.x1, cz);
    collider(new THREE.BoxGeometry(w, 0.2, d), cx, -0.1, cz);
  }
  /** 一条栈道：沿曲线铺一条带子，木板横着（垂直于路），两边各一条边板 */
  const boardwalk = (curve: THREE.CatmullRomCurve3) => {
    const len = curve.getLength();
    const n = Math.ceil(len / 0.25);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const skirt: number[] = [];
    const skirtUv: number[] = [];
    const skirtIdx: number[] = [];
    // 比平台低 2mm：和平台搭接的那一段被平台盖住
    const y = -0.002;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const l = Math.hypot(tan.x, tan.z) || 1;
      const ox = (-tan.z / l) * (PATH_W / 2);
      const oz = (tan.x / l) * (PATH_W / 2);
      pos.push(p.x + ox, y, p.z + oz, p.x - ox, y, p.z - oz);
      const v = (t * len) / TILE;
      uv.push(0, v, PATH_W / TILE, v);
      for (const s of [1, -1]) {
        skirt.push(p.x + s * ox, y, p.z + s * oz, p.x + s * ox, y - 0.2, p.z + s * oz);
        skirtUv.push(v, 0, v, 0.2 / TILE);
      }
      if (i < n) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        const b = i * 4;
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
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(skirtUv, 2));
    sg.setIndex(skirtIdx);
    sg.computeVertexNormals();
    const skirtMat = keep(sideMat.clone());
    skirtMat.side = THREE.DoubleSide;
    add(new THREE.Mesh(sg, skirtMat), false);
    colliders.push(top);
  };
  boardwalk(main);
  boardwalk(branch);
  boardwalk(front);

  // ---- 树的位置（树本身等 ez-tree 加载完再放）----
  interface Spot {
    x: number;
    z: number;
    variant: number;
    scale: number;
    ry: number;
  }
  const trees: Spot[] = [];
  const tryTree = (x0: number, z0: number, variant: number, force = false) => {
    const [x, z] = pushClear(x0, z0, 1.2);
    if (!force && (inHeadCorridor(x, z) || blocksSun(x, z))) return;
    if (trees.some((o) => Math.hypot(o.x - x, o.z - z) < 4.2)) return;
    trees.push({ x, z, variant, scale: 0.88 + r() * 0.24, ry: r() * Math.PI * 2 });
  };
  // 构图里重要的几棵（照片左边那棵老树、右边几棵），再随机补满
  for (const [x, z, v] of [
    [-7.4, 2.2, 0],
    [3.9, -4.6, 4],
    [7.2, -5.0, 1],
    [-9.5, -12.5, 0],
    [-4.4, -10.8, 1],
    [6.3, -9.6, 2],
    [5.6, -16.5, 0],
    [-5.2, -17.8, 3],
    [-5.2, 4.6, 1],
    [4.6, 5.6, 2],
  ] as const)
    tryTree(x, z, v);
  for (let i = 0; i < 500 && trees.length < 58; i++) {
    const x = (r() - 0.5) * 80;
    const z = -50 + r() * 74;
    if (Math.hypot(x, z) < 7 || clearance(x, z) < 1.4 || inHeadCorridor(x, z)) continue;
    tryTree(x, z, Math.floor(r() * TREE_VARIANTS.length));
  }
  // 远处一圈（离角色 38~75m）：把地平线和雾挡住，看上去是一大片树林
  const far: Spot[] = [];
  for (let i = 0; i < 400 && far.length < 70; i++) {
    const a = r() * Math.PI * 2;
    const d = 38 + r() * 37;
    const x = Math.cos(a) * d;
    const z = -8 + Math.sin(a) * d;
    if (clearance(x, z) < 1.4 || far.some((o) => Math.hypot(o.x - x, o.z - z) < 6)) continue;
    far.push({ x, z, variant: FAR_VARIANTS[Math.floor(r() * FAR_VARIANTS.length)], scale: 0.9 + r() * 0.35, ry: r() * Math.PI * 2 });
  }
  const bushes: Spot[] = [];
  const bush = (x0: number, z0: number, variant: number) => {
    const [x, z] = pushClear(x0, z0, 0.7);
    bushes.push({ x, z, variant, scale: 0.85 + r() * 0.3, ry: r() * Math.PI * 2 });
  };
  // 红叶灌木一排（照片中间）、圆灌木散在路边
  for (let k = 0; k < 4; k++) bush(-1.9 + k * 0.85, -13.5 + (r() - 0.5) * 0.4, 2);
  for (const [x, z] of [
    [3.6, -7.8],
    [4.9, -11.8],
    [-3.4, -5.8],
    [5.8, -3.6],
    [-6.4, -8.0],
    [2.6, -18.2],
    [-3.8, 3.0],
    [-2.8, -12.4],
    [-7.5, -2.6],
    [6.8, 1.5],
  ] as const)
    bush(x, z, Math.floor(r() * 2));

  // ---- 背面（她面朝的那一侧，+Z）：镜头转到身后时看到的 ----
  // 第一版这边只有一条路、几盏灯和空草坪，转过去很单调：补一片树林、远处加密、路边灌木。
  // 用单独的随机数：和上面共用一个的话，正面已经调好的树、草、花的位置会全部变掉
  {
    const rb = rng(31);
    const addTree = (x0: number, z0: number, variant: number) => {
      const [x, z] = pushClear(x0, z0, 1.2);
      if (Math.hypot(x, z) < 7 || blocksSun(x, z) || trees.some((o) => Math.hypot(o.x - x, o.z - z) < 4.2)) return false;
      trees.push({ x, z, variant, scale: 0.88 + rb() * 0.24, ry: rb() * Math.PI * 2 });
      return true;
    };
    // 路两边几棵（手摆，构图用），再随机补一片
    for (const [x, z, v] of [
      [-6.2, 8.5, 1],
      [6.6, 9.8, 0],
      [-4.4, 14.5, 2],
      [5.4, 15.8, 3],
      [-8.8, 19.5, 4],
      [8.6, 22.5, 1],
      [-3.8, 25.5, 0],
      [4.2, 29, 2],
      [-7.4, 31, 3],
      [10.5, 14, 4],
    ] as const)
      addTree(x, z, v);
    for (let i = 0, n = 0; i < 300 && n < 16; i++) {
      const x = (rb() - 0.5) * 64;
      const z = 8 + rb() * 40;
      if (clearance(x, z) < 1.4) continue;
      if (addTree(x, z, Math.floor(rb() * TREE_VARIANTS.length))) n++;
    }
    // 远处那一圈在这一侧加密（原来这一侧只有零星几棵，地平线是空的）
    for (let i = 0, n = 0; i < 400 && n < 30; i++) {
      const a = rb() * Math.PI;
      const d = 30 + rb() * 42;
      const x = Math.cos(a) * d;
      const z = -8 + Math.sin(a) * d;
      if (z < 18 || clearance(x, z) < 1.4) continue;
      if (far.some((o) => Math.hypot(o.x - x, o.z - z) < 6) || trees.some((o) => Math.hypot(o.x - x, o.z - z) < 5)) continue;
      far.push({ x, z, variant: FAR_VARIANTS[Math.floor(rb() * FAR_VARIANTS.length)], scale: 0.9 + rb() * 0.35, ry: rb() * Math.PI * 2 });
      n++;
    }
    for (const [x0, z0, v] of [
      [-2.9, 6.2, 0],
      [3.1, 10.5, 1],
      [-3.4, 12.8, 0],
      [3.9, 16.4, 0],
      [-2.6, 20.5, 1],
      [3.0, 24.5, 0],
      [-5.5, 10.8, 2],
      [6.0, 18.8, 2],
      [-4.8, 22.4, 1],
    ] as const) {
      const [x, z] = pushClear(x0, z0, 0.7);
      bushes.push({ x, z, variant: v, scale: 0.85 + rb() * 0.3, ry: rb() * Math.PI * 2 });
    }
  }

  // ---- 地面（草地材质）----
  const shadeNear = (x: number, z: number) => {
    let s = 0;
    for (const t of trees) {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < 7) s = Math.max(s, 1 - smoothstep(1.5, 7, d));
    }
    return s;
  };
  {
    // 300m 见方：路一直伸到 150m 外（雾在 120m 处就完全盖住了）
    const g = keep(new THREE.PlaneGeometry(300, 300, 150, 150));
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    const col: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const clear = clearance(x, z);
      p.setY(i, groundY(x, z, clear));
      uv.setXY(i, x / 3.2, z / 3.2);
      // 大块的明暗斑 + 树下暗一点
      const patch = 0.5 + 0.5 * Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2) * Math.cos(z * 0.27 - x * 0.05);
      c.setRGB(0.78 + patch * 0.2, 0.86 + patch * 0.14, 0.62 + patch * 0.12).multiplyScalar(1 - 0.3 * shadeNear(x, z));
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mat = keep(new THREE.MeshStandardMaterial({ ...pbr('aerial_grass_rock'), vertexColors: true }));
    // 原图是带石头的野草地，偏黄：往照片里那种鲜绿的草坪拉一点
    mat.color.set(0xb4e07a);
    add(new THREE.Mesh(g, mat), false);
    // 防穿墙：身边一小块（按真实起伏）
    const cg = new THREE.PlaneGeometry(14, 14, 28, 28);
    cg.rotateX(-Math.PI / 2);
    const cp = cg.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setY(i, Math.max(groundY(cp.getX(i), cp.getZ(i)), -0.1));
    collider(cg, 0, 0, 0);
  }

  // ---- 平台上的座位：树桩凳、长凳 ----
  {
    const stumpMat = keep(deckMat.clone());
    stumpMat.color.set(0xd8c2a8);
    const seat = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const m = add(new THREE.Mesh(keep(geo), mat));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.updateMatrixWorld();
      colliders.push(m);
    };
    seat(new THREE.CylinderGeometry(0.17, 0.19, 0.42, 16), stumpMat, 1.2, 0.21, -1.25);
    seat(new THREE.BoxGeometry(0.44, 0.07, 0.38), deckMat, 1.2, 0.455, -1.25, 0.15);
    const bx = 2.15;
    const bz = 0.45;
    const ry = -0.25;
    for (const dx of [-0.42, 0.42])
      seat(new THREE.BoxGeometry(0.26, 0.4, 0.32), stumpMat, bx + dx * Math.cos(ry), 0.2, bz - dx * Math.sin(ry), ry);
    seat(new THREE.BoxGeometry(1.3, 0.09, 0.5), deckMat, bx, 0.445, bz, ry);
  }

  // ---- 栈道边的长椅（背面那条路上，面朝栈道）：木条座面和靠背、铸铁扶手和腿 ----
  {
    const iron = keep(new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.5, metalness: 0.6 }));
    const parkBench = (x0: number, z0: number) => {
      const [x, z] = pushClear(x0, z0, 0.45);
      const np = nearestPath(x, z);
      // 十三块方块按材质合成两个网格：各画各的话，加上阴影一张长椅一帧要画二十多次
      const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const m = new THREE.Matrix4();
      const box = (w: number, h: number, d: number, px: number, py: number, pz: number, mat: THREE.Material, rx = 0) => {
        const geo = new THREE.BoxGeometry(w, h, d).applyMatrix4(m.makeRotationX(rx).setPosition(px, py, pz));
        parts.set(mat, [...(parts.get(mat) ?? []), geo]);
      };
      for (const k of [0, 1, 2]) box(1.5, 0.035, 0.11, 0, 0.44, 0.14 - k * 0.135, deckMat);
      for (const k of [0, 1]) box(1.5, 0.1, 0.03, 0, 0.6 + k * 0.15, -0.21 - k * 0.025, deckMat, -0.17);
      for (const sx of [-0.66, 0.66]) {
        box(0.05, 0.44, 0.05, sx, 0.22, 0.17, iron);
        box(0.05, 0.86, 0.05, sx, 0.43, -0.21, iron, -0.12);
        box(0.05, 0.04, 0.42, sx, 0.4, -0.02, iron);
        box(0.05, 0.035, 0.4, sx, 0.64, 0.0, iron);
      }
      const g = new THREE.Group();
      for (const [mat, geos] of parts) {
        g.add(new THREE.Mesh(keep(mergeGeometries(geos)), mat));
        for (const geo of geos) geo.dispose();
      }
      g.position.set(x, groundY(x, z), z);
      // 局部 +Z（座位正面）朝着最近的路
      g.rotation.y = Math.atan2(np.x - x, np.z - z);
      add(g);
    };
    parkBench(2.8, 11.6);
    parkBench(-2.7, 18.4);
  }

  // ---- 落叶（平台和栈道上）----
  {
    const mat = keep(new THREE.MeshStandardMaterial({ map: keep(fallenLeaf()), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }));
    const geo = keep(new THREE.PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < 200; i++) spots.push(new THREE.Vector3(DECK.x0 + r() * (DECK.x1 - DECK.x0), 0.004, DECK.z0 + r() * (DECK.z1 - DECK.z0)));
    for (const [c, count] of [
      [main, 240],
      [branch, 110],
      [front, 90],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const t = r();
        const p = c.getPointAt(t);
        const tan = c.getTangentAt(t);
        const side = (r() - 0.5) * PATH_W * 0.95;
        spots.push(new THREE.Vector3(p.x - tan.z * side, 0.003, p.z + tan.x * side));
      }
    }
    const im = new THREE.InstancedMesh(geo, mat, spots.length);
    const colors = [0xe9c64b, 0xd9b23a, 0xc98f3a, 0xb7a14a, 0xa8b452, 0x8e7a3a];
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    spots.forEach((p, i) => {
      const k = 0.05 + r() * 0.04;
      im.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(up, r() * Math.PI * 2), s.set(k, 1, k)));
      im.setColorAt(i, new THREE.Color(colors[Math.floor(r() * colors.length)]));
    });
    im.computeBoundingSphere();
    im.receiveShadow = true;
    group.add(im);
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
    m.position.y = 0.006;
    group.add(m);
  }

  // ---- 风：草、花、树叶和它们的影子都读这一个 uTime ----
  const wind = { uTime: { value: 0 } };

  // ---- 草丛（3D）----
  const loader = new GLTFLoader();
  const own = (root: THREE.Object3D) =>
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      keep(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        keep(m);
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) keep(v);
      }
    });
  loader.load(`${BASE}eztree/grass.glb`, (gltf) => {
    own(gltf.scene);
    if (disposed) return;
    const src = gltf.scene.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined;
    if (!src) return;
    const mat = keep(
      new THREE.MeshPhongMaterial({
        map: (src.material as THREE.MeshStandardMaterial).map,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        emissive: new THREE.Color(0x3a7a20),
        emissiveIntensity: 0.16,
      }),
    );
    windShader(mat, wind);
    // 越靠近角色越密：在平台前后 30m 内撒，跳过路面和平台
    const max = 16000;
    const im = new THREE.InstancedMesh(src.geometry, mat, max);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let i = 0; i < max * 3 && n < max; i++) {
      const rad = 1 + Math.pow(r(), 1.6) * 30;
      const a = r() * Math.PI * 2;
      const x = Math.cos(a) * rad;
      const z = -4 + Math.sin(a) * rad;
      const clear = clearance(x, z);
      if (clear < 0.08) continue;
      p.set(x, groundY(x, z, clear) - 0.02, z);
      q.setFromAxisAngle(up, r() * Math.PI * 2);
      const k = 0.15 + r() * 0.1;
      s.set(k, 0.11 + r() * 0.09, k);
      im.setMatrixAt(n, m.compose(p, q, s));
      im.setColorAt(n, c.setRGB(0.42 + r() * 0.12, 0.62 + r() * 0.2, 0.2 + r() * 0.08));
      n++;
    }
    im.count = n;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    im.castShadow = false;
    group.add(im);
  });

  // ---- 鲜花（近景）：一簇一簇，每种花的每个部件（花瓣、花蕊、茎叶）一个 InstancedMesh ----
  {
    // x, z, 朵数, 哪种花（0 白 1 蓝 2 黄，-1 混着）
    const clusters: Array<[number, number, number, number]> = [
      [-3.7, -0.8, 9, 0],
      [-3.6, 1.3, 7, 2],
      [3.4, -1.5, 8, 1],
      [3.4, 1.4, 9, -1],
      [-2.0, -3.0, 6, 2],
      [1.7, -3.1, 7, 0],
      [-2.9, 3.0, 6, -1],
      [2.9, 3.3, 7, 2],
      [2.7, -6.6, 8, -1],
      [-3.7, -7.8, 7, 0],
      [-0.9, -11.6, 9, 2],
      [3.3, 6.6, 6, 1],
      [-2.5, 7.9, 7, -1],
      [-5.2, -1.2, 6, 1],
      // 背面那条路两边（放在最后：前面那些花的随机位置不受影响）
      [2.2, 9.2, 7, 2],
      [-2.4, 11.0, 6, 0],
      [3.4, 13.9, 8, -1],
      [-3.0, 16.0, 7, 1],
      [2.6, 20.8, 7, 0],
      [-3.4, 23.2, 6, 2],
    ];
    const spots: Array<{ m: THREE.Matrix4; type: number }> = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const [cx0, cz0, n, type] of clusters) {
      const [cx, cz] = pushClear(cx0, cz0, 0.45);
      for (let k = 0; k < n; k++) {
        const x = cx + (r() - 0.5) * 1.2;
        const z = cz + (r() - 0.5) * 0.9;
        const clear = clearance(x, z);
        if (clear < 0.1) continue;
        const h = 0.22 + r() * 0.16;
        spots.push({
          // 高度先按 1 存，加载完知道模型原始高度再乘
          m: new THREE.Matrix4().compose(
            new THREE.Vector3(x, groundY(x, z, clear) - 0.01, z),
            new THREE.Quaternion().setFromAxisAngle(up, r() * Math.PI * 2),
            new THREE.Vector3(h, h, h),
          ),
          type: type >= 0 && r() < 0.85 ? type : Math.floor(r() * 3),
        });
      }
    }
    ['flower_white', 'flower_blue', 'flower_yellow'].forEach((file, type) => {
      const mine = spots.filter((s) => s.type === type);
      if (!mine.length) return;
      loader.load(`${BASE}eztree/${file}.glb`, (gltf) => {
        own(gltf.scene);
        if (disposed) return;
        const node = gltf.scene.children[0];
        const meshes: THREE.Mesh[] = [];
        node.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
        // 模型原始高度（节点自带的缩放不算）
        let height = 0;
        for (const mesh of meshes) {
          mesh.geometry.computeBoundingBox();
          height = Math.max(height, mesh.geometry.boundingBox!.max.y);
        }
        const nodeRot = new THREE.Matrix4().makeRotationFromQuaternion(node.quaternion);
        const unit = new THREE.Matrix4().makeScale(1 / height, 1 / height, 1 / height);
        for (const mesh of meshes) {
          const mat = mesh.material as THREE.Material;
          windShader(mat, wind, height, 0.03);
          const im = new THREE.InstancedMesh(mesh.geometry, mat, mine.length);
          // 每个部件一个，不共用：three 画阴影时把各自材质的贴图抄到深度材质上，但贴图从有到无不会触发重新编译，
          // 花瓣（有贴图）和茎（可能没有）共用一个会用错程序
          im.customDepthMaterial = keep(windDepth(wind, height, 0.03));
          mine.forEach((s, i) => im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(s.m, unit).multiply(nodeRot)));
          im.computeBoundingSphere();
          add(im);
        }
      });
    });
  }

  // ---- 合批（树、灌木、路灯）：每次渲染前按视锥逐个剔除，见 foliage.ts ----
  const { batch, cull } = createBatcher(group, keep, SUN_DIR, -0.3);

  // ---- 树、灌木（ez-tree，动态加载）----
  void import('@dgreenheck/ez-tree').then(({ Tree }) => {
    if (disposed) return;
    const make = createTreeMaker(Tree, { wind, sunDir: SUN_DIR, keep, leafTint: LEAF_TINT });
    const up = new THREE.Vector3(0, 1, 0);
    /** 一个变体种在这几处：树干、树冠各合一批。shadow = 投不投影；solid = 近处的树干挡镜头 */
    const plant = (v: TreeVariant, spots: Spot[], shadow: boolean, solid: boolean) => {
      if (!spots.length) return;
      const matrices = spots.map((spot) => {
        const s = v.scale * spot.scale;
        if (solid && Math.hypot(spot.x, spot.z) < 10) {
          const rr = Math.max(0.2, v.trunk * s * 1.3);
          collider(new THREE.CylinderGeometry(rr, rr, 6, 8), spot.x, 3, spot.z);
        }
        return new THREE.Matrix4().compose(
          new THREE.Vector3(spot.x, groundY(spot.x, spot.z) - 0.05, spot.z),
          new THREE.Quaternion().setFromAxisAngle(up, spot.ry),
          new THREE.Vector3(s, s, s),
        );
      });
      const { branchesMesh: b, leavesMesh: l } = v.tree;
      batch(b.geometry, b.material as THREE.Material, matrices, shadow ? {} : null);
      batch(l.geometry, l.material as THREE.Material, matrices, shadow ? { depth: v.depth } : null);
    };
    const tv = TREE_VARIANTS.map((v) => make(v.preset, v.seed, v.height, null, v.leaves));
    tv.forEach((v, i) => plant(v, trees.filter((s) => s.variant === i), true, true));
    // 远处的树用不加叶子的版本（看不清，省三角形），不投影
    for (const i of FAR_VARIANTS) {
      const v = make(TREE_VARIANTS[i].preset, TREE_VARIANTS[i].seed + 1000, TREE_VARIANTS[i].height, null);
      plant(v, far.filter((s) => s.variant === i), false, false);
    }
    const bv = BUSH_VARIANTS.map((v) => make(v.preset, v.seed, v.height, v.tint));
    bv.forEach((v, i) => plant(v, bushes.filter((s) => s.variant === i), true, false));
  });

  // ---- 模型：路灯、石头 ----
  const placeModel = (src: THREE.Object3D, x: number, y: number, z: number, scale = 1, ry = 0) => {
    const o = src.clone();
    o.position.set(x, y, z);
    o.scale.setScalar(scale);
    o.rotation.y = ry;
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = !(mesh.material as THREE.Material).transparent; // 半透明的不投影
      mesh.receiveShadow = true;
    });
    group.add(o);
    return o;
  };
  // 路灯八盏一样的：灯柱、灯罩、灯泡各合一批（和树一样逐盏剔除，见 batch）。灯柱一根三万个三角形，
  // 之前八根全画进阴影图；现在影子落不进画面的不画
  loader.load(`${BASE}models/street_lamp_01/street_lamp_01.gltf`, (gltf) => {
    own(gltf.scene);
    if (disposed) return;
    const places: THREE.Matrix4[] = [];
    for (const [x0, z0, ry] of [
      [2.3, -2.7, 0.4],
      [-3.1, -7.4, -0.3],
      [4.6, -13.2, 1.1],
      [-3.0, -22, 0.2],
      [-8, -1.6, 0.8],
      [5.2, 3.4, -0.6],
      [-1.8, 9.5, 0.3],
      [2.9, 19, -0.9],
    ]) {
      const [x, z] = pushClear(x0, z0, 0.35);
      const y = groundY(x, z);
      places.push(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z));
      collider(new THREE.CylinderGeometry(0.12, 0.12, 3.9, 6), x, y + 1.95, z);
    }
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      // 玻璃灯罩（半透明）不投影
      batch(mesh.geometry, mat, places.map((p) => p.clone().multiply(mesh.matrixWorld)), mat.transparent ? null : {});
    });
  });
  loader.load(`${BASE}models/rock_moss_set_01/rock_moss_set_01.gltf`, (gltf) => {
    own(gltf.scene);
    if (disposed) return;
    const rocks = gltf.scene.children;
    // 原尺寸是 2~3m 的大石头，缩到半米到一米，沿着路边放；一半埋在土里
    const spots: Array<[number, number, number]> = [
      [-2.4, -9.6, 0.24],
      [2.1, -8.4, 0.22],
      [-3.4, -3.0, 0.18],
      [4.7, -6.8, 0.26],
      [0.6, -12.3, 0.2],
      [0.4, -16.6, 0.3],
      [-3.3, -16.2, 0.22],
      [5.3, -17.6, 0.2],
      [-1.9, 3.2, 0.22],
      [3.4, -12.6, 0.18],
      [-7.2, -2.8, 0.24],
    ];
    spots.forEach(([x0, z0, s], i) => {
      const src = rocks[i % rocks.length];
      if (!src) return;
      const [x, z] = pushClear(x0, z0, s * 3);
      const o = placeModel(src, x, groundY(x, z) + 0.02, z, s, i * 1.9);
      o.updateMatrixWorld(true);
      if (Math.hypot(x, z) < 8) o.traverse((c) => (c as THREE.Mesh).isMesh && colliders.push(c));
    });
  });

  let time = 0;
  return {
    group,
    lights: [],
    colliders,
    // 环境光（半球光 + IBL）压低、太阳调亮：户外阳光比天光亮好几倍。
    // 之前两边差不多亮，影子里被环境光填满，人和树的影子淡到看不出来
    hemisphere: { sky: 0xe2f0ff, ground: 0x6a8a48, intensity: 0.42 },
    // 雾从 24m 开始（和地平线同色）：远处的树一层比一层淡，前中后景拉开。
    // 颜色不能太白、要带点饱和度（远处的树林是灰绿偏蓝，不是乳白）：太白的话画面发灰发白，光柱也衬不出来
    fog: new THREE.Fog(0xc4d5b6, 24, 130),
    // IBL 只照背景（角色的 MToon 不吃环境贴图）：比之前亮一点，背景不发闷；再高影子会被填掉
    environment: { url: `${BASE}hdri/nagoya_wall_path_1k.hdr`, intensity: 0.2, rotation: THREE.MathUtils.degToRad(126) },
    // 春天的鸟叫和啄木鸟（Resaural, CC0），作者录的就是无缝循环。说话时自动压低
    ambience: `${import.meta.env.BASE_URL}audio/park.ogg`,
    // 鸟鸣是远处录的，默认音量下偏小：比默认高 35%（咖啡店那条保持默认，正合适）
    ambienceVolume: AMBIENCE_VOLUME * 1.35,
    shadowBounds: 3,
    sun: { color: 0xfff1dc, intensity: 2.2, bounds: 18, position: SUN_POS, fill: 0.25, rim: 0.35 },
    far: 170,
    // 满屏的树叶、草都是逐像素算光的：Retina 大窗口（画布 2232×1960，四百多万像素）时像素比压到约 1.76，
    // 要画的像素少两成多，实测 GPU 每帧少 3~4ms，看不出差别。普通屏（dpr 1）、小窗口不受影响
    pixelBudget: 3.4e6,
    update(dt: number) {
      time += dt;
      wind.uTime.value = time;
      shafts.update(time);
      dust.update(time);
    },
    beforeRender(view, shadow) {
      cull(view, shadow);
    },
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose();
    },
  };
}
