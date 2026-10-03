import * as THREE from 'three';
import { presetSun, type TimeState } from '../timeOfDay';

/**
 * 街景的昼夜：太阳高度角 → 一整套颜色（调色表），天文的方位 → 场景里的方向。
 *
 * 调色表按太阳高度角（不是钟点）插值：同样 5° 的太阳，夏天的傍晚和冬天的下午是一个样子。
 * 30° 以上就是原来白天的那一套（加时间之前调好的值），白天的画面不变；往下依次是午后、黄金时刻、日落、
 * 民用暮光（-4°，天边还有一抹橙）、航海暮光（-10°，深蓝）、夜（-18°，星星都出来了）。
 *
 * 方位：太阳按天文算出来的方位角整体转一个角度，让"白天"那一档的太阳正好在 SUN_POS 的方向
 * （左边一排店面朝着太阳的构图不变）。这样日出在左边（山和房子后面），日落在镜头背后偏右。
 * 月亮不按天文算，走一条安排好的弧线：夜里在海那一侧低低地挂着，默认机位看得到，海面上有一条月光。
 */

interface Key {
  elev: number;
  zenith: number;
  mid: number;
  horizon: number;
  glow: number;
  glowAmt: number;
  band: number;
  sunCol: number;
  sunI: number;
  fillCol: number;
  fillI: number;
  rimCol: number;
  rimI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  fog: number;
  env: number;
  cloud: number;
  deep: number;
  shallow: number;
  scatter: number;
  foam: number;
  leaf: number;
  leafE: number;
  town: number;
  hdri: number;
  ground: number;
}

const DAY: Key = {
  elev: 30,
  zenith: 0x2265c8,
  mid: 0x4f98e6,
  horizon: 0xd3e8f5,
  glow: 0xfff8e6,
  glowAmt: 0.55,
  band: 0,
  sunCol: 0xfff3e0,
  sunI: 2.5,
  fillCol: 0xdfe8ff,
  fillI: 0.3,
  rimCol: 0xffe9d6,
  rimI: 0.4,
  hemiSky: 0xdcecff,
  hemiGround: 0x8f8a84,
  hemiI: 0.5,
  fog: 0xd3e8f5,
  env: 0.35,
  cloud: 0xffffff,
  deep: 0x1d66a6,
  shallow: 0x17707c,
  scatter: 0x1f9a9a,
  foam: 1,
  leaf: 1,
  leafE: 1,
  town: 0.45,
  hdri: 1,
  ground: 0x6a6660,
};

/** 从高到低。夜里的主光是月亮（颜色、亮度单独算，见 moonKey），这里的 sunCol / sunI 只在太阳还在天上时用 */
const KEYS: Key[] = [
  { ...DAY, elev: 90 },
  DAY,
  {
    ...DAY,
    elev: 15,
    zenith: 0x2a68c4,
    mid: 0x5698e0,
    horizon: 0xdfe6ea,
    glow: 0xffeccc,
    glowAmt: 0.6,
    sunCol: 0xffe6c4,
    sunI: 2.4,
    rimCol: 0xffe2c4,
    rimI: 0.45,
    hemiSky: 0xdde8f6,
    hemiGround: 0x8c847c,
    fog: 0xd9e2ea,
    env: 0.34,
    cloud: 0xfff8ee,
    deep: 0x1c62a0,
    shallow: 0x176c78,
    scatter: 0x2a9890,
    leafE: 0.95,
    town: 0.42,
  },
  {
    ...DAY,
    elev: 6,
    zenith: 0x3264b4,
    mid: 0x6f96cc,
    horizon: 0xf0d6b4,
    glow: 0xffc890,
    glowAmt: 0.7,
    band: 0.35,
    sunCol: 0xffc888,
    sunI: 2.1,
    fillCol: 0xd8dcf0,
    fillI: 0.28,
    rimCol: 0xffc89a,
    rimI: 0.55,
    hemiSky: 0xd6d4dc,
    hemiGround: 0x8a7462,
    hemiI: 0.46,
    fog: 0xe6d4c0,
    env: 0.3,
    cloud: 0xffe2c4,
    deep: 0x1a5690,
    shallow: 0x1a6270,
    scatter: 0x7a7a5a,
    foam: 0.9,
    leaf: 0.85,
    leafE: 0.8,
    town: 0.32,
    hdri: 0.75,
    ground: 0x5a5048,
  },
  {
    ...DAY,
    elev: 1,
    zenith: 0x34508e,
    mid: 0x7a78a8,
    horizon: 0xffa868,
    glow: 0xff8a48,
    glowAmt: 0.8,
    band: 0.8,
    sunCol: 0xff9c5c,
    sunI: 1.5,
    fillCol: 0xb8bce0,
    fillI: 0.25,
    rimCol: 0xff9c6c,
    rimI: 0.6,
    hemiSky: 0xa8a2c0,
    hemiGround: 0x6a5048,
    hemiI: 0.42,
    fog: 0xd89a80,
    env: 0.26,
    cloud: 0xffb48c,
    deep: 0x18467c,
    shallow: 0x1c5262,
    scatter: 0xa0603e,
    foam: 0.75,
    leaf: 0.6,
    leafE: 0.6,
    town: 0.22,
    hdri: 0.35,
    ground: 0x3a3034,
  },
  {
    ...DAY,
    elev: -4,
    zenith: 0x1a2858,
    mid: 0x3e4880,
    horizon: 0xc07a6a,
    glow: 0xa85a50,
    glowAmt: 0.5,
    band: 0.6,
    sunCol: 0xff8a50,
    sunI: 0.6,
    fillCol: 0x8a98c8,
    fillI: 0.22,
    rimCol: 0x9aa8e0,
    rimI: 0.4,
    hemiSky: 0x6a74a8,
    hemiGround: 0x3a3440,
    hemiI: 0.42,
    fog: 0x4c5276,
    env: 0.9,
    cloud: 0x9a8090,
    deep: 0x0d2a50,
    shallow: 0x102e40,
    scatter: 0x3a3050,
    foam: 0.45,
    leaf: 0.15,
    leafE: 0.3,
    town: 0.04,
    hdri: 0,
    ground: 0x1c1e2a,
  },
  {
    ...DAY,
    elev: -10,
    zenith: 0x0b1634,
    mid: 0x16244c,
    horizon: 0x3a3c64,
    glow: 0x3a3c64,
    glowAmt: 0.2,
    band: 0.15,
    sunCol: 0x000000,
    sunI: 0,
    fillCol: 0x7a8cc0,
    fillI: 0.2,
    rimCol: 0x9ab0f0,
    rimI: 0.38,
    hemiSky: 0x3e4c80,
    hemiGround: 0x1e1c26,
    hemiI: 0.38,
    fog: 0x1e2644,
    env: 1,
    cloud: 0x363c54,
    deep: 0x06183a,
    shallow: 0x08202e,
    scatter: 0x1a2040,
    foam: 0.28,
    leaf: 0.06,
    leafE: 0.15,
    town: 0,
    hdri: 0,
    ground: 0x0e1018,
  },
  {
    ...DAY,
    elev: -18,
    zenith: 0x050b1e,
    mid: 0x0a1636,
    horizon: 0x1c2648,
    glow: 0x1c2648,
    glowAmt: 0,
    band: 0,
    sunCol: 0x000000,
    sunI: 0,
    fillCol: 0x7088c0,
    fillI: 0.18,
    rimCol: 0x9ab4ff,
    rimI: 0.36,
    hemiSky: 0x34446e,
    hemiGround: 0x16161c,
    hemiI: 0.36,
    fog: 0x121a32,
    env: 1,
    cloud: 0x242a3e,
    deep: 0x041430,
    shallow: 0x061a26,
    scatter: 0x101830,
    foam: 0.2,
    leaf: 0.05,
    leafE: 0.12,
    town: 0,
    hdri: 0,
    ground: 0x0a0c14,
  },
  { ...DAY, elev: -90 },
];
// 最后一帧和 -18° 一样（太阳再低也是夜）
KEYS[KEYS.length - 1] = { ...KEYS[KEYS.length - 2], elev: -90 };

type ColorKeys = { [K in keyof Key]: Key[K] extends number ? K : never }[keyof Key];
const COLOR_FIELDS = [
  'zenith',
  'mid',
  'horizon',
  'glow',
  'sunCol',
  'fillCol',
  'rimCol',
  'hemiSky',
  'hemiGround',
  'fog',
  'cloud',
  'deep',
  'shallow',
  'scatter',
  'ground',
] as const satisfies readonly ColorKeys[];
const NUM_FIELDS = ['glowAmt', 'band', 'sunI', 'fillI', 'rimI', 'hemiI', 'env', 'foam', 'leaf', 'leafE', 'town', 'hdri'] as const satisfies readonly ColorKeys[];

export type Palette = { [K in (typeof COLOR_FIELDS)[number]]: THREE.Color } & { [K in (typeof NUM_FIELDS)[number]]: number };

export function createPalette(): Palette {
  const p = {} as Palette;
  for (const k of COLOR_FIELDS) p[k] = new THREE.Color();
  for (const k of NUM_FIELDS) p[k] = 0;
  return p;
}

const _a = new THREE.Color();
const _b = new THREE.Color();
/** 太阳高度 elev（度）时的那一套颜色，写进 out */
export function samplePalette(elev: number, out: Palette) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].elev > elev) i++;
  const hi = KEYS[i];
  const lo = KEYS[i + 1];
  const t = THREE.MathUtils.clamp((hi.elev - elev) / (hi.elev - lo.elev), 0, 1);
  const k = t * t * (3 - 2 * t);
  for (const f of COLOR_FIELDS) out[f].copy(_a.setHex(hi[f])).lerp(_b.setHex(lo[f]), k);
  for (const f of NUM_FIELDS) out[f] = hi[f] + (lo[f] - hi[f]) * k;
  return out;
}

const DEG = Math.PI / 180;
/** 方位角 a（场景里的 atan2(z, x)，度）、高度角 e（度）→ 单位向量 */
export function dirOf(aDeg: number, eDeg: number, out = new THREE.Vector3()) {
  const a = aDeg * DEG;
  const e = eDeg * DEG;
  return out.set(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
}

/**
 * 天文 → 场景：sunPos = 白天那一档太阳在场景里的方向（SUN_POS）。
 * 天文方位角从正北顺时针、场景的 atan2(z, x) 从上往下看也是顺时针（x 向右、z 朝屏幕下方），差一个常数
 */
export function createSkyMapping(sunPos: [number, number, number]) {
  const ref = presetSun('day');
  const offset = Math.atan2(sunPos[2], sunPos[0]) / DEG - ref.az;
  return {
    sun(t: TimeState, out: THREE.Vector3) {
      return dirOf(t.sunAz + offset, t.sunElev, out);
    },
    /**
     * 月亮：夜里从正前方（海上）升起、往右挪，最高 11.5°；白天在地平线以下。
     * 21:30 左右在默认机位里她头的右上方（正前方偏右 12°、离地 8~9°），不被头挡住
     */
    moon(t: TimeState, out: THREE.Vector3) {
      if (t.nightP < 0) return dirOf(-85, -10, out);
      const p = t.nightP;
      return dirOf(-88 + 40 * p, 1.5 + 10 * Math.sin(Math.PI * p), out);
    },
  };
}

/** 月亮被照亮的比例（0 新月 … 1 满月） */
export const moonIllum = (phase: number) => (1 - Math.cos(phase * Math.PI * 2)) / 2;

const _m = new THREE.Color();
/**
 * 清晨和黄昏的太阳高度一样，颜色不一样：清晨偏粉、偏冷，雾是淡淡的蓝灰，太阳没那么红；
 * 黄昏更橙、更浓。按调色表（黄昏的那一套）往清晨的颜色拉，只在太阳离地平线不远的时候拉（-8° 到 20°）
 */
export function morningTint(pal: Palette, hours: number, elev: number) {
  const k = (1 - smoothstep(10.5, 12.5, hours)) * smoothstep(-8, -2, elev) * (1 - smoothstep(8, 20, elev));
  if (k <= 0) return;
  pal.glow.lerp(_m.setHex(0xffd0c0), 0.5 * k);
  pal.horizon.lerp(_m.setHex(0xf2d4cc), 0.4 * k);
  pal.band *= 1 - 0.35 * k;
  pal.sunCol.lerp(_m.setHex(0xffd6b8), 0.45 * k);
  pal.rimCol.lerp(_m.setHex(0xffd8c8), 0.4 * k);
  pal.fog.lerp(_m.setHex(0xd2d6e2), 0.45 * k);
  pal.cloud.lerp(_m.setHex(0xffdcd4), 0.35 * k);
  pal.scatter.lerp(_m.setHex(0x5a7a8a), 0.4 * k);
}
function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
