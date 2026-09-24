import type { VRM } from '@pixiv/three-vrm';
import type { Cue, Emotion } from '../act/schema';
import { bindFaceRig, SHAPES, type FacePart, type FaceRig, type Shape } from './faceRig';
import { damp, smoothstep } from './pose';

/**
 * 表情层。半身景别下这是全部的戏，所以做得比其他层厚。
 *
 * **情绪是什么、多强，全部来自 Jev**（经 composeAct 变成 setBlend 的混合）。
 * 这一层只负责"一张脸怎么动起来像人"，相当于表情的物理：
 *
 *   1. 分部位合成 —— 情绪 → 眉 / 眼 / 嘴三个部位的形状（faceRig.ts）。混合情绪按部位合成，
 *      而且遵循表情研究里的"泄露"规律：下半张脸（嘴）受意识控制、会用笑去掩饰，
 *      上半张脸（眉眼）更诚实。所以 sad + happy 合出来是"眉眼委屈、嘴在笑"的苦笑，
 *      而不是两张整脸叠在一起又哭又笑
 *   2. 部位错峰 —— 换表情时眉先动、眼睛随后、嘴最后（约 85ms），不是整张脸同时变
 *   3. 起落不对称 + 峰值回落 —— 每个表情先到峰值再回落到约 84%，淡出比淡入慢；
 *      平滑用临界阻尼弹簧，起止速度为零，不是线性插值
 *   4. 让位给口型 —— 嘴在发音节时张开类的嘴形让出来，停顿处回来；说话时笑眼不闭死
 *   5. 对话信号 —— 句界眨眼、问句睁眼、感叹时一闪，都是不带情绪的节奏信号
 *   6. 余韵 —— 说完不会立刻回到面无表情，而是分几段慢慢淡成残留的心情
 *   7. 情绪惯性 —— 一句话里前一段在笑、后一段 Jev 判成 neutral 时，脸不会半秒内
 *      变成一片空白，而是留着一点笑意。只在当前段本身情绪很弱时起作用，
 *      新来的强情绪不会被上一个情绪污染
 *   8. 微表情、眨眼、倾听 / 思考时的神态
 *
 * 模型没有分部位形状时（faceRig 返回 null），退回整脸预设，第 2~4 条随之失效，
 * 其他照常。
 */

type Mix = Partial<Record<Emotion, number>>;
type Feeling = Exclude<Emotion, 'neutral'>;

/** 每个情绪满强度时由哪些部位形状组成 */
const RECIPES: Record<Feeling, Partial<Record<Shape, number>>> = {
  happy: { brow_happy: 0.6, eye_smile: 0.6, mouth_smile: 0.75, mouth_grin: 0.3 },
  relaxed: { brow_relaxed: 0.5, eye_smile: 0.28, mouth_smile: 0.6 },
  sad: { brow_sad: 0.95, eye_sad: 0.7, mouth_frown: 0.5, mouth_sad: 0.25 },
  angry: { brow_angry: 0.9, eye_angry: 0.65, mouth_pout: 0.65 },
  surprised: { brow_surprised: 1, eye_wide: 0.8, mouth_o: 0.45 },
};

/**
 * 各部位对各情绪的"诚实度"。眉毛泄露负面情绪，嘴偏向正面情绪。
 * 另外见 compose() 里的掩饰规则：同时有正负情绪时，嘴上的负面再压一半。
 */
const PART_BIAS: Record<FacePart, Record<Feeling, number>> = {
  brow: { happy: 0.8, relaxed: 0.7, sad: 1.15, angry: 1.1, surprised: 1.1 },
  eye: { happy: 1, relaxed: 1, sad: 1, angry: 1, surprised: 1 },
  mouth: { happy: 1.1, relaxed: 1.1, sad: 0.85, angry: 0.9, surprised: 0.9 },
};

/**
 * 形状上限（模型标定）。在 Sendagaya_Shino 上实测：
 *   eye_smile 1.0 是完全闭眼的 ^^，说话时闭眼像打哈欠，所以说话时封顶 0.5
 *   mouth_grin / mouth_o 是大张嘴，超过 0.6 会把口型完全吃掉
 * 换模型时改这张表，Jev 一个字都不用动。
 */
const SHAPE_CAP: Partial<Record<Shape, number>> = {
  eye_smile: 0.85,
  mouth_grin: 0.6,
  mouth_o: 0.55,
  eye_wide: 0.85,
  eye_squeeze: 0.9,
};
const EYE_SMILE_CAP_SPEAKING = 0.5;
const PART_CAP = 1.15;

/** 部位错峰：眉先、眼随后、嘴最后 */
const PART_DELAY: Record<FacePart, number> = { brow: 0, eye: 0.035, mouth: 0.085 };
/** 部位快慢：眉最快，嘴最慢 */
const PART_SPEED: Record<FacePart, number> = { brow: 0.85, eye: 1, mouth: 1.2 };
/** 淡出比淡入慢多少 */
const RELEASE_SLOWDOWN = 1.8;
/** 峰值回落：到峰值后回落到多少，用多久 */
const APEX_RELAX = 0.84;
const APEX_TAU = 0.9;
/**
 * 情绪惯性：心情跟着最近的情绪走，上得快（2s）、下得慢（6s）。
 * 当前段情绪很弱时，脸上最多透出 45% 的心情。
 *
 * 实测动机：「哎哟恭喜啊！……低一点是多少？」Jev 判成 happy 0.91 → neutral 0.76，
 * 没有惯性时笑容在 0.5s 内完全消失，问句是一张空白的脸说出来的。
 */
const MOOD_RISE = 2;
const MOOD_FALL = 6;
const MOOD_CARRY = 0.45;

/** 微表情素材：主情绪 → 可能闪过的部位动作 */
const MICRO: Record<Emotion, Array<Partial<Record<Shape, number>>>> = {
  neutral: [{ mouth_smile: 0.5 }, { eye_smile: 0.35 }, { brow_sad: 0.5 }, { eye_wide: 0.35 }],
  happy: [{ eye_smile: 0.6 }, { mouth_grin: 0.45 }, { brow_happy: 0.5 }, { mouth_smile: 0.4 }],
  relaxed: [{ mouth_smile: 0.6 }, { eye_smile: 0.45 }],
  sad: [{ brow_sad: 0.7 }, { mouth_frown: 0.6 }, { eye_sad: 0.4 }],
  angry: [{ eye_angry: 0.6 }, { mouth_pout: 0.5 }, { brow_angry: 0.5 }],
  surprised: [{ eye_wide: 0.6 }, { mouth_o: 0.3 }],
};

/** 对话状态的神态（叠加层，不是情绪） */
export type ConversationState = 'idle' | 'listening' | 'thinking' | 'speaking';
const STATE_ADD: Record<ConversationState, Partial<Record<Shape, number>>> = {
  idle: {},
  // 听人说话：眼睛稍微睁开一点
  listening: { eye_wide: 0.07 },
  // 想事情：眼睑微压（专注）、抿嘴
  thinking: { eye_angry: 0.13, mouth_frown: 0.35 },
  speaking: {},
};


/** 整脸预设的降级链（没有分部位形状时用） */
const FALLBACK: Record<Emotion, Emotion[]> = {
  neutral: [],
  happy: ['relaxed'],
  angry: ['sad'],
  sad: ['relaxed'],
  relaxed: ['happy'],
  surprised: ['happy'],
};

const ALL_EMOTIONS: Emotion[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const FEELINGS: Feeling[] = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

/**
 * 情绪 → 整脸预设的权重上限。**只在没有分部位形状的模型上用**：整脸预设同时改眉眼嘴，
 * 实测这个模型 happy 超过 0.6 眼睛就闭成 ^^，surprised 1.0 嘴张成 O 吃掉口型。
 * 分部位时上限落在 SHAPE_CAP 上，这里全是 1。
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
const NO_CEILING: ExpressionCeiling = { neutral: 1, happy: 1, angry: 1, sad: 1, relaxed: 1, surprised: 1 };

interface MixEntry {
  t: number;
  mix: Mix;
  fade: number;
  /** 是否有"到峰值再回落"。余韵那几段淡出没有 */
  apex: boolean;
}

interface Pulse {
  shapes: Map<string, number>;
  duration: number;
  t: number;
  /** 起 / 落的分界（0..1） */
  attack: number;
}

/** 临界阻尼弹簧（Game Programming Gems 4 的 SmoothDamp）。起止速度为零，不会过冲 */
function smoothDamp(cur: number, target: number, vel: number, smoothTime: number, dt: number) {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  const v = (vel - omega * temp) * exp;
  return { value: target + (change + temp) * exp, vel: v };
}

export class ExpressionLayer {
  private rig: FaceRig | null = null;
  /** 整脸预设模式下：情绪 → 表情名 */
  private resolved = new Map<Emotion, string | null>();

  private now = 0;
  private entries: MixEntry[] = [];
  private channels = new Map<string, { value: number; vel: number }>();
  /** 语义层面的当前情绪（平滑后），给 weightOf / 调试面板 */
  private semantic = new Map<Emotion, number>();
  private pulses: Pulse[] = [];
  private stateAdd = new Map<string, number>();
  private state: ConversationState = 'idle';
  private releasePlan: Array<{ at: number; scale: number; fade: number }> = [];
  private mouthActivity = 0;
  private speaking = false;
  private mood = new Map<Feeling, number>();

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

  /** 模型实际拥有的全部表情槽名字，供试听面板列出来 */
  available: string[] = [];
  microEnabled = true;
  ceiling: ExpressionCeiling = { ...DEFAULT_CEILING };

  bind(vrm: VRM) {
    this.resolved.clear();
    this.channels.clear();
    this.entries.length = 0;
    this.pulses.length = 0;
    this.overrides.clear();

    const mgr = vrm.expressionManager;
    if (!mgr) return;

    this.rig = bindFaceRig(vrm);
    this.ceiling = this.rig ? { ...NO_CEILING } : { ...DEFAULT_CEILING };

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

  /** 分部位形状从哪来（调试面板用）；null = 用的是整脸预设 */
  get rigSource(): string | null {
    return this.rig?.source ?? null;
  }

  /** emotion → 模型上真实的槽名，调试面板用 */
  get resolvedMap(): Record<string, string | null> {
    return Object.fromEntries(this.resolved);
  }

  setSpeaking(v: boolean) {
    this.speaking = v;
  }

  /** 口型当前张开程度（0..1），由 Character 每帧从口型层喂进来 */
  setMouthActivity(v: number) {
    this.mouthActivity = Math.max(0, Math.min(1, v));
  }

  setState(s: ConversationState) {
    this.state = s;
  }

  // ---- 情绪（来自 Jev） ----

  /**
   * 一次给多个情绪设权重（混合表情）。给定的按权重叠加，没给的淡出。
   * 传入的是**语义强度** 0..1。
   */
  setBlend(mix: Mix, fade = 0.25) {
    this.releasePlan.length = 0;
    const scaled: Mix = {};
    for (const [emo, w] of Object.entries(mix) as Array<[Emotion, number]>) {
      if (!(w > 0)) continue;
      scaled[emo] = Math.min(1, w) * (this.ceiling[emo] ?? 1);
    }
    const prev = this.latest()?.mix ?? {};
    this.pushEntry(scaled, fade, true);

    const top = topOf(scaled);
    const prevTop = topOf(prev);
    if (top && top[1] > 0.15) this.dominant = top[0];
    // 换了主情绪就补一次眨眼 —— 真人几乎不会睁着眼把一个表情"渐变"成另一个
    if (top && prevTop && top[0] !== prevTop[0] && top[1] > 0.25 && prevTop[1] > 0.25) {
      if (Math.random() < 0.7) this.blink();
    }
  }

  /** 换一个主情绪（单一情绪），其余淡出 */
  setExclusive(emo: Emotion, weight: number, fade = 0.25) {
    const before = this.dominant;
    this.setBlend({ [emo]: weight }, fade);
    if (before !== emo && Math.random() < 0.75) this.blink();
  }

  /**
   * 清空所有状态（混合、心情、余韵、叠加层），立刻回到中性。
   * 只给调试 / 预览用：正常对话里情绪应该有惯性，不该一键清零。
   */
  reset() {
    this.entries.length = 0;
    this.pulses.length = 0;
    this.releasePlan.length = 0;
    this.mood.clear();
    this.semantic.clear();
    for (const ch of this.channels.values()) {
      ch.value = 0;
      ch.vel = 0;
    }
  }

  /** 在当前混合上改一个情绪，其余不动 */
  set(emo: Emotion, weight: number, fade = 0.25) {
    this.setBlend({ ...(this.latest()?.mix ?? {}), [emo]: weight }, fade);
  }

  /**
   * 说完之后的余韵：不立刻回到面无表情，先留着，再分两段淡成残留的心情，最后才归零。
   * 期间来了新的情绪（下一句、倾听时的反应）就直接取消。
   */
  release() {
    const t = this.now;
    this.releasePlan = [
      { at: t + 1.2, scale: 0.55, fade: 1.3 },
      { at: t + 5.5, scale: 0.25, fade: 2.8 },
      { at: t + 15, scale: 0, fade: 4 },
    ];
  }

  // ---- 叠加层：微表情、节奏信号 ----

  /** 一次快起快落的闪动，叠在主情绪之上，不改变 base。 */
  flick(emo: Emotion, peak = 0.18, duration = 0.5) {
    if (this.rig) {
      if (emo === 'neutral') return;
      this.pulse(RECIPES[emo], peak, duration);
      return;
    }
    const key = this.resolved.get(emo);
    if (!key) return;
    this.pulses.push({
      shapes: new Map([[key, peak * (this.ceiling[emo] ?? 1)]]),
      duration,
      t: 0,
      attack: 0.3,
    });
  }

  /** 对话节奏信号（问句、感叹、句界、笑声）。都很轻，不引入新情绪 */
  cue(kind: Cue) {
    switch (kind) {
      case 'question':
        // 问句末尾眼睛微微睁大、眉毛上抬 —— 在交出话轮
        this.pulse({ eye_wide: 1, brow_surprised: 1 }, 0.2, 0.7, 0.35);
        break;
      case 'emphasis':
        this.pulse({ eye_wide: 1 }, 0.13, 0.35);
        break;
      case 'boundary':
        // 真人倾向于在句子边界眨眼
        if (Math.random() < 0.5) this.blink();
        break;
      case 'laugh':
        // 笑声的两下起伏，只在已经带笑时才明显（叠在笑眼上）
        this.pulse({ eye_smile: 1, mouth_grin: 0.8 }, 0.18, 0.28, 0.4);
        this.pulses.push(this.makePulse({ eye_smile: 1, mouth_grin: 0.8 }, 0.15, 0.28, 0.4, -0.3));
        break;
    }
  }

  // ---- 查询 ----

  /** 某个情绪当前实际生效的权重（语义层面） */
  weightOf(emo: Emotion): number {
    return this.semantic.get(emo) ?? 0;
  }

  setCeiling(emo: Emotion, value: number) {
    this.ceiling[emo] = Math.max(0, Math.min(1, value));
  }

  /** 眨单眼。模型没有 blinkLeft/Right 时退化成普通眨眼。 */
  wink(side: 'left' | 'right' = 'left') {
    this.blinkTarget = (side === 'left' ? this.blinkLeftKey : this.blinkRightKey) ?? this.blinkKey;
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
   * 表情对嘴部的占用程度，决定口型还剩多少幅度。
   *
   * 整脸预设模式下情绪一强嘴就被占满（叠满像打哈欠），只能让口型让位。
   * 分部位时只有张嘴类的嘴形真正占嘴，闭嘴微笑和说话可以共存，口型的余量大得多。
   */
  mouthOcclusion(): number {
    if (this.rig) {
      const v = (s: Shape) => this.valueOf(s);
      const open = v('mouth_grin') + v('mouth_o') + v('mouth_sad');
      const closed = v('mouth_smile') + v('mouth_pout') + v('mouth_frown');
      return Math.min(1, open + closed * 0.3);
    }
    let max = 0;
    for (const [emo, key] of this.resolved) {
      if (emo === 'neutral' || !key) continue;
      max = Math.max(max, this.channels.get(key)?.value ?? 0);
    }
    return Math.min(1, max);
  }

  /** 当前的语义情绪（调试面板 / HUD 用） */
  snapshot(): Array<[string, number]> {
    return [...this.semantic.entries()]
      .filter(([k, v]) => k !== 'neutral' && v > 0.01)
      .sort((a, b) => b[1] - a[1]);
  }

  /** 当前各部位形状的实际值（调试用） */
  partSnapshot(): Array<[string, number]> {
    return [...this.channels.entries()]
      .map(([k, c]) => [k, c.value] as [string, number])
      .filter(([, v]) => v > 0.01)
      .sort((a, b) => b[1] - a[1]);
  }

  // ---- 每帧 ----

  update(dt: number, vrm: VRM) {
    const mgr = vrm.expressionManager;
    if (!mgr) return;
    this.now += dt;

    // 余韵计划
    while (this.releasePlan.length && this.releasePlan[0].at <= this.now) {
      const step = this.releasePlan.shift()!;
      const base = this.releaseBase();
      const mix: Mix = {};
      for (const [emo, w] of Object.entries(base) as Array<[Emotion, number]>) {
        if (w * step.scale > 0.01) mix[emo] = w * step.scale;
      }
      this.pushEntry(mix, step.fade, false);
    }

    this.scheduleMicro(dt);
    this.updateMood(dt);

    // --- 目标值：每个部位读自己延迟后的那一条混合 ---
    const targets = new Map<string, number>();
    const fadeOf = new Map<string, number>();
    const parts: FacePart[] = this.rig ? ['brow', 'eye', 'mouth'] : ['brow'];
    for (const part of parts) {
      const entry = this.activeEntry(this.rig ? PART_DELAY[part] : 0);
      if (!entry) continue;
      const env = entry.apex
        ? APEX_RELAX + (1 - APEX_RELAX) * Math.exp(-(this.now - entry.t) / APEX_TAU)
        : 1;
      const mix: Mix = {};
      for (const [emo, w] of Object.entries(entry.mix) as Array<[Emotion, number]>) mix[emo] = w * env;
      this.applyMood(mix);

      if (part === 'eye') this.trackSemantic(mix, dt);
      if (!this.rig) this.trackSemantic(mix, dt);

      const out = this.rig ? this.compose(mix, part) : this.composeWhole(mix);
      for (const [key, v] of out) {
        targets.set(key, v);
        fadeOf.set(key, entry.fade * (this.rig ? PART_SPEED[part] : 1));
      }
      if (this.rig) {
        for (const shape of Object.keys(SHAPES) as Shape[]) {
          const key = this.rig.keys[shape];
          if (key && SHAPES[shape] === part && !fadeOf.has(key)) {
            fadeOf.set(key, entry.fade * PART_SPEED[part]);
          }
        }
      }
    }

    // --- 对话状态的神态（平滑切换） ---
    // 已经有情绪上脸时（比如倾听时 Jev 给的第一反应）神态让一让，不然笑着还抿嘴
    if (this.rig) {
      const want = STATE_ADD[this.state];
      const feeling = Math.min(1, FEELINGS.reduce((s, e) => s + (this.semantic.get(e) ?? 0), 0));
      const yieldTo = 1 - 0.7 * feeling;
      const keys = new Set([
        ...this.stateAdd.keys(),
        ...Object.keys(want).map((s) => this.rig!.keys[s as Shape]),
      ]);
      for (const key of keys) {
        if (!key) continue;
        const shape = key.replace('part:', '') as Shape;
        const goal = (want[shape] ?? 0) * yieldTo;
        this.stateAdd.set(key, damp(this.stateAdd.get(key) ?? 0, goal, 4, dt));
      }
    }

    // --- 弹簧平滑 ---
    for (const key of new Set([...targets.keys(), ...this.channels.keys()])) {
      const target = targets.get(key) ?? 0;
      const ch = this.channels.get(key) ?? { value: 0, vel: 0 };
      // fade 的语义是"约 fade 秒到位"：临界阻尼弹簧 95% 到位约需 2.37 × smoothTime
      const fade = fadeOf.get(key) ?? 0.3;
      const slow = target < ch.value ? RELEASE_SLOWDOWN : 1;
      const r = smoothDamp(ch.value, target, ch.vel, (fade / 2.37) * slow, dt);
      ch.value = Math.max(0, r.value);
      ch.vel = r.vel;
      this.channels.set(key, ch);
    }

    // --- 叠加层：微表情 / 信号 ---
    const additive = new Map<string, number>();
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      if (p.t >= p.duration) {
        this.pulses.splice(i, 1);
        continue;
      }
      if (p.t < 0) continue;
      const k = p.t / p.duration;
      const env = k < p.attack ? smoothstep(k / p.attack) : smoothstep(1 - (k - p.attack) / (1 - p.attack));
      for (const [key, peak] of p.shapes) additive.set(key, (additive.get(key) ?? 0) + peak * env);
    }
    for (const [key, v] of this.stateAdd) additive.set(key, (additive.get(key) ?? 0) + v);

    // --- 写入 ---
    const written = new Set<string>();
    for (const [key, ch] of this.channels) {
      const ov = this.overrides.get(key);
      // 上限只卡叠加层。主值的目标在 compose 里已经封顶，超出的部分（比如开口说话那一刻
      // 笑眼的上限从 0.85 降到 0.5）交给弹簧慢慢回落，写入时硬卡会让眼睛一帧跳开
      const cap = this.rig ? Math.max(this.capOf(key.replace('part:', '') as Shape), ch.value) : 1;
      const value = ov != null ? ov : Math.min(cap, ch.value + (additive.get(key) ?? 0));
      mgr.setValue(key, value);
      written.add(key);
    }
    for (const [key, v] of additive) {
      if (written.has(key)) continue;
      const cap = this.rig ? this.capOf(key.replace('part:', '') as Shape) : 1;
      mgr.setValue(key, this.overrides.get(key) ?? Math.min(cap, v));
      written.add(key);
    }
    // 只被 override 钉住、别处没写的槽（比如 Extra）
    for (const [key, w] of this.overrides) {
      if (!written.has(key)) mgr.setValue(key, w);
    }

    this.updateBlink(dt, mgr);
  }

  // ---- 内部 ----

  private latest(): MixEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  private pushEntry(mix: Mix, fade: number, apex: boolean) {
    this.entries.push({ t: this.now, mix, fade: Math.max(0.05, fade), apex });
    // 只需要保留"还可能被某个部位读到"的几条：最长的部位延迟不到 0.1s
    while (this.entries.length > 4) this.entries.shift();
  }

  /** 某个部位此刻该读哪一条：满足 t + delay ≤ now 的最新一条 */
  private activeEntry(delay: number): MixEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].t + delay <= this.now) return this.entries[i];
    }
    return undefined;
  }

  /** 心情跟着最新的情绪走（不按部位延迟），上得快、下得慢 */
  private updateMood(dt: number) {
    const latest = this.latest()?.mix ?? {};
    for (const f of FEELINGS) {
      const cur = this.mood.get(f) ?? 0;
      const goal = latest[f] ?? 0;
      const tau = goal > cur ? MOOD_RISE : MOOD_FALL;
      this.mood.set(f, cur + (goal - cur) * (1 - Math.exp(-dt / tau)));
    }
  }

  /**
   * 情绪惯性：当前混合本身情绪越弱，透出的心情越多；情绪够强（合计 ≥ 1）时完全不透。
   * 取较大值而不是相加：心情只是托底，不会把已经有的情绪再推高。
   */
  private applyMood(mix: Mix) {
    const own = Math.min(1, FEELINGS.reduce((s, e) => s + (mix[e] ?? 0), 0));
    const carry = MOOD_CARRY * (1 - own);
    if (carry <= 0) return;
    for (const f of FEELINGS) {
      const m = (this.mood.get(f) ?? 0) * carry;
      if (m > (mix[f] ?? 0)) mix[f] = m;
    }
  }

  /** 余韵的起点：此刻正在显示的混合（含峰值回落后的幅度） */
  private releaseBase(): Mix {
    const out: Mix = {};
    for (const [emo, w] of this.semantic) if (w > 0.01) out[emo] = w;
    return out;
  }

  private trackSemantic(mix: Mix, dt: number) {
    for (const emo of ALL_EMOTIONS) {
      const goal = mix[emo] ?? 0;
      this.semantic.set(emo, damp(this.semantic.get(emo) ?? 0, goal, 6, dt));
    }
  }

  /** 情绪混合 → 某个部位的形状值 */
  private compose(mix: Mix, part: FacePart): Map<string, number> {
    const rig = this.rig!;
    const pos = (mix.happy ?? 0) + (mix.relaxed ?? 0);
    const neg = (mix.sad ?? 0) + (mix.angry ?? 0);
    // 中性占比高时整体收一点（"带一点笑意的平静"）
    const feelingSum = FEELINGS.reduce((s, e) => s + (mix[e] ?? 0), 0);
    const calm = feelingSum > 0 ? 1 - 0.3 * Math.min(1, mix.neutral ?? 0) : 1;

    const shapes = new Map<Shape, number>();
    for (const emo of FEELINGS) {
      const w = (mix[emo] ?? 0) * calm;
      if (w <= 0) continue;
      let bias = PART_BIAS[part][emo];
      // 掩饰：有笑意时嘴上的负面情绪再压一半；有负面时眉毛上的笑意压一半
      if (part === 'mouth' && (emo === 'sad' || emo === 'angry') && pos > 0.25) bias *= 0.45;
      if (part === 'brow' && (emo === 'happy' || emo === 'relaxed') && neg > 0.25) bias *= 0.5;
      for (const [shape, amount] of Object.entries(RECIPES[emo]) as Array<[Shape, number]>) {
        if (SHAPES[shape] !== part) continue;
        shapes.set(shape, (shapes.get(shape) ?? 0) + w * bias * amount);
      }
    }

    if (part === 'mouth') {
      // 笑和撇嘴不能同时满：弱的一方让出来
      const smile = (shapes.get('mouth_smile') ?? 0) + (shapes.get('mouth_grin') ?? 0);
      const down =
        (shapes.get('mouth_frown') ?? 0) + (shapes.get('mouth_sad') ?? 0) + (shapes.get('mouth_pout') ?? 0);
      if (smile > 0 && down > 0) {
        const weaker = smile < down ? ['mouth_smile', 'mouth_grin'] : ['mouth_frown', 'mouth_sad', 'mouth_pout'];
        for (const s of weaker as Shape[]) if (shapes.has(s)) shapes.set(s, shapes.get(s)! * 0.4);
      }
      // 让位给口型：发音节时张嘴类的嘴形让出来，停顿处回来
      const a = this.mouthActivity;
      const yieldBy: Partial<Record<Shape, number>> = {
        mouth_smile: 0.35,
        mouth_grin: 0.85,
        mouth_o: 0.85,
        mouth_sad: 0.85,
        mouth_pout: 0.6,
        mouth_frown: 0.6,
      };
      for (const [s, k] of Object.entries(yieldBy) as Array<[Shape, number]>) {
        if (shapes.has(s)) shapes.set(s, shapes.get(s)! * (1 - k * a));
      }
    }

    // 部位总量封顶：几种形状叠满会把脸拉坏
    let total = 0;
    for (const v of shapes.values()) total += v;
    const k = total > PART_CAP ? PART_CAP / total : 1;

    const out = new Map<string, number>();
    for (const [shape, v] of shapes) {
      const key = rig.keys[shape];
      if (!key) continue;
      out.set(key, Math.min(this.capOf(shape), v * k));
    }
    return out;
  }

  /** 整脸预设模式 */
  private composeWhole(mix: Mix): Map<string, number> {
    const out = new Map<string, number>();
    for (const [emo, w] of Object.entries(mix) as Array<[Emotion, number]>) {
      const key = this.resolved.get(emo);
      if (key && emo !== 'neutral') out.set(key, Math.min(1, (out.get(key) ?? 0) + w));
    }
    return out;
  }

  private capOf(shape: Shape): number {
    if (shape === 'eye_smile' && this.speaking) return EYE_SMILE_CAP_SPEAKING;
    return SHAPE_CAP[shape] ?? 1;
  }

  private valueOf(shape: Shape): number {
    const key = this.rig?.keys[shape];
    return key ? (this.channels.get(key)?.value ?? 0) : 0;
  }

  private makePulse(
    recipe: Partial<Record<Shape, number>>,
    peak: number,
    duration: number,
    attack = 0.3,
    startAt = 0,
  ): Pulse {
    const shapes = new Map<string, number>();
    for (const [shape, amount] of Object.entries(recipe) as Array<[Shape, number]>) {
      const key = this.rig?.keys[shape];
      if (key) shapes.set(key, peak * amount);
    }
    return { shapes, duration, t: startAt, attack };
  }

  private pulse(recipe: Partial<Record<Shape, number>>, peak: number, duration: number, attack = 0.3) {
    if (!this.rig) return;
    this.pulses.push(this.makePulse(recipe, peak, duration, attack));
  }

  private scheduleMicro(dt: number) {
    if (!this.microEnabled) return;
    this.nextMicro -= dt;
    if (this.nextMicro > 0) return;
    // 说话时更频繁：讲话的人脸上一直有小动作
    this.nextMicro = (this.speaking ? 1.1 : 2.4) + Math.random() * 2.2;
    if (this.rig) {
      const pool = MICRO[this.dominant] ?? MICRO.neutral;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      this.pulse(pick, 0.1 + Math.random() * 0.14, 0.35 + Math.random() * 0.4);
    } else {
      const adjacent: Record<Emotion, Emotion[]> = {
        neutral: ['relaxed', 'sad', 'surprised'],
        happy: ['relaxed', 'surprised'],
        angry: ['sad', 'surprised'],
        sad: ['angry', 'relaxed'],
        relaxed: ['happy', 'sad'],
        surprised: ['happy', 'angry'],
      };
      const pool = adjacent[this.dominant];
      this.flick(pool[Math.floor(Math.random() * pool.length)], 0.08 + Math.random() * 0.14, 0.35 + Math.random() * 0.4);
    }
  }

  private blink() {
    if (this.blinkPhase >= 0) return;
    this.blinkPhase = 0;
    this.blinkTarget = this.blinkKey;
  }

  private updateBlink(dt: number, mgr: NonNullable<VRM['expressionManager']>) {
    if (!this.blinkKey) return;

    // 眼睛已经被表情闭上一部分（笑眼、>< ）时，眨眼要相应变浅，否则会闭过头
    const closed = this.rig
      ? Math.min(
          1,
          this.valueOf('eye_smile') * 0.9 +
            this.valueOf('eye_squeeze') +
            0.35 * (this.valueOf('eye_sad') + this.valueOf('eye_angry')),
        )
      : 0;
    const depth = 1 - closed;

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
        mgr.setValue(key, (k < 0.4 ? k / 0.4 : 1 - (k - 0.4) / 0.6) * depth);
      }
      return;
    }

    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blink();
      // 想事情时眨得少，说话时眨得多
      const base = this.state === 'thinking' ? 4.2 : this.speaking ? 2.2 : 3.4;
      this.nextBlink = base + Math.random() * 2.8;
      // 偶尔连眨两次
      if (Math.random() < 0.2) this.nextBlink = 0.22;
    }
  }
}

function topOf(mix: Mix): [Emotion, number] | null {
  let best: [Emotion, number] | null = null;
  for (const [emo, w] of Object.entries(mix) as Array<[Emotion, number]>) {
    if (emo === 'neutral') continue;
    if (!best || w > best[1]) best = [emo, w];
  }
  return best;
}
