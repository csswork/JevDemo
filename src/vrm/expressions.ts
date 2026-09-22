import type { VRM } from '@pixiv/three-vrm';
import type { Emotion } from '../act/schema';
import { damp, smoothstep } from './pose';

/**
 * 表情层。半身景别下这是全部的戏，所以做得比其他层厚。
 *
 * 四件事：
 *   1. 混合而非切换 —— 真人的脸很少是单一情绪，happy 0.7 + surprised 0.2 才像"惊喜"。
 *   2. 微表情 —— 在主情绪之上叠很短很轻的闪动。这是"有内心活动"和"贴图"的分界线。
 *   3. 眨眼 —— 除了随机眨，还在表情切换的瞬间补一次，真人换表情时几乎必然眨眼。
 *   4. 让位给口型 —— VRM 的情绪 blendshape 是整脸烘焙的，见 mouthOcclusion()。
 *
 * 表情槽名字在不同模型上不统一：VRM 0.x 规范里没有 surprised，VRoid 把它塞在自定义槽
 * "Surprised"（大写 S）里。所以这里做大小写无关解析，找不到再降级到最接近的替代，
 * 而不是静默失败。
 */

/** 解析不到时的降级链 */
const FALLBACK: Record<Emotion, Emotion[]> = {
  neutral: [],
  happy: ['relaxed'],
  angry: ['sad'],
  sad: ['relaxed'],
  relaxed: ['happy'],
  surprised: ['happy'],
};

/** 微表情从哪儿取材：主情绪 → 可能闪过的相邻情绪 */
const ADJACENT: Record<Emotion, Emotion[]> = {
  neutral: ['relaxed', 'sad', 'surprised'],
  happy: ['relaxed', 'surprised'],
  angry: ['sad', 'surprised'],
  sad: ['angry', 'relaxed'],
  relaxed: ['happy', 'sad'],
  surprised: ['happy', 'angry'],
};

const ALL_EMOTIONS: Emotion[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

/**
 * 模型标定：每个情绪在**这个**模型上真正可用的权重上限。
 *
 * 为什么需要这一层：Jev 说的是语义强度（"非常开心"=1.0），但同一个 1.0 在不同模型上
 * 长相天差地别。实测这个 VRoid 模型：
 *   happy     0.5 是带笑的睁眼笑；超过 0.6 眼睛会闭成 ^^，再配上说话就像在打哈欠
 *   surprised 1.0 嘴张成 O 型，会把 viseme 完全吃掉，0.75 左右刚好
 *   angry / sad / relaxed  可以给满，眉眼变化清楚且不闭眼
 *
 * 把上限放在渲染侧而不是决策侧：换模型时只改这张表，Jev 的 prompt 一个字都不用动。
 * 反过来把它写进 prompt，就等于让语言模型去记每个模型的 blendshape 脾气。
 */
export type ExpressionCeiling = Partial<Record<Emotion, number>>;

export const DEFAULT_CEILING: ExpressionCeiling = {
  neutral: 1,
  happy: 0.55,
  angry: 1,
  sad: 1,
  relaxed: 1,
  surprised: 0.75,
};

interface Flick {
  key: string;
  peak: number;
  duration: number;
  t: number;
}

export class ExpressionLayer {
  private resolved = new Map<Emotion, string | null>();
  private base = new Map<string, number>();
  private current = new Map<string, number>();
  private lambda = new Map<string, number>();
  private flicks: Flick[] = [];
  /** UI 试听用的手动覆盖，优先级最高 */
  private overrides = new Map<string, number>();

  private blinkKey: string | null = null;
  private blinkLeftKey: string | null = null;
  private blinkRightKey: string | null = null;
  private nextBlink = 2;
  private blinkPhase = -1;
  private blinkDuration = 0.13;
  private blinkTarget: string | null = null;

  private nextMicro = 3;
  private dominant: Emotion = 'neutral';
  private speaking = false;

  /** 模型实际拥有的全部表情槽名字，供试听面板列出来 */
  available: string[] = [];
  microEnabled = true;
  ceiling: ExpressionCeiling = { ...DEFAULT_CEILING };

  bind(vrm: VRM) {
    this.resolved.clear();
    this.base.clear();
    this.current.clear();
    this.flicks.length = 0;
    this.overrides.clear();

    const mgr = vrm.expressionManager;
    if (!mgr) return;

    const names = mgr.expressions.map((e) => e.expressionName);
    this.available = names;
    const find = (want: string) =>
      names.find((n) => n === want) ??
      names.find((n) => n.toLowerCase() === want.toLowerCase()) ??
      null;

    for (const emo of ALL_EMOTIONS) {
      let key = find(emo);
      if (!key) {
        for (const alt of FALLBACK[emo]) {
          key = find(alt);
          if (key) break;
        }
      }
      this.resolved.set(emo, key);
    }
    this.blinkKey = find('blink');
    this.blinkLeftKey = find('blinkLeft');
    this.blinkRightKey = find('blinkRight');
  }

  /** emotion → 模型上真实的槽名，调试面板用 */
  get resolvedMap(): Record<string, string | null> {
    return Object.fromEntries(this.resolved);
  }

  setSpeaking(v: boolean) {
    this.speaking = v;
  }

  /**
   * 设定单个情绪的目标权重，其余不动（可叠加）。
   * 传入的是**语义强度** 0..1，经过 ceiling 标定后才落到 blendshape 上。
   */
  set(emo: Emotion, weight: number, fade = 0.25) {
    const key = this.resolved.get(emo);
    if (!key) return;
    const w = Math.max(0, Math.min(1, weight)) * (this.ceiling[emo] ?? 1);
    this.base.set(key, w);
    this.lambda.set(key, fade > 0 ? 3 / fade : 30);
    if (weight > 0.3) this.dominant = emo;
  }

  /**
   * 换一个主情绪：目标情绪淡入，其余淡出。
   * 换表情时补一次眨眼 —— 真人几乎不会睁着眼把一个表情"渐变"成另一个。
   */
  setExclusive(emo: Emotion, weight: number, fade = 0.25) {
    const keep = this.resolved.get(emo);
    let changed = false;
    for (const key of this.base.keys()) {
      if (key !== keep && (this.base.get(key) ?? 0) > 0.05) {
        this.base.set(key, 0);
        this.lambda.set(key, fade > 0 ? 3 / fade : 30);
        changed = true;
      }
    }
    this.set(emo, weight, fade);
    if (changed && this.blinkPhase < 0 && Math.random() < 0.75) {
      this.blinkPhase = 0;
      this.blinkTarget = this.blinkKey;
    }
  }

  /** 一次给多个情绪设权重，用于混合表情。 */
  setBlend(mix: Partial<Record<Emotion, number>>, fade = 0.25) {
    const wanted = new Set<string>();
    for (const [emo, w] of Object.entries(mix) as Array<[Emotion, number]>) {
      const key = this.resolved.get(emo);
      if (key) wanted.add(key);
      this.set(emo, w, fade);
    }
    for (const key of this.base.keys()) {
      if (!wanted.has(key)) {
        this.base.set(key, 0);
        this.lambda.set(key, fade > 0 ? 3 / fade : 30);
      }
    }
  }

  /** 微表情：一次快起快落的闪动，叠在主情绪之上，不改变 base。 */
  flick(emo: Emotion, peak = 0.18, duration = 0.5) {
    const key = this.resolved.get(emo);
    if (!key) return;
    this.flicks.push({ key, peak: peak * (this.ceiling[emo] ?? 1), duration, t: 0 });
  }

  setCeiling(emo: Emotion, value: number) {
    this.ceiling[emo] = Math.max(0, Math.min(1, value));
  }

  /** 眨单眼。模型没有 blinkLeft/Right 时退化成普通眨眼。 */
  wink(side: 'left' | 'right' = 'left') {
    this.blinkTarget =
      (side === 'left' ? this.blinkLeftKey : this.blinkRightKey) ?? this.blinkKey;
    this.blinkPhase = 0;
  }

  /** UI 试听：直接把某个槽钉在指定权重；传 null 取消。 */
  override(name: string, weight: number | null) {
    if (weight == null) this.overrides.delete(name);
    else this.overrides.set(name, Math.max(0, Math.min(1, weight)));
  }

  clearOverrides() {
    this.overrides.clear();
  }

  get overrideEntries(): Array<[string, number]> {
    return [...this.overrides.entries()];
  }

  /**
   * 情绪对嘴部的占用程度。
   *
   * VRM 的情绪 blendshape 是整脸烘焙的 —— VRoid 的 happy 同时改眼睛和嘴，
   * 而 viseme 也改嘴，两者叠满就成了"打哈欠"。blendshape 无法拆解，
   * 只能让口型给情绪让位：情绪越强，viseme 幅度越小。
   * 情绪本身仍然靠眼睛和眉毛读得出来，观感几乎无损。
   */
  mouthOcclusion(): number {
    let max = 0;
    for (const [emo, key] of this.resolved) {
      if (emo === 'neutral' || !key) continue;
      max = Math.max(max, this.current.get(key) ?? 0);
    }
    return Math.min(1, max);
  }

  update(dt: number, vrm: VRM) {
    const mgr = vrm.expressionManager;
    if (!mgr) return;

    // --- 微表情调度 ---
    if (this.microEnabled) {
      this.nextMicro -= dt;
      if (this.nextMicro <= 0) {
        // 说话时更频繁：讲话的人脸上一直有小动作
        this.nextMicro = (this.speaking ? 1.1 : 2.4) + Math.random() * 2.2;
        const pool = ADJACENT[this.dominant] ?? ADJACENT.neutral;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        this.flick(pick, 0.08 + Math.random() * 0.14, 0.35 + Math.random() * 0.4);
      }
    }

    // --- 主情绪阻尼 + 微表情叠加 ---
    const additive = new Map<string, number>();
    for (let i = this.flicks.length - 1; i >= 0; i--) {
      const f = this.flicks[i];
      f.t += dt;
      if (f.t >= f.duration) {
        this.flicks.splice(i, 1);
        continue;
      }
      // 起快落慢的包络
      const k = f.t / f.duration;
      const env = k < 0.3 ? smoothstep(k / 0.3) : smoothstep(1 - (k - 0.3) / 0.7);
      additive.set(f.key, (additive.get(f.key) ?? 0) + f.peak * env);
    }

    for (const [key, tgt] of this.base) {
      const cur = damp(this.current.get(key) ?? 0, tgt, this.lambda.get(key) ?? 12, dt);
      this.current.set(key, cur);
    }
    for (const key of additive.keys()) {
      if (!this.current.has(key)) this.current.set(key, 0);
    }

    for (const [key, cur] of this.current) {
      const ov = this.overrides.get(key);
      const value = ov != null ? ov : Math.min(1, cur + (additive.get(key) ?? 0));
      mgr.setValue(key, value);
    }
    // 只被 override 钉住、从未出现在 current 里的槽（比如 Extra）
    for (const [key, w] of this.overrides) {
      if (!this.current.has(key)) mgr.setValue(key, w);
    }

    this.updateBlink(dt, mgr);
  }

  private updateBlink(dt: number, mgr: NonNullable<VRM['expressionManager']>) {
    if (!this.blinkKey) return;

    if (this.blinkPhase >= 0) {
      const key = this.blinkTarget ?? this.blinkKey;
      this.blinkPhase += dt;
      const k = this.blinkPhase / this.blinkDuration;
      if (k >= 1) {
        this.blinkPhase = -1;
        if (!this.overrides.has(key)) mgr.setValue(key, 0);
        this.blinkTarget = null;
      } else if (!this.overrides.has(key)) {
        // 闭合快、睁开慢，和真人一致
        mgr.setValue(key, k < 0.4 ? k / 0.4 : 1 - (k - 0.4) / 0.6);
      }
      return;
    }

    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blinkPhase = 0;
      this.blinkTarget = this.blinkKey;
      const base = this.speaking ? 2.2 : 3.4;
      this.nextBlink = base + Math.random() * 2.8;
      // 偶尔连眨两次
      if (Math.random() < 0.2) this.nextBlink = 0.22;
    }
  }

  /** 当前生效的表情权重，用于调试面板。 */
  snapshot(): Array<[string, number]> {
    return [...this.current.entries()]
      .map(([k, v]) => [k, this.overrides.get(k) ?? v] as [string, number])
      .filter(([, v]) => v > 0.01)
      .sort((a, b) => b[1] - a[1]);
  }
}
