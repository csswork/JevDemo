/**
 * 一天里的时间：太阳在哪、天黑了没有、月相（街景的昼夜用，见 scenes/streetTime.ts）。
 *
 * 太阳按北纬 34°（日本的海边小镇）用简化的天文公式算：赤纬（按一年里的第几天）、时角（按当地的太阳时）→ 高度角、方位角。
 * 本机时钟直接当太阳时用（不按经度、时区修正）：晚上七点打开就是傍晚，够了。
 *
 * 几种模式：
 *   now    跟随现在（本机的时钟和日期，每 10 秒更新一次；冬天的白天短、太阳低）
 *   dawn / day / dusk / night   固定在某个时段，都按参考日期（5 月 20 日）算，换季节也是同一个画面：
 *          清晨 = 日出后 20 分钟，白天 = 下午太阳离地 46.4° 的时候（街景的光就是按这个高度调的），
 *          黄昏 = 日落前 10 分钟，夜晚 = 21:30
 * 换模式的时候花 3 秒从原来的时间走到新的时间（往近的那个方向走），不是一下跳过去。
 */

export type TimeMode = 'now' | 'dawn' | 'day' | 'dusk' | 'night';
export const TIME_MODES: Array<{ id: TimeMode; label: string }> = [
  { id: 'now', label: '跟随现在' },
  { id: 'dawn', label: '清晨' },
  { id: 'day', label: '白天' },
  { id: 'dusk', label: '黄昏' },
  { id: 'night', label: '夜晚' },
];

export interface TimeState {
  /** 当地的太阳时，0..24 */
  hours: number;
  /** 一年里的第几天（1..365，小数也行） */
  day: number;
  /** 太阳高度角（度，地平线以下是负的） */
  sunElev: number;
  /** 太阳方位角（度，从正北顺时针：东 90、南 180、西 270） */
  sunAz: number;
  /** 这一天的日出、日落（太阳时） */
  sunrise: number;
  sunset: number;
  /** 月相：0 新月、0.25 上弦、0.5 满月、0.75 下弦 */
  moonPhase: number;
  /** 夜里走到哪了：日落 = 0 → 第二天日出 = 1；白天是 -1 */
  nightP: number;
}

const LAT = rad(34);
/** 参考日期：5 月 20 日（固定时段都按这一天算） */
const REF_DAY = 140;
/** "白天"那一档的太阳高度（度）：街景的主光离地约 46.4°（SUN_POS），白天的画面和加时间之前一样 */
export const DAY_ELEV = 46.4;
const TRANSITION = 3;

function rad(d: number) {
  return (d * Math.PI) / 180;
}
const DEG = 180 / Math.PI;

/** 太阳赤纬（弧度） */
function declination(day: number) {
  return rad(-23.44) * Math.cos(((2 * Math.PI) / 365) * (day + 10));
}

/** 太阳的高度角、方位角（度） */
export function sunPosition(day: number, hours: number) {
  const d = declination(day);
  const H = rad(15 * (hours - 12));
  const sinAlt = Math.sin(LAT) * Math.sin(d) + Math.cos(LAT) * Math.cos(d) * Math.cos(H);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
  const az = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(d) * Math.cos(LAT)) * DEG + 180 + 360) % 360;
  return { elev, az };
}

/** 太阳到某个高度（度）时的时角（小时，离正午多远）；永远到不了就是 null */
function hourAngleAt(day: number, elev: number) {
  const d = declination(day);
  const c = (Math.sin(rad(elev)) - Math.sin(LAT) * Math.sin(d)) / (Math.cos(LAT) * Math.cos(d));
  if (c < -1 || c > 1) return null;
  return (Math.acos(c) * DEG) / 15;
}

/** 日出、日落（太阳中心在地平线下 0.833°：大气折射 + 太阳的半径） */
function sunTimes(day: number) {
  const h = hourAngleAt(day, -0.833) ?? 6;
  return { sunrise: 12 - h, sunset: 12 + h };
}

/** 月相（0..1）：按一个已知的新月（2000-01-06 18:14 UTC）和朔望月的长度算 */
function moonPhaseOf(date: Date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const p = (jd - 2451550.26) / 29.530588853;
  return p - Math.floor(p);
}

function dayOfYear(date: Date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return (date.getTime() - start.getTime()) / 86400000;
}

/** 某个模式现在该是几点、哪一天 */
function targetOf(mode: TimeMode | number, now: Date): { hours: number; day: number; phase: number } {
  if (typeof mode === 'number') return { hours: mode, day: REF_DAY, phase: 0.38 };
  if (mode === 'now') {
    return { hours: now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600, day: dayOfYear(now), phase: moonPhaseOf(now) };
  }
  const { sunrise, sunset } = sunTimes(REF_DAY);
  // 固定时段：盈凸月（亮、又不是一个死板的正圆）
  const phase = 0.38;
  if (mode === 'dawn') return { hours: sunrise + 20 / 60, day: REF_DAY, phase };
  if (mode === 'dusk') return { hours: sunset - 10 / 60, day: REF_DAY, phase };
  if (mode === 'night') return { hours: 21.5, day: REF_DAY, phase };
  return { hours: 12 + (hourAngleAt(REF_DAY, DAY_ELEV) ?? 3), day: REF_DAY, phase };
}

const wrap24 = (h: number) => ((h % 24) + 24) % 24;

export class TimeOfDay {
  private mode: TimeMode | number = 'day';
  private hours = 15;
  private day = REF_DAY;
  private phase = 0.38;
  /** 过渡：从 from 走到 to（小时差按近的那个方向），走了 t 秒 */
  private tween: { h0: number; dh: number; d0: number; dd: number; p: number; t: number } | null = null;
  private poll = 0;
  readonly state: TimeState = { hours: 15, day: REF_DAY, sunElev: DAY_ELEV, sunAz: 240, sunrise: 5, sunset: 19, moonPhase: 0.38, nightP: -1 };

  constructor() {
    this.jump();
  }

  get current(): TimeMode | number {
    return this.mode;
  }

  /** 换模式；instant = 直接跳过去（截图、刚打开页面） */
  setMode(mode: TimeMode | number, instant = false) {
    this.mode = mode;
    if (instant) this.jump();
    else this.startTween();
  }

  private jump() {
    const t = targetOf(this.mode, new Date());
    this.hours = t.hours;
    this.day = t.day;
    this.phase = t.phase;
    this.tween = null;
    this.compute();
  }

  private startTween() {
    const t = targetOf(this.mode, new Date());
    let dh = wrap24(t.hours - this.hours);
    if (dh > 12) dh -= 24;
    this.tween = { h0: this.hours, dh, d0: this.day, dd: t.day - this.day, p: t.phase, t: 0 };
  }

  update(dt: number) {
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const k = Math.min(1, tw.t / TRANSITION);
      const e = k * k * (3 - 2 * k);
      this.hours = wrap24(tw.h0 + tw.dh * e);
      this.day = tw.d0 + tw.dd * e;
      if (k >= 1) {
        this.phase = tw.p;
        this.tween = null;
      }
    } else if (this.mode === 'now') {
      // 跟随现在：每 10 秒对一次表（差得多 —— 比如电脑睡了一觉 —— 就过渡过去）
      this.poll -= dt;
      if (this.poll <= 0) {
        this.poll = 10;
        const t = targetOf('now', new Date());
        let dh = wrap24(t.hours - this.hours);
        if (dh > 12) dh -= 24;
        if (Math.abs(dh) > 0.2) this.startTween();
        else {
          this.hours = t.hours;
          this.day = t.day;
          this.phase = t.phase;
        }
      }
    }
    this.compute();
  }

  private compute() {
    const s = this.state;
    const { elev, az } = sunPosition(this.day, this.hours);
    const { sunrise, sunset } = sunTimes(this.day);
    s.hours = this.hours;
    s.day = this.day;
    s.sunElev = elev;
    s.sunAz = az;
    s.sunrise = sunrise;
    s.sunset = sunset;
    s.moonPhase = this.phase;
    const night = sunrise + 24 - sunset;
    const since = wrap24(this.hours - sunset);
    s.nightP = since <= night ? since / night : -1;
  }
}

/** 某个固定时段的太阳在哪（街景拿"白天"那一档对齐场景的方位） */
export function presetSun(mode: Exclude<TimeMode, 'now'>) {
  const t = targetOf(mode, new Date());
  return sunPosition(t.day, t.hours);
}
