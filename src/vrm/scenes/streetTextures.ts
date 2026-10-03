import * as THREE from 'three';
import { canvasTexture, rng } from './common';

/**
 * 街景（street.ts）的贴图，全部 canvas 现画（和咖啡店的墙、黑板一个路子，没有外部文件）：
 *
 *   立面图集  一张 2048×1024 的图，切成 8×4 格，每格是"一个开间 × 一层"（约 2.8m 宽、3m 高）：
 *            一楼的店面（咖啡店的大玻璃窗、陶器店、暖帘、格子门、卷帘门、住家的玄关……）、
 *            二楼的窗（木框窗、铝窗、格子窗、落地门……）、侧墙、山墙、自动售货机。
 *            房子的立面按开间一格一格拼（同一个材质，所有房子合成一个网格画一次）。
 *            同样布局的另一张图是自发光：店里暖黄的灯光、售货机的灯箱 —— 遮阳篷底下的阴影里也是亮的
 *   屋瓦      日式的波形瓦（栈瓦），一排排横的瓦垄，可平铺
 *   路面      柏油（偏紫灰，插画里的颜色）、人行道的方石板、护栏底下的花岗岩条石、护岸的混凝土
 *   旗子      竖的布旗（海のカフェ、やきもの、海の見える街……）和横的招牌，一张图集
 *   黑板      咖啡店门口的立式小黑板
 *
 * 线条和配色往插画靠：轮廓干净、颜色饱和一点、玻璃上画天光的反光，不追求写实的脏和旧。
 */

export const FONT_JP =
  '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Yu Gothic", "YuGothic", "Meiryo", "Noto Sans JP", "Noto Sans CJK JP", sans-serif';
const FONT_SERIF_JP = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", serif';

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

const WOOD_DARK = '#4a3326';
const WOOD_MID = '#6e4c35';
const WOOD_LIGHT = '#94704f';
const PLASTER = '#f4f0e7';
const ALU = '#b7bcc1';

function plaster(g: G, r: R, base = PLASTER) {
  g.fillStyle = base;
  g.fillRect(0, 0, CELL, CELL);
  // 很淡的水渍和斑点：只是让墙面不死白，插画里的墙是干净的
  for (let i = 0; i < 10; i++) {
    const x = r() * CELL;
    const y = r() * CELL;
    const rad = 14 + r() * 40;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(150,135,115,${0.025 + r() * 0.03})`);
    grd.addColorStop(1, 'rgba(150,135,115,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 300; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.08)';
    g.fillRect(r() * CELL, r() * CELL, 1.5, 1.5);
  }
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

/** 窗帘：两边垂下来的布，有褶 */
function curtains(g: G, x: number, y: number, w: number, h: number, color = '#f6efe2', open = 0.5) {
  const cw = (w * (1 - open)) / 2;
  for (const [cx, dir] of [
    [x, 1],
    [x + w - cw, -1],
  ] as const) {
    g.fillStyle = color;
    g.fillRect(cx, y, cw, h);
    for (let k = 0; k < 4; k++) {
      g.fillStyle = 'rgba(120,100,80,0.12)';
      g.fillRect(cx + (k + 0.5) * (cw / 4), y, 2, h);
    }
    g.fillStyle = 'rgba(0,0,0,0.08)';
    g.fillRect(dir > 0 ? cx + cw - 2 : cx, y, 2, h);
  }
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

/** 店里：暖色的墙、几层架子上的瓶瓶罐罐、吊灯。e = 自发光层（同样位置画灯光） */
function cafeInterior(g: G, e: G, r: R, x: number, y: number, w: number, h: number, kind: 'cafe' | 'pottery' | 'souvenir') {
  for (const [ctx, k] of [
    [g, 1],
    [e, 0.62],
  ] as const) {
    const grd = ctx.createLinearGradient(x, y, x, y + h);
    grd.addColorStop(0, kind === 'cafe' ? '#f7d9a4' : '#f3dfba');
    grd.addColorStop(1, kind === 'cafe' ? '#b98a57' : '#c9a57a');
    ctx.save();
    ctx.globalAlpha = k;
    ctx.fillStyle = grd;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  // 架子
  const shelves = kind === 'cafe' ? [0.36, 0.56, 0.76] : [0.3, 0.52, 0.74];
  for (const t of shelves) {
    const sy = y + h * t;
    g.fillStyle = WOOD_MID;
    g.fillRect(x + 4, sy, w * (kind === 'cafe' ? 0.6 : 0.92), 4);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(x + 4, sy + 4, w * (kind === 'cafe' ? 0.6 : 0.92), 3);
    // 架子上的东西
    let cx = x + 8 + r() * 6;
    const end = x + w * (kind === 'cafe' ? 0.6 : 0.92);
    while (cx < end - 8) {
      const iw = 6 + r() * 9;
      const ih = 8 + r() * 14;
      if (kind === 'cafe') {
        // 玻璃罐（琥珀色、透明）、白杯子、小盆栽
        const pick = r();
        g.fillStyle = pick < 0.35 ? '#c98a3a' : pick < 0.6 ? '#f6f2ea' : pick < 0.8 ? '#e9dcc0' : '#5e9a4a';
        g.fillRect(cx, sy - ih, iw, ih);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(cx + 1, sy - ih + 1, 2, ih - 2);
      } else if (kind === 'pottery') {
        // 碗（半圆）、盘子（立着的椭圆）、青花的瓶
        const pick = r();
        if (pick < 0.4) {
          g.fillStyle = r() < 0.5 ? '#3d5f9c' : '#8a5a3c';
          g.beginPath();
          g.ellipse(cx + iw / 2, sy - 2, iw / 2 + 2, ih * 0.45, 0, Math.PI, 0);
          g.fill();
        } else if (pick < 0.7) {
          g.fillStyle = '#eef1f4';
          g.beginPath();
          g.ellipse(cx + iw / 2, sy - ih / 2, iw / 2 + 1, ih / 2, 0, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = '#3d5f9c';
          g.lineWidth = 1.5;
          g.stroke();
        } else {
          g.fillStyle = r() < 0.5 ? '#e8ecf0' : '#6f8fb8';
          g.beginPath();
          g.ellipse(cx + iw / 2, sy - ih * 0.45, iw / 2, ih * 0.5, 0, 0, Math.PI * 2);
          g.fill();
          g.fillRect(cx + iw / 2 - 2, sy - ih - 2, 4, 4);
        }
      } else {
        // 土特产：一盒盒的（彩色的长方块）
        g.fillStyle = ['#e2574c', '#f2c14e', '#4f9bd9', '#f6f2ea', '#7cbf6a', '#e88fb0'][Math.floor(r() * 6)];
        g.fillRect(cx, sy - ih, iw + 3, ih);
        g.fillStyle = 'rgba(255,255,255,0.4)';
        g.fillRect(cx + 2, sy - ih + 3, iw - 2, 3);
      }
      cx += iw + 3 + r() * 4;
    }
  }
  if (kind === 'cafe') {
    // 右边：吧台和意式咖啡机的剪影
    g.fillStyle = '#5a3a28';
    g.fillRect(x + w * 0.62, y + h * 0.66, w * 0.38, h * 0.34);
    g.fillStyle = '#c9ccd0';
    g.fillRect(x + w * 0.7, y + h * 0.5, w * 0.2, h * 0.16);
    g.fillStyle = '#7a7f86';
    g.fillRect(x + w * 0.72, y + h * 0.6, w * 0.16, 3);
    // 一盆大绿植
    g.fillStyle = '#4f8f43';
    for (let k = 0; k < 7; k++) {
      g.beginPath();
      g.ellipse(x + w * 0.9 + (r() - 0.5) * 14, y + h * (0.42 + r() * 0.2), 7, 12, r() * 2, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 吊灯：细线 + 灯罩 + 光晕（两层都画，自发光那层是亮的）
  const lamps = kind === 'cafe' ? [0.25, 0.7] : [0.5];
  for (const t of lamps) {
    const lx = x + w * t;
    const ly = y + h * 0.2;
    g.strokeStyle = '#3a2a20';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(lx, y);
    g.lineTo(lx, ly);
    g.stroke();
    for (const [ctx, a] of [
      [g, 0.85],
      [e, 1],
    ] as const) {
      const glow = ctx.createRadialGradient(lx, ly + 6, 0, lx, ly + 6, 34);
      glow.addColorStop(0, `rgba(255,236,180,${a})`);
      glow.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(lx - 34, ly - 28, 68, 68);
    }
    g.fillStyle = '#2f2a26';
    g.beginPath();
    g.moveTo(lx - 9, ly + 6);
    g.lineTo(lx + 9, ly + 6);
    g.lineTo(lx + 4, ly - 2);
    g.lineTo(lx - 4, ly - 2);
    g.fill();
    g.fillStyle = '#fff4cf';
    g.fillRect(lx - 4, ly + 6, 8, 3);
  }
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
  [F.CAFE_WIN]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 10);
    cafeInterior(g, e, r, 16, y0 + 8, 224, 150, 'cafe');
    glass(g, 16, y0 + 8, 224, 150, 0.32);
    // 竖棂、横棂
    post(g, 125, 6, y0 + 8, y0 + 158);
    g.fillStyle = WOOD_DARK;
    g.fillRect(16, y0 + 36, 224, 4);
    // 下面的木裙板
    g.fillStyle = WOOD_MID;
    g.fillRect(16, y0 + 162, 224, y1 - y0 - 170);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1.5;
    g.strokeRect(24, y0 + 168, 96, y1 - y0 - 182);
    g.strokeRect(136, y0 + 168, 96, y1 - y0 - 182);
  },
  [F.CAFE_DOOR]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 10);
    cafeInterior(g, e, r, 16, y0 + 8, 224, y1 - y0 - 8, 'cafe');
    glass(g, 16, y0 + 8, 224, y1 - y0 - 8, 0.3);
    // 门：木框 + 一整块玻璃，门把手，"OPEN" 小木牌
    g.fillStyle = WOOD_DARK;
    for (const x of [70, 182]) g.fillRect(x, y0 + 8, 8, y1 - y0 - 8);
    g.fillRect(70, y0 + 8, 120, 8);
    g.fillRect(70, y1 - 22, 120, 22);
    g.fillRect(16, y0 + 36, 54, 4);
    g.fillRect(190, y0 + 36, 50, 4);
    g.fillStyle = '#d6b36a';
    g.fillRect(168, y0 + 96, 4, 26);
    g.fillStyle = '#f3ead8';
    g.fillRect(104, y0 + 58, 52, 22);
    g.strokeStyle = '#6e4c35';
    g.lineWidth = 2;
    g.strokeRect(104, y0 + 58, 52, 22);
    g.beginPath();
    g.moveTo(112, y0 + 58);
    g.lineTo(130, y0 + 44);
    g.lineTo(148, y0 + 58);
    g.stroke();
    g.fillStyle = '#4a3326';
    g.font = 'bold 14px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('OPEN', 130, y0 + 70);
  },
  [F.SHOP_WIN]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 9, WOOD_MID);
    cafeInterior(g, e, r, 15, y0 + 8, 226, 148, 'pottery');
    glass(g, 15, y0 + 8, 226, 148, 0.3);
    post(g, 84, 5, y0 + 8, y0 + 156, WOOD_MID);
    post(g, 167, 5, y0 + 8, y0 + 156, WOOD_MID);
    g.fillStyle = WOOD_LIGHT;
    g.fillRect(15, y0 + 158, 226, y1 - y0 - 166);
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(15, y0 + 158, 226, 3);
  },
  [F.SOUVENIR]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 8, '#59606a');
    cafeInterior(g, e, r, 14, y0 + 8, 228, 160, 'souvenir');
    glass(g, 14, y0 + 8, 228, 160, 0.28);
    post(g, 126, 5, y0 + 8, y0 + 168, '#59606a');
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
    g.font = `bold 20px ${FONT_SERIF_JP}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('窯', 128, y0 + 41);
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
    g.fillStyle = '#3c3a3f';
    g.fillRect(66, 66, 124, 104);
    curtains(g, 66, 66, 124, 104);
    glass(g, 66, 66, 124, 104, 0.55);
    g.fillStyle = WOOD_DARK;
    g.fillRect(126, 66, 4, 104);
    g.fillRect(66, 116, 124, 4);
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
    g.fillStyle = '#3d3f45';
    g.fillRect(50, 72, 140, 94);
    curtains(g, 50, 72, 140, 94, '#eef2f5', 0.35);
    glass(g, 50, 72, 140, 94, 0.6);
    g.fillStyle = ALU;
    g.fillRect(118, 72, 5, 94);
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
    g.fillStyle = '#3a3c42';
    g.fillRect(32, 40, 192, 204);
    curtains(g, 32, 40, 192, 204, '#f4ede0', 0.4);
    glass(g, 32, 40, 192, 204, 0.58);
    g.fillStyle = '#5a5f66';
    g.fillRect(125, 40, 6, 204);
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
    g.fillStyle = '#3b3439';
    g.fillRect(73, 35, 110, 204);
    curtains(g, 73, 35, 110, 204, '#f3e9d6', 0.45);
    glass(g, 73, 35, 110, 204, 0.55);
    g.fillStyle = WOOD_DARK;
    g.fillRect(126, 35, 4, 204);
    g.fillRect(73, 102, 110, 4);
    g.fillRect(73, 170, 110, 4);
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
    plaster(g, r, '#efeae0');
    for (let k = 0; k < 6; k++) {
      const x = r() * CELL;
      const grd = g.createLinearGradient(0, 0, 0, 120 + r() * 100);
      grd.addColorStop(0, 'rgba(120,110,100,0.07)');
      grd.addColorStop(1, 'rgba(120,110,100,0)');
      g.fillStyle = grd;
      g.fillRect(x, 0, 6 + r() * 10, 220);
    }
    g.fillStyle = 'rgba(0,0,0,0.05)';
    g.fillRect(0, 250, CELL, 6);
  },
  [F.SIDE_WIN]: (g, _e, r) => {
    plaster(g, r, '#efeae0');
    g.fillStyle = ALU;
    g.fillRect(96, 84, 64, 72);
    g.fillStyle = '#e0e6ea';
    g.fillRect(100, 88, 56, 64);
    glass(g, 100, 88, 56, 64, 0.35);
    g.fillStyle = ALU;
    g.fillRect(126, 88, 3, 64);
    g.fillStyle = 'rgba(0,0,0,0.05)';
    g.fillRect(0, 250, CELL, 6);
  },
  [F.SIDE_PIPE]: (g, _e, r) => {
    plaster(g, r, '#efeae0');
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
    g.fillStyle = 'rgba(0,0,0,0.05)';
    g.fillRect(0, 250, CELL, 6);
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
    g.font = `bold 16px ${FONT_JP}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('つめた〜い', 128, 13);
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
    g.font = `bold 28px ${FONT_SERIF_JP}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('地魚', 98, y0 + 28);
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
    g.font = `bold 14px ${FONT_SERIF_JP}`;
    g.fillText('酒', 220, y0 + 93);
  },
  [F.GLASS_SHOP]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    g.fillStyle = '#5c636b';
    g.fillRect(6, y0, 244, y1 - y0);
    for (const [ctx, k] of [
      [g, 1],
      [e, 0.5],
    ] as const) {
      ctx.fillStyle = k === 1 ? '#f4f1ea' : 'rgba(240,235,225,0.5)';
      ctx.fillRect(12, y0 + 6, 232, y1 - y0 - 12);
    }
    // 货架上的帽子、T 恤（彩色的块）
    for (let k = 0; k < 9; k++) {
      const x = 22 + k * 25;
      g.fillStyle = ['#4f9bd9', '#f6f2ea', '#e2574c', '#f2c14e', '#7cbf6a', '#2f3a8f'][Math.floor(r() * 6)];
      g.beginPath();
      g.moveTo(x, y0 + 70);
      g.lineTo(x + 18, y0 + 70);
      g.lineTo(x + 16, y0 + 112);
      g.lineTo(x + 2, y0 + 112);
      g.fill();
    }
    g.fillStyle = '#c9ccd0';
    g.fillRect(12, y0 + 120, 232, 4);
    for (let k = 0; k < 10; k++) {
      g.fillStyle = ['#e88fb0', '#f6f2ea', '#4f9bd9', '#f2c14e'][Math.floor(r() * 4)];
      g.beginPath();
      g.ellipse(24 + k * 23, y0 + 140, 9, 6, 0, 0, Math.PI * 2);
      g.fill();
    }
    glass(g, 12, y0 + 6, 232, y1 - y0 - 12, 0.3);
    g.fillStyle = '#5c636b';
    g.fillRect(126, y0, 5, y1 - y0);
  },
  [F.FLOWER]: (g, e, r) => {
    const { y0, y1 } = groundFrame(g, r);
    frame(g, 6, y0, 244, y1 - y0, 8, '#e9e4d8');
    for (const [ctx, k] of [
      [g, 1],
      [e, 0.35],
    ] as const) {
      ctx.fillStyle = k === 1 ? '#dfe8d4' : 'rgba(220,230,200,0.35)';
      ctx.fillRect(14, y0 + 8, 228, y1 - y0 - 16);
    }
    for (let k = 0; k < 40; k++) {
      g.fillStyle = r() < 0.6 ? `hsl(${100 + r() * 30}, 40%, ${30 + r() * 15}%)` : ['#e2574c', '#f2c14e', '#f08fb0', '#ffffff', '#9b6bd0'][Math.floor(r() * 5)];
      g.beginPath();
      g.arc(20 + r() * 216, y0 + 40 + r() * (y1 - y0 - 60), 5 + r() * 9, 0, Math.PI * 2);
      g.fill();
    }
    glass(g, 14, y0 + 8, 228, y1 - y0 - 16, 0.28);
    g.fillStyle = '#e9e4d8';
    g.fillRect(125, y0 + 8, 6, y1 - y0 - 16);
  },
};

/** 立面图集：map（颜色）+ emissive（店里的灯光、灯箱），同样的格子布局 */
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
  return { map, emissive };
}

// ---------------------------------------------------------------- 平铺的材质

/** 日式波形瓦：一排排横的瓦垄（一张图 = 2m 见方，8 排、每排 7 片） */
export function roofTiles() {
  const r = rng(31);
  const t = canvasTexture(
    256,
    256,
    (g) => {
      const rows = 8;
      const cols = 7;
      const rh = 256 / rows;
      const cw = 256 / cols;
      for (let row = 0; row < rows; row++) {
        const y = row * rh;
        for (let k = 0; k < cols; k++) {
          const x = k * cw;
          const l = 52 + r() * 8;
          // 一片瓦：左边亮（受光的弧面）、右边暗（凹下去的槽）
          const grd = g.createLinearGradient(x, 0, x + cw, 0);
          grd.addColorStop(0, `hsl(214, 14%, ${l - 10}%)`);
          grd.addColorStop(0.3, `hsl(214, 14%, ${l + 8}%)`);
          grd.addColorStop(0.65, `hsl(214, 14%, ${l - 4}%)`);
          grd.addColorStop(1, `hsl(214, 16%, ${l - 18}%)`);
          g.fillStyle = grd;
          g.fillRect(x, y, cw, rh);
        }
        // 每排下沿：一道亮边（瓦的下口）+ 下面一道阴影
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(0, y + rh - 5, 256, 2);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(0, y + rh - 3, 256, 3);
      }
    },
    [1, 1],
  );
  return t;
}

/** 柏油：偏紫的灰（插画里的路是带点紫的浅灰）、细的颗粒、几块颜色稍深的补丁。一张图 = 4m 见方 */
export function asphalt() {
  const r = rng(17);
  return canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#9d98a0';
      g.fillRect(0, 0, 512, 512);
      // 补丁 / 深浅（可平铺：贴边的画三遍）
      for (let k = 0; k < 18; k++) {
        const x = r() * 512;
        const y = r() * 512;
        const rad = 30 + r() * 90;
        for (const dx of [-512, 0, 512])
          for (const dy of [-512, 0, 512]) {
            const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
            const dark = r() < 0.6;
            grd.addColorStop(0, dark ? 'rgba(70,64,78,0.08)' : 'rgba(255,250,255,0.06)');
            grd.addColorStop(1, 'rgba(0,0,0,0)');
            g.fillStyle = grd;
            g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
          }
      }
      // 颗粒：按颜色分几批画（每换一次 fillStyle 都要解析一遍字符串，九千次很慢）
      for (const style of ['rgba(60,55,70,0.14)', 'rgba(60,55,70,0.24)', 'rgba(240,236,245,0.12)', 'rgba(240,236,245,0.22)']) {
        g.fillStyle = style;
        for (let k = 0; k < 2200; k++) g.fillRect(r() * 512, r() * 512, 1 + r() * 1.5, 1 + r() * 1.5);
      }
    },
    [1, 1],
  );
}

/** 人行道的方石板：30cm 见方、错缝，浅暖灰、每块深浅不一。一张图 = 2.4m 见方 */
export function pavers() {
  const r = rng(23);
  return canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#8f877d';
      g.fillRect(0, 0, 512, 512);
      const s = 64;
      for (let row = 0; row < 8; row++) {
        const off = row % 2 ? s / 2 : 0;
        for (let k = -1; k < 9; k++) {
          const x = k * s + off;
          const y = row * s;
          const l = 74 + r() * 9;
          g.fillStyle = `hsl(${30 + r() * 12}, ${8 + r() * 6}%, ${l}%)`;
          g.fillRect(x + 2, y + 2, s - 4, s - 4);
          g.fillStyle = 'rgba(255,255,255,0.18)';
          g.fillRect(x + 2, y + 2, s - 4, 2);
          g.fillStyle = 'rgba(0,0,0,0.08)';
          g.fillRect(x + 2, y + s - 4, s - 4, 2);
          for (let i = 0; i < 40; i++) {
            g.fillStyle = `rgba(0,0,0,${r() * 0.06})`;
            g.fillRect(x + 3 + r() * (s - 6), y + 3 + r() * (s - 6), 1.5, 1.5);
          }
        }
      }
    },
    [1, 1],
  );
}

/** 花岗岩条石（护栏底下那道矮墙）：浅灰、错缝。一张图 = 2m 宽 × 1m 高 */
export function granite() {
  const r = rng(29);
  return canvasTexture(
    512,
    256,
    (g) => {
      g.fillStyle = '#8b8a86';
      g.fillRect(0, 0, 512, 256);
      const bw = 128;
      const bh = 64;
      for (let row = 0; row < 4; row++) {
        const off = row % 2 ? bw / 2 : 0;
        for (let k = -1; k < 5; k++) {
          const x = k * bw + off;
          const y = row * bh;
          g.fillStyle = `hsl(40, 4%, ${78 + r() * 8}%)`;
          g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
          g.fillStyle = 'rgba(255,255,255,0.3)';
          g.fillRect(x + 2, y + 2, bw - 4, 3);
          g.fillStyle = 'rgba(0,0,0,0.12)';
          g.fillRect(x + 2, y + bh - 6, bw - 4, 4);
          for (let i = 0; i < 120; i++) {
            g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)';
            g.fillRect(x + 3 + r() * (bw - 6), y + 3 + r() * (bh - 6), 1.5, 1.5);
          }
        }
      }
    },
    [1, 1],
  );
}

/** 护岸的混凝土：竖的模板缝、贴水面那段湿的深色 + 一点青苔。一张图 = 4m 宽 × 3m 高（不竖着平铺） */
export function seawall() {
  const r = rng(37);
  return canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#c4c0b6';
      g.fillRect(0, 0, 256, 256);
      for (let x = 0; x < 256; x += 64) {
        g.fillStyle = 'rgba(0,0,0,0.1)';
        g.fillRect(x, 0, 2, 256);
      }
      for (let k = 0; k < 400; k++) {
        g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)';
        g.fillRect(r() * 256, r() * 256, 2, 2);
      }
      // 下面（贴水面）：湿的、深一点，最下面一层青苔
      const wet = g.createLinearGradient(0, 150, 0, 256);
      wet.addColorStop(0, 'rgba(70,75,70,0)');
      wet.addColorStop(0.6, 'rgba(70,75,70,0.35)');
      wet.addColorStop(1, 'rgba(50,80,60,0.6)');
      g.fillStyle = wet;
      g.fillRect(0, 150, 256, 106);
    },
    [1, 1],
  );
}

// ---------------------------------------------------------------- 旗子、招牌

/** 竖的布旗：[字, 底色, 字的颜色]。插画里的旗是靛蓝底、白字，底部一道白浪 */
export const BANNERS = [
  ['海のカフェ', '#34508f', '#ffffff'],
  ['やきもの', '#34508f', '#ffffff'],
  ['海の見える街', '#2f4c8a', '#ffffff'],
  ['かき氷', '#ffffff', '#d8392c'],
  ['珈琲', '#6b3f2a', '#fff5e6'],
  ['おみやげ', '#2e7d6b', '#ffffff'],
  ['地魚料理', '#23345e', '#ffffff'],
  ['潮風通り', '#2f4c8a', '#ffffff'],
] as const;

/** 横的招牌：[主字, 小字, 底色, 字色] */
export const SIGNS = [
  ['海のカフェ', 'SEASIDE CAFE', '#f4ead6', '#3b2a20'],
  ['青海窯', 'やきもの・器', '#3a2a20', '#f3e3c3'],
  ['しおかぜ商店', 'おみやげ・雑貨', '#f6f3ec', '#2f4c8a'],
  ['花のアトリエ', 'FLOWER', '#ffffff', '#3e7a4a'],
  ['魚よし', '地魚料理', '#2a2420', '#f6f0e4'],
  ['潮騒', 'Surf & Coffee', '#e9f2f6', '#2f5c7a'],
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
      g.font = `bold ${size}px ${FONT_JP}`;
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
      g.font = `bold 56px ${FONT_SERIF_JP}`;
      g.fillText(main, SIGN_W / 2, SIGN_H / 2 - 10);
      g.font = `bold 20px ${FONT_JP}`;
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

/** 咖啡店门口的立式小黑板（插画里写的是 Cafe / Good Coffee / Better Days） */
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
    g.font = 'italic bold 60px "Snell Roundhand", "Brush Script MT", "Segoe Script", Georgia, cursive';
    g.fillText('Cafe', 128, 188);
    g.font = 'italic 26px Georgia, serif';
    g.fillText('Good Coffee', 128, 256);
    g.fillText('Better Days', 128, 294);
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
