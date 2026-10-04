import * as THREE from 'three';
import { canvasTexture, rng } from './common';

/**
 * 街景（street.ts）里要"画"的贴图，canvas 现画（墙、路、瓦这些表面是 Poly Haven 的 PBR 贴图，见 streetMaterials.ts）：
 *
 *   立面图集  一张 2048×1024 的图，切成 8×4 格，每格是"一个开间 × 一层"（约 2.8m 宽、3m 高）：
 *            一楼的店面（咖啡店的大玻璃窗、陶器店、暖帘、格子门、卷帘门、住家的玄关……）、
 *            二楼的窗（木框窗、铝窗、格子窗、落地门……）、侧墙、山墙、自动售货机。墙面本身只是一层底色，
 *            按颜色算出遮罩，着色器里遮罩为 0 的地方露出 PBR 灰泥。
 *            房子的立面按开间一格一格拼（同一个材质，所有房子合成一个网格画一次）。
 *            同样布局的另一张图是自发光：店里暖黄的灯光、售货机的灯箱 —— 遮阳篷底下的阴影里也是亮的
 *   旗子      竖的布旗（海边咖啡、陶器、看得见海的街……）和横的招牌，一张图集
 *   黑板      咖啡店门口的立式小黑板
 *
 * 招牌、旗子的配色往插画靠（饱和、干净）；墙、路、瓦这些大面积的表面用实拍材质，和公园同一个写实档次。
 */

/** 简体中文字体（日文字体里没有"边""鲜"这些简体字）：圆体 / 黑体、宋体、手写体 */
const FONT_CN = '"Yuanti SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", sans-serif';
const FONT_SERIF_CN = '"Songti SC", "STSong", "SimSun", "Noto Serif SC", "Noto Serif CJK SC", serif';
const FONT_HAND_CN = '"HanziPen SC", "Hannotate SC", "Kaiti SC", "STKaiti", "KaiTi", cursive';

type G = CanvasRenderingContext2D;
type R = () => number;

// ---------------------------------------------------------------- 立面图集

const CELL = 256;
const COLS = 8;
const ROWS = 4;

/** 图集里的格子。一楼（G_）、二楼及以上（U_）、侧墙和其他 */
export const F = {
  CAFE_WIN: 0,
  CAFE_DOOR: 1,
  SHOP_WIN: 2,
  NOREN: 3,
  LATTICE: 4,
  SHUTTER: 5,
  GENKAN: 6,
  WALL_G: 7,
  WIN_WOOD: 8,
  WIN_ALU: 9,
  WIN_LATTICE: 10,
  WALL_U: 11,
  BALC_DOOR: 12,
  WIN_SMALL: 13,
  WIN_TALL: 14,
  WALL_AC: 15,
  SIDE: 16,
  SIDE_WIN: 17,
  SIDE_PIPE: 18,
  GABLE: 19,
  BOARDS: 20,
  TILES: 21,
  VENDING: 22,
  IZAKAYA: 23,
  GLASS_SHOP: 24,
  FLOWER: 25,
  SOUVENIR: 26,
} as const;
export type Cell = (typeof F)[keyof typeof F];

/** 格子的 uv 范围 [u0, v0, u1, v1]（往里缩 3 像素，远处取 mipmap 时不串到隔壁格子） */
export function cellUV(cell: number): [number, number, number, number] {
  const col = cell % COLS;
  const row = Math.floor(cell / COLS);
  const inset = 3;
  const W = CELL * COLS;
  const H = CELL * ROWS;
  return [(col * CELL + inset) / W, 1 - ((row + 1) * CELL - inset) / H, ((col + 1) * CELL - inset) / W, 1 - (row * CELL + inset) / H];
}

/**
 * 有玻璃的格子：开口在格子里的位置（像素，256×256、y 朝下，和画的时候一样），开口里的东西都是几何体（street.ts）：
 *   hole   开口：墙在这里挖空（着色器里丢掉这些像素），玻璃往里缩 12cm，四周有窗套
 *   bars   窗棂、门的竖梃和横档、门下的踢脚板：开口里的木条 / 铝条（像素矩形）
 *   frame  窗框的颜色；metal = 铝框（铁件那一批）还是木框（木头那一批）
 *   room   玻璃后面是什么房间（glass.ts 的房间图集）
 *   sill   窗台（往外伸的一块木板）
 *   handle 门把手（黄铜）
 */
export interface WindowSpec {
  hole: [number, number, number, number];
  bars: Array<[number, number, number, number]>;
  frame: number;
  metal: boolean;
  room: 'cafe' | 'pottery' | 'souvenir' | 'clothes' | 'flower' | 'home';
  sill?: [number, number, number, number];
  handle?: [number, number, number, number];
}
export const WINDOWS: Partial<Record<Cell, WindowSpec>> = {
  [F.CAFE_WIN]: { hole: [16, 44, 240, 194], bars: [[125, 44, 131, 194], [16, 72, 240, 76]], frame: 0x4a3326, metal: false, room: 'cafe' },
  [F.CAFE_DOOR]: {
    hole: [16, 44, 240, 228],
    bars: [
      [70, 44, 78, 228],
      [182, 44, 190, 228],
      [78, 44, 182, 52],
      [78, 206, 182, 228],
      [16, 72, 70, 76],
      [190, 72, 240, 76],
    ],
    frame: 0x4a3326,
    metal: false,
    room: 'cafe',
    handle: [166, 128, 171, 160],
  },
  [F.SHOP_WIN]: { hole: [15, 44, 241, 192], bars: [[84, 44, 89, 192], [167, 44, 172, 192]], frame: 0x6e4c35, metal: false, room: 'pottery' },
  [F.SOUVENIR]: { hole: [14, 44, 242, 204], bars: [[126, 44, 131, 204]], frame: 0x59606a, metal: true, room: 'souvenir' },
  [F.GLASS_SHOP]: { hole: [12, 42, 244, 222], bars: [[126, 42, 131, 222]], frame: 0x5c636b, metal: true, room: 'clothes' },
  [F.FLOWER]: { hole: [14, 44, 242, 220], bars: [[125, 44, 131, 220]], frame: 0xe9e4d8, metal: true, room: 'flower' },
  [F.WIN_WOOD]: {
    hole: [66, 66, 190, 170],
    bars: [[126, 66, 130, 170], [66, 116, 190, 120]],
    frame: 0x4a3326,
    metal: false,
    room: 'home',
    sill: [52, 178, 204, 186],
  },
  [F.WIN_ALU]: { hole: [50, 72, 190, 166], bars: [[118, 72, 123, 166]], frame: 0xb7bcc1, metal: true, room: 'home' },
  [F.BALC_DOOR]: { hole: [32, 40, 224, 244], bars: [[125, 40, 131, 244]], frame: 0x5a5f66, metal: true, room: 'home' },
  [F.WIN_TALL]: {
    hole: [73, 35, 183, 239],
    bars: [[126, 35, 130, 239], [73, 102, 183, 106], [73, 170, 183, 174]],
    frame: 0x4a3326,
    metal: false,
    room: 'home',
  },
};

/** 每一格开口在图集 uv 里的范围（vec4[32]：u0, v0, u1, v1；没有开口的格子给一个永远不在里面的范围），墙的着色器拿来挖洞 */
export function holeRects() {
  const W = CELL * COLS;
  const H = CELL * ROWS;
  const out: THREE.Vector4[] = [];
  for (let cell = 0; cell < COLS * ROWS; cell++) {
    const w = WINDOWS[cell as Cell];
    if (!w) {
      out.push(new THREE.Vector4(2, 2, 2, 2));
      continue;
    }
    const ox = (cell % COLS) * CELL;
    const oy = Math.floor(cell / COLS) * CELL;
    const [x0, y0, x1, y1] = w.hole;
    out.push(new THREE.Vector4((ox + x0) / W, 1 - (oy + y1) / H, (ox + x1) / W, 1 - (oy + y0) / H));
  }
  return out;
}

const WOOD_DARK = '#4a3326';
const WOOD_MID = '#6e4c35';
const WOOD_LIGHT = '#94704f';
const PLASTER = '#f4f0e7';
const ALU = '#b7bcc1';

/**
 * 墙面：只铺一层纯色。真正的灰泥是 Poly Haven 的 PBR 贴图（streetMaterials.ts），
 * 这个颜色只用来认出"哪里是墙"：和它一样的像素遮罩为 0（露出灰泥），画了东西的为 1（见 facadeAtlas）
 */
function plaster(g: G, _r: R) {
  g.fillStyle = PLASTER;
  g.fillRect(0, 0, CELL, CELL);
}

/** 横梁（木） */
function beam(g: G, y: number, h: number, color = WOOD_DARK) {
  g.fillStyle = color;
  g.fillRect(0, y, CELL, h);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(0, y, CELL, 1.5);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, y + h - 1.5, CELL, 1.5);
}

/** 柱子（木），x 是左边 */
function post(g: G, x: number, w: number, y0 = 0, y1 = CELL, color = WOOD_DARK) {
  g.fillStyle = color;
  g.fillRect(x, y0, w, y1 - y0);
  g.fillStyle = 'rgba(255,255,255,0.1)';
  g.fillRect(x, y0, 1.5, y1 - y0);
  g.fillStyle = 'rgba(0,0,0,0.2)';
  g.fillRect(x + w - 1.5, y0, 1.5, y1 - y0);
}

/** 墙根的石砌 / 水泥基座 */
function base(g: G, r: R, y0: number) {
  g.fillStyle = '#a9a49b';
  g.fillRect(0, y0, CELL, CELL - y0);
  g.strokeStyle = 'rgba(70,64,56,0.45)';
  g.lineWidth = 1.5;
  let x = -r() * 40;
  while (x < CELL) {
    const w = 40 + r() * 30;
    g.fillStyle = `hsl(36, 6%, ${58 + r() * 10}%)`;
    g.fillRect(x + 1, y0 + 1, w - 2, CELL - y0 - 2);
    g.strokeRect(x, y0, w, CELL - y0);
    x += w;
  }
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, y0, CELL, 2);
}

/** 玻璃上的天光：上亮下暗的天蓝 + 两道斜的反光。alpha < 1 时叠在室内上面 */
function glass(g: G, x: number, y: number, w: number, h: number, alpha = 1) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.globalAlpha = alpha;
  const grd = g.createLinearGradient(x, y, x, y + h);
  grd.addColorStop(0, '#e3f1fa');
  grd.addColorStop(0.45, '#a9cfea');
  grd.addColorStop(1, '#6d9cc6');
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  g.globalAlpha = Math.min(1, alpha * 1.4) * 0.45;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(x + w * 0.1, y + h);
  g.lineTo(x + w * 0.32, y + h);
  g.lineTo(x + w * 0.78, y);
  g.lineTo(x + w * 0.56, y);
  g.fill();
  g.beginPath();
  g.moveTo(x + w * 0.4, y + h);
  g.lineTo(x + w * 0.46, y + h);
  g.lineTo(x + w * 0.92, y);
  g.lineTo(x + w * 0.86, y);
  g.fill();
  g.restore();
}

/** 木框（框是实心填色，里面的洞由调用方再画） */
function frame(g: G, x: number, y: number, w: number, h: number, t: number, color = WOOD_DARK) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(x, y, w, 1.5);
  g.fillRect(x, y, 1.5, h);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(x + t - 1.5, y + t, 1.5, h - 2 * t);
  g.fillRect(x + t, y + t - 1.5, w - 2 * t, 1.5);
}

/** 一楼的店面：上面一段墙、横梁、下面石基座；返回开口的范围 */
function groundFrame(g: G, r: R) {
  plaster(g, r);
  beam(g, 24, 12);
  base(g, r, 228);
  return { y0: 36, y1: 228 };
}

type Painter = (g: G, e: G, r: R) => void;

const PAINTERS: Partial<Record<Cell, Painter>> = {
  [F.CAFE_WIN]: (g, _e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 10);
    // 玻璃那块是开口（WINDOWS）：真的玻璃、窗棂是几何体，这里只画四周的木框和下面的木裙板
    g.fillStyle = WOOD_MID;
    g.fillRect(16, y0 + 162, 224, y1 - y0 - 170);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1.5;
    g.strokeRect(24, y0 + 168, 96, y1 - y0 - 182);
    g.strokeRect(136, y0 + 168, 96, y1 - y0 - 182);
  },
  [F.CAFE_DOOR]: (g, _e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 10);
  },
  [F.SHOP_WIN]: (g, _e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 9, WOOD_MID);
    g.fillStyle = WOOD_LIGHT;
    g.fillRect(15, y0 + 158, 226, y1 - y0 - 166);
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(15, y0 + 158, 226, 3);
  },
  [F.SOUVENIR]: (g, _e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 8, '#59606a');
    g.fillStyle = '#8e949b';
    g.fillRect(14, y0 + 170, 228, y1 - y0 - 178);
  },
  [F.NOREN]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    post(g, 6, 12, y0, y1);
    post(g, 238, 12, y0, y1);
    // 里面暗（店里），隐约看得到推拉门的框
    const grd = g.createLinearGradient(0, y0, 0, y1);
    grd.addColorStop(0, '#3a2d24');
    grd.addColorStop(1, '#5b4636');
    g.fillStyle = grd;
    g.fillRect(18, y0, 220, y1 - y0);
    e.fillStyle = 'rgba(150,100,55,0.55)';
    e.fillRect(30, y0 + 90, 196, y1 - y0 - 100);
    g.fillStyle = 'rgba(240,215,170,0.45)';
    g.fillRect(30, y0 + 90, 196, y1 - y0 - 100);
    g.strokeStyle = WOOD_DARK;
    g.lineWidth = 4;
    for (const x of [30, 128, 226]) {
      g.beginPath();
      g.moveTo(x, y0 + 80);
      g.lineTo(x, y1);
      g.stroke();
    }
    // 暖帘：三幅靛蓝的布，下半截一道白浪纹，中间一个白圈
    const nw = 218 / 3;
    for (let k = 0; k < 3; k++) {
      const nx = 19 + k * nw;
      g.fillStyle = '#2d4274';
      g.fillRect(nx + 1, y0, nw - 2, 96);
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(nx + nw - 5, y0, 3, 96);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 2.5;
      g.beginPath();
      for (let x = 0; x <= nw - 4; x += 2) {
        const yy = y0 + 78 + Math.sin((x / (nw - 4)) * Math.PI * 3 + k) * 4;
        if (x === 0) g.moveTo(nx + 2 + x, yy);
        else g.lineTo(nx + 2 + x, yy);
      }
      g.stroke();
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(128, y0 + 40, 18, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = `bold 20px ${FONT_SERIF_CN}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('窑', 128, y0 + 41);
  },
  [F.LATTICE]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 24, 12);
    base(g, r, 228);
    g.fillStyle = '#2f241d';
    g.fillRect(14, 48, 228, 176);
    // 竖格子
    for (let x = 16; x < 240; x += 11) post(g, x, 7, 48, 224, WOOD_MID);
    beam(g, 48, 6, WOOD_DARK);
    beam(g, 108, 5, WOOD_DARK);
    beam(g, 218, 8, WOOD_DARK);
    post(g, 6, 10, 36, 228);
    post(g, 240, 10, 36, 228);
  },
  [F.SHUTTER]: (g, _e, r) => {
    plaster(g, r);
    base(g, r, 232);
    g.fillStyle = '#8c9197';
    g.fillRect(8, 30, 240, 26);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(8, 30, 240, 2);
    for (let y = 56; y < 228; y += 6) {
      g.fillStyle = '#cdd1d5';
      g.fillRect(12, y, 232, 4);
      g.fillStyle = '#a9aeb3';
      g.fillRect(12, y + 4, 232, 2);
    }
    g.fillStyle = '#7d8288';
    g.fillRect(12, 222, 232, 8);
    g.fillStyle = '#6a6f75';
    g.fillRect(8, 56, 4, 176);
    g.fillRect(244, 56, 4, 176);
  },
  [F.GENKAN]: (g, e, r) => {
    plaster(g, r);
    base(g, r, 234);
    // 小雨棚
    g.fillStyle = '#6b7178';
    g.fillRect(28, 50, 184, 8);
    g.fillStyle = 'rgba(0,0,0,0.15)';
    g.fillRect(28, 58, 184, 10);
    // 推拉门：铝框 + 磨砂玻璃（竖的压花纹）
    g.fillStyle = ALU;
    g.fillRect(40, 70, 162, 160);
    for (const x0 of [46, 124]) {
      g.fillStyle = '#e4eaee';
      g.fillRect(x0, 76, 72, 148);
      for (let x = x0 + 3; x < x0 + 72; x += 5) {
        g.fillStyle = 'rgba(160,175,185,0.35)';
        g.fillRect(x, 76, 1.5, 148);
      }
      g.fillStyle = ALU;
      g.fillRect(x0, 140, 72, 4);
    }
    g.fillStyle = '#8d9399';
    g.fillRect(119, 70, 5, 160);
    // 门灯（暖光）、门牌、信箱
    for (const [ctx, a] of [
      [g, 0.9],
      [e, 0.9],
    ] as const) {
      const glow = ctx.createRadialGradient(222, 92, 0, 222, 92, 14);
      glow.addColorStop(0, `rgba(255,240,200,${a})`);
      glow.addColorStop(1, 'rgba(255,230,180,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(208, 78, 28, 28);
    }
    g.fillStyle = '#fff6dc';
    g.beginPath();
    g.arc(222, 92, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5a4030';
    g.fillRect(212, 116, 22, 10);
    g.fillStyle = '#3f4a56';
    g.fillRect(210, 142, 26, 30);
    g.fillStyle = '#2b333c';
    g.fillRect(214, 150, 18, 3);
  },
  [F.WALL_G]: (g, _e, r) => {
    plaster(g, r);
    base(g, r, 232);
    g.fillStyle = ALU;
    g.fillRect(146, 70, 74, 60);
    g.fillStyle = '#e1e7eb';
    g.fillRect(150, 74, 66, 52);
    glass(g, 150, 74, 66, 52, 0.25);
    g.fillStyle = ALU;
    g.fillRect(181, 74, 3, 52);
    // 通风口、燃气表
    g.fillStyle = '#c9c6bf';
    g.fillRect(44, 64, 32, 32);
    for (let y = 68; y < 94; y += 5) {
      g.fillStyle = '#8f8b84';
      g.fillRect(48, y, 24, 2);
    }
    g.fillStyle = '#d7d9d6';
    g.fillRect(40, 150, 40, 44);
    g.strokeStyle = '#8f9396';
    g.lineWidth = 1.5;
    g.strokeRect(40, 150, 40, 44);
    g.fillStyle = '#9aa0a4';
    g.fillRect(56, 194, 4, 38);
  },
  [F.WIN_WOOD]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 246, 10);
    frame(g, 58, 58, 140, 120, 8);
    g.fillStyle = WOOD_LIGHT;
    g.fillRect(52, 178, 152, 8);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(56, 186, 144, 8);
  },
  [F.WIN_ALU]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 248, 8, '#b9b3a8');
    g.fillStyle = ALU;
    g.fillRect(44, 66, 152, 106);
    // 雨户的盒子
    g.fillStyle = '#d7d2c6';
    g.fillRect(196, 62, 34, 114);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(196, 62, 3, 114);
    // 花箱：红的、粉的花
    g.fillStyle = '#8a5a3c';
    g.fillRect(52, 176, 136, 14);
    for (let k = 0; k < 16; k++) {
      g.fillStyle = r() < 0.5 ? '#e2574c' : r() < 0.5 ? '#f08fb0' : '#5e9a4a';
      g.beginPath();
      g.arc(58 + r() * 124, 174 - r() * 8, 3 + r() * 3, 0, Math.PI * 2);
      g.fill();
    }
  },
  [F.WIN_LATTICE]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 246, 10);
    frame(g, 50, 54, 156, 128, 8);
    g.fillStyle = '#2b221c';
    g.fillRect(58, 62, 140, 112);
    for (let x = 60; x < 196; x += 8) post(g, x, 4.5, 62, 174, WOOD_MID);
    g.fillStyle = WOOD_DARK;
    g.fillRect(58, 98, 140, 4);
    g.fillRect(58, 136, 140, 4);
    g.fillStyle = WOOD_LIGHT;
    g.fillRect(46, 182, 164, 7);
  },
  [F.WALL_U]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 246, 10);
    g.fillStyle = '#d4d0c8';
    g.beginPath();
    g.arc(196, 76, 13, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.arc(196, 80, 9, 0, Math.PI);
    g.fill();
  },
  [F.BALC_DOOR]: (g, _e, r) => {
    plaster(g, r);
    g.fillStyle = '#5a5f66';
    g.fillRect(26, 34, 204, 214);
  },
  [F.WIN_SMALL]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 246, 10);
    g.fillStyle = ALU;
    g.fillRect(98, 86, 62, 62);
    g.fillStyle = '#e1e7eb';
    g.fillRect(102, 90, 54, 54);
    glass(g, 102, 90, 54, 54, 0.3);
  },
  [F.WIN_TALL]: (g, _e, r) => {
    plaster(g, r);
    frame(g, 64, 26, 128, 222, 9);
  },
  [F.WALL_AC]: (g, _e, r) => {
    plaster(g, r);
    beam(g, 246, 10);
    g.fillStyle = ALU;
    g.fillRect(40, 70, 70, 56);
    g.fillStyle = '#e2e8ec';
    g.fillRect(44, 74, 62, 48);
    glass(g, 44, 74, 62, 48, 0.3);
    // 空调外机 + 管子
    g.fillStyle = '#e9ebe8';
    g.fillRect(140, 172, 92, 62);
    g.strokeStyle = '#a8acaa';
    g.lineWidth = 2;
    g.strokeRect(140, 172, 92, 62);
    g.beginPath();
    g.arc(170, 203, 22, 0, Math.PI * 2);
    g.stroke();
    for (let k = -18; k <= 18; k += 6) {
      g.beginPath();
      g.moveTo(170 + k, 185);
      g.lineTo(170 + k, 221);
      g.stroke();
    }
    g.fillStyle = '#d8d4cb';
    g.fillRect(214, 110, 6, 62);
    g.fillRect(150, 110, 70, 6);
  },
  [F.SIDE]: (g, _e, r) => {
    plaster(g, r);
  },
  [F.SIDE_WIN]: (g, _e, r) => {
    plaster(g, r);
    g.fillStyle = ALU;
    g.fillRect(96, 84, 64, 72);
    g.fillStyle = '#e0e6ea';
    g.fillRect(100, 88, 56, 64);
    glass(g, 100, 88, 56, 64, 0.35);
    g.fillStyle = ALU;
    g.fillRect(126, 88, 3, 64);
  },
  [F.SIDE_PIPE]: (g, _e, r) => {
    plaster(g, r);
    const grd = g.createLinearGradient(196, 0, 212, 0);
    grd.addColorStop(0, '#9aa0a4');
    grd.addColorStop(0.4, '#d9dcde');
    grd.addColorStop(1, '#8a9094');
    g.fillStyle = grd;
    g.fillRect(196, 0, 16, CELL);
    for (const y of [40, 150]) {
      g.fillStyle = '#7d8388';
      g.fillRect(193, y, 22, 6);
    }
  },
  [F.GABLE]: (g, _e, r) => {
    plaster(g, r);
    g.fillStyle = WOOD_DARK;
    g.fillRect(112, 96, 32, 26);
    for (let x = 116; x < 142; x += 5) {
      g.fillStyle = '#2a1e18';
      g.fillRect(x, 100, 2.5, 18);
    }
    g.fillStyle = WOOD_DARK;
    g.fillRect(0, 246, CELL, 10);
  },
  [F.BOARDS]: (g, _e, r) => {
    for (let y = 0; y < CELL; y += 16) {
      g.fillStyle = `hsl(20, ${16 + r() * 8}%, ${19 + r() * 6}%)`;
      g.fillRect(0, y, CELL, 16);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, y, CELL, 2);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(0, y + 14, CELL, 2);
    }
    for (const x of [6, 124, 242]) post(g, x, 8, 0, CELL, '#2e231d');
  },
  [F.TILES]: (g, _e, r) => {
    for (let y = 0; y < CELL; y += 12)
      for (let x = 0; x < CELL; x += 12) {
        g.fillStyle = `hsl(${32 + r() * 8}, ${22 + r() * 10}%, ${78 + r() * 8}%)`;
        g.fillRect(x + 1, y + 1, 10, 10);
      }
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = '#b9ad9c';
    g.fillRect(0, 0, CELL, CELL);
    g.globalCompositeOperation = 'source-over';
  },
  [F.VENDING]: (g, e, r) => {
    // 整个格子就是售货机的正面（白底、蓝色的顶、灯箱里三排饮料）
    g.fillStyle = '#f2f4f5';
    g.fillRect(0, 0, CELL, CELL);
    g.fillStyle = '#2a63b0';
    g.fillRect(0, 0, CELL, 26);
    g.fillStyle = '#ffffff';
    g.font = `bold 16px ${FONT_CN}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('冰镇', 128, 13);
    for (const [ctx, k] of [
      [g, 1],
      [e, 0.9],
    ] as const) {
      ctx.fillStyle = k === 1 ? '#fbfcff' : 'rgba(235,240,250,0.9)';
      ctx.fillRect(14, 32, 228, 132);
    }
    const drinks = ['#e2574c', '#f2c14e', '#4f9bd9', '#7cbf6a', '#f08f3a', '#9b6bd0', '#2f3a8f', '#e9e4d8'];
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 7; k++) {
        const x = 22 + k * 31;
        const y = 40 + row * 42;
        g.fillStyle = drinks[Math.floor(r() * drinks.length)];
        g.fillRect(x + 6, y + 4, 14, 26);
        g.fillRect(x + 9, y, 8, 5);
        g.fillStyle = 'rgba(255,255,255,0.45)';
        g.fillRect(x + 8, y + 6, 3, 20);
        g.fillStyle = '#d23a2e';
        g.fillRect(x + 5, y + 33, 16, 5);
      }
    }
    g.fillStyle = '#dfe3e6';
    g.fillRect(14, 172, 228, 40);
    g.fillStyle = '#9aa1a8';
    g.fillRect(190, 178, 36, 28);
    g.fillStyle = '#2b2f33';
    g.fillRect(30, 222, 196, 24);
  },
  [F.IZAKAYA]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    post(g, 6, 12, y0, y1, WOOD_MID);
    post(g, 238, 12, y0, y1, WOOD_MID);
    g.fillStyle = '#3a2a1f';
    g.fillRect(18, y0, 220, y1 - y0);
    // 格子推拉门，里面透出暖光
    e.fillStyle = 'rgba(190,120,60,0.7)';
    e.fillRect(24, y0 + 60, 208, y1 - y0 - 66);
    g.fillStyle = '#f0c98a';
    g.fillRect(24, y0 + 60, 208, y1 - y0 - 66);
    for (let x = 24; x < 232; x += 9) post(g, x, 4, y0 + 60, y1 - 6, WOOD_MID);
    beam(g, y0 + 120, 5, WOOD_DARK);
    // 短暖帘（深蓝，白字）
    g.fillStyle = '#23345e';
    g.fillRect(20, y0, 216, 52);
    g.fillStyle = '#ffffff';
    g.font = `bold 28px ${FONT_SERIF_CN}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('鲜鱼', 98, y0 + 28);
    g.fillText('酒', 180, y0 + 28);
    g.fillStyle = 'rgba(0,0,0,0.2)';
    for (const x of [92, 164]) g.fillRect(x, y0, 3, 52);
    // 红灯笼
    for (const [ctx, a] of [
      [g, 0.6],
      [e, 1],
    ] as const) {
      const glow = ctx.createRadialGradient(220, y0 + 92, 0, 220, y0 + 92, 30);
      glow.addColorStop(0, `rgba(255,120,80,${a})`);
      glow.addColorStop(1, 'rgba(255,90,60,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(190, y0 + 62, 60, 60);
    }
    g.fillStyle = '#d8392c';
    g.beginPath();
    g.ellipse(220, y0 + 92, 15, 22, 0, 0, Math.PI * 2);
    g.fill();
    e.fillStyle = '#c03424';
    e.beginPath();
    e.ellipse(220, y0 + 92, 15, 22, 0, 0, Math.PI * 2);
    e.fill();
    g.fillStyle = '#1e1a18';
    g.fillRect(212, y0 + 68, 16, 4);
    g.fillRect(212, y0 + 112, 16, 4);
    g.font = `bold 14px ${FONT_SERIF_CN}`;
    g.fillText('酒', 220, y0 + 93);
  },
  [F.GLASS_SHOP]: (g, _e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    g.fillStyle = '#5c636b';
    g.fillRect(6, y0, 244, y1 - y0);
  },
  [F.FLOWER]: (g, _e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 8, '#e9e4d8');
  },
};

/**
 * 立面图集：map（颜色）+ emissive（店里的灯光、灯箱）+ mask（1 = 画出来的构件，0 = 墙面，露出 PBR 灰泥），同样的格子布局。
 * 遮罩按颜色自动算：和墙面底色（PLASTER）一样的像素是墙，差得越多越是构件（边缘按差值软过渡，抗锯齿的边不会有硬台阶）
 */
export function facadeAtlas() {
  const W = CELL * COLS;
  const H = CELL * ROWS;
  const ec = document.createElement('canvas');
  ec.width = W;
  ec.height = H;
  const e = ec.getContext('2d')!;
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  const map = canvasTexture(W, H, (g) => {
    g.fillStyle = PLASTER;
    g.fillRect(0, 0, W, H);
    for (let cell = 0; cell < COLS * ROWS; cell++) {
      const paint = PAINTERS[cell as Cell];
      if (!paint) continue;
      const x = (cell % COLS) * CELL;
      const y = Math.floor(cell / COLS) * CELL;
      for (const ctx of [g, e]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.rect(0, 0, CELL, CELL);
        ctx.clip();
      }
      paint(g, e, rng(1000 + cell));
      g.restore();
      e.restore();
    }
  });
  map.anisotropy = 8;
  const emissive = new THREE.CanvasTexture(ec);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.anisotropy = 8;
  const mc = document.createElement('canvas');
  mc.width = W;
  mc.height = H;
  const src = (map.image as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, W, H);
  const out = mc.getContext('2d')!.createImageData(W, H);
  const hex = parseInt(PLASTER.slice(1), 16);
  const [sr, sg, sb] = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  for (let i = 0; i < src.data.length; i += 4) {
    const d = Math.abs(src.data[i] - sr) + Math.abs(src.data[i + 1] - sg) + Math.abs(src.data[i + 2] - sb);
    const m = Math.round(255 * THREE.MathUtils.smoothstep(d, 4, 24));
    out.data[i] = out.data[i + 1] = out.data[i + 2] = m;
    out.data[i + 3] = 255;
  }
  mc.getContext('2d')!.putImageData(out, 0, 0);
  const mask = new THREE.CanvasTexture(mc);
  mask.anisotropy = 8;
  return { map, emissive, mask };
}

// ---------------------------------------------------------------- 旗子、招牌

/** 竖的布旗：[字, 底色, 字的颜色]。插画里的旗是靛蓝底、白字，底部一道白浪 */
export const BANNERS = [
  ['海边咖啡', '#34508f', '#ffffff'],
  ['陶器', '#34508f', '#ffffff'],
  ['看得见海的街', '#2f4c8a', '#ffffff'],
  ['刨冰', '#ffffff', '#d8392c'],
  ['咖啡', '#6b3f2a', '#fff5e6'],
  ['伴手礼', '#2e7d6b', '#ffffff'],
  ['海鲜料理', '#23345e', '#ffffff'],
  ['海风街', '#2f4c8a', '#ffffff'],
] as const;

/** 横的招牌：[主字, 小字, 底色, 字色] */
export const SIGNS = [
  ['海边咖啡', '手冲 · 甜点', '#f4ead6', '#3b2a20'],
  ['青海窑', '陶器 · 器皿', '#3a2a20', '#f3e3c3'],
  ['海风商店', '伴手礼 · 杂货', '#f6f3ec', '#2f4c8a'],
  ['花之工坊', '鲜花 · 绿植', '#ffffff', '#3e7a4a'],
  ['渔家', '海鲜料理', '#2a2420', '#f6f0e4'],
  ['潮声', '冲浪 · 咖啡', '#e9f2f6', '#2f5c7a'],
  ['营业中', '欢迎光临', '#f3ead8', '#4a3326'],
] as const;

const BANNER_W = 128;
const BANNER_H = 512;
const SIGN_W = 512;
const SIGN_H = 128;

/** 旗子和招牌的图集（1024×1024）：上半 8 面竖旗，下半 2 列 × 4 行横招牌 */
export function signAtlas() {
  const tex = canvasTexture(1024, 1024, (g) => {
    g.clearRect(0, 0, 1024, 1024);
    BANNERS.forEach(([text, bg, fg], i) => {
      const x = i * BANNER_W;
      g.save();
      g.translate(x, 0);
      g.fillStyle = bg;
      g.fillRect(4, 0, BANNER_W - 8, BANNER_H);
      // 细的白边、底下的浪纹
      g.strokeStyle = fg;
      g.globalAlpha = 0.7;
      g.lineWidth = 2;
      g.strokeRect(12, 10, BANNER_W - 24, BANNER_H - 20);
      g.globalAlpha = 1;
      g.lineWidth = 3;
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        for (let xx = 14; xx <= BANNER_W - 14; xx += 2) {
          const yy = BANNER_H - 46 + k * 14 + Math.sin(xx * 0.16 + k * 1.7) * 5;
          if (xx === 14) g.moveTo(xx, yy);
          else g.lineTo(xx, yy);
        }
        g.stroke();
      }
      // 竖排的字
      const chars = [...text];
      const room = BANNER_H - 120 - (i === 0 ? 70 : 0);
      const size = Math.min(76, (room / chars.length) * 0.92);
      g.fillStyle = fg;
      g.font = `bold ${size}px ${FONT_CN}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      chars.forEach((ch, k) => g.fillText(ch, BANNER_W / 2, 40 + size / 2 + k * (size * 1.06)));
      // 咖啡店的旗：字下面一个咖啡杯
      if (i === 0) {
        const cy = 40 + chars.length * size * 1.06 + 30;
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(42, cy);
        g.lineTo(46, cy + 26);
        g.lineTo(78, cy + 26);
        g.lineTo(82, cy);
        g.closePath();
        g.stroke();
        g.beginPath();
        g.arc(86, cy + 11, 7, -Math.PI / 2, Math.PI / 2);
        g.stroke();
        g.beginPath();
        g.moveTo(36, cy + 32);
        g.lineTo(88, cy + 32);
        g.stroke();
        for (const sx of [54, 68]) {
          g.beginPath();
          g.moveTo(sx, cy - 6);
          g.bezierCurveTo(sx - 5, cy - 12, sx + 5, cy - 16, sx, cy - 22);
          g.stroke();
        }
      }
      g.restore();
    });
    SIGNS.forEach(([main, sub, bg, fg], i) => {
      const x = (i % 2) * SIGN_W;
      const y = 512 + Math.floor(i / 2) * SIGN_H;
      g.save();
      g.translate(x, y);
      g.fillStyle = bg;
      g.fillRect(6, 8, SIGN_W - 12, SIGN_H - 16);
      g.strokeStyle = fg;
      g.lineWidth = 3;
      g.strokeRect(16, 16, SIGN_W - 32, SIGN_H - 32);
      g.fillStyle = fg;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `bold 56px ${FONT_SERIF_CN}`;
      g.fillText(main, SIGN_W / 2, SIGN_H / 2 - 10);
      g.font = `bold 20px ${FONT_CN}`;
      g.fillText(sub, SIGN_W / 2, SIGN_H / 2 + 34);
      g.restore();
    });
  });
  tex.anisotropy = 8;
  return tex;
}

/** 第 i 面竖旗的 uv [u0, v0, u1, v1] */
export function bannerUV(i: number): [number, number, number, number] {
  return [(i * BANNER_W + 4) / 1024, 1 - BANNER_H / 1024, ((i + 1) * BANNER_W - 4) / 1024, 1];
}
/** 第 i 块横招牌的 uv */
export function signUV(i: number): [number, number, number, number] {
  const x = (i % 2) * SIGN_W;
  const y = 512 + Math.floor(i / 2) * SIGN_H;
  return [(x + 6) / 1024, 1 - (y + SIGN_H - 8) / 1024, (x + SIGN_W - 6) / 1024, 1 - (y + 8) / 1024];
}

/** 咖啡店门口的立式小黑板（插画里写的是 Cafe / Good Coffee / Better Days，换成中文：咖啡 / 一杯好咖啡 / 一天好心情） */
export function chalkboard() {
  return canvasTexture(256, 384, (g) => {
    g.fillStyle = '#7a5538';
    g.fillRect(0, 0, 256, 384);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fillRect(0, 0, 256, 3);
    g.fillStyle = '#26302c';
    g.fillRect(16, 16, 224, 352);
    // 粉笔的灰
    for (let k = 0; k < 500; k++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
      g.fillRect(16 + Math.random() * 224, 16 + Math.random() * 352, 2, 2);
    }
    g.strokeStyle = '#f4f1ea';
    g.fillStyle = '#f4f1ea';
    g.lineWidth = 4;
    g.lineCap = 'round';
    // 咖啡杯 + 热气
    g.beginPath();
    g.moveTo(92, 78);
    g.lineTo(98, 120);
    g.lineTo(150, 120);
    g.lineTo(156, 78);
    g.closePath();
    g.stroke();
    g.beginPath();
    g.arc(160, 96, 10, -Math.PI / 2, Math.PI / 2);
    g.stroke();
    g.beginPath();
    g.ellipse(124, 128, 44, 7, 0, 0, Math.PI * 2);
    g.stroke();
    for (const sx of [112, 136]) {
      g.beginPath();
      g.moveTo(sx, 70);
      g.bezierCurveTo(sx - 8, 60, sx + 8, 52, sx, 40);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold 58px ${FONT_HAND_CN}`;
    g.fillText('咖啡', 128, 188);
    g.font = `28px ${FONT_HAND_CN}`;
    g.fillText('一杯好咖啡', 128, 256);
    g.fillText('一天好心情', 128, 294);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(60, 222);
    g.lineTo(196, 222);
    g.stroke();
    // 角落的小叶子
    g.fillStyle = '#9fd28a';
    for (const [x, y, a] of [
      [196, 336, -0.6],
      [210, 326, 0.4],
      [60, 336, 0.6],
    ] as const) {
      g.beginPath();
      g.ellipse(x, y, 10, 5, a, 0, Math.PI * 2);
      g.fill();
    }
  });
}
