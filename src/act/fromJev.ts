import type { ActScript, Emotion, GazeTarget, PostureId } from './schema.ts';
import { pickGesture } from './gestureRules.ts';
import { splitSegments } from './segments.ts';

/**
 * Jev 协议层：问题集的定义，以及"类型化答案 → Act IR"的合成。
 *
 * 放在 src/act/ 而不是 server/ 是有意的 —— 这里没有任何网络代码，
 * 前端的测试指令（`测试: 开心 90%`）要能构造合成答案走**同一份**合成逻辑。
 * 测试路径和真实路径共用代码，测出来的东西才作数。
 */

interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}
interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}
interface NoulQuestion {
  type: 'noul';
  instructions: string;
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  score: number;
  legend: Record<string, string> | string[];
  confidence: number;
}
export interface NoulAnswer {
  noul: number;
}

export type Answers = Record<string, ChoiceAnswer | ScoreAnswer | NoulAnswer>;

export interface JevPayload {
  answers: Answers;
  credits?: { charged: number; remaining: number };
  usage?: { input_tokens: number; output_tokens: number };
  provider_metadata?: { gateway?: { cost?: string; generationId?: string } };
}

/**
 * 错误形状有两种，都得认：
 *   TypeSafe 兼容层（Vercel 文档写的）  { message, error_type }
 *   网关边缘（账户/计费类拦截）          { error: { message, type } }
 * 后者在文档里没有，实测 403 走的就是它。
 */

// ---- 问题集：5 个以内，卡在 1 credit 的上限内 ----

/**
 * criteria 的描述写得比情绪名宽：Jev 回的是整个概率分布，描述覆盖到"害羞""苦笑"
 * 这类复合状态，它们才会以混合的形式出现（害羞 ≈ happy + surprised，苦笑 ≈ sad + relaxed），
 * 渲染层再按部位把混合合成一张脸。
 */
export const EMOTION_CRITERIA: Record<Emotion, string> = {
  neutral: '平静、认真，或者在想事情，没有明显情绪',
  happy: '开心、被逗笑、得意，或者害羞里带着高兴',
  angry: '生气、不满、嫌弃、不耐烦',
  sad: '难过、失落、委屈、歉意、同情对方',
  relaxed: '放松、温和、亲切、释然',
  surprised: '意外、吃惊、没想到、有点慌',
};

const GAZE_CRITERIA: Record<GazeTarget, string> = {
  camera: '直视对方',
  away_left: '看向自己左侧，回避或走神',
  away_right: '看向自己右侧，回避或走神',
  down: '垂下视线，低落或斟酌',
  up: '抬眼向上，回忆或思考',
};

const POSTURE_CRITERIA: Record<PostureId, string> = {
  idle_neutral: '中性、放松站立',
  idle_cheerful: '轻快、上扬',
  idle_low: '低落、收拢',
  idle_alert: '专注、微微前倾',
};

/** score 的级别是有序的，索引即强度。 */
export const INTENSITY_LEVELS = ['几乎看不出来', '明显但克制', '强烈外露'];

/** 每段情绪问题的 key：emotion_1、emotion_2 …… */
const segKey = (i: number) => `emotion_${i + 1}`;

/**
 * 问题集随台词的段数变化，总数始终 ≤ 5：
 *
 *   1 段：情绪 + 强度 + 视线 + 姿态 + 会不会移开视线
 *   2 段：情绪 × 2 + 强度 + 视线 + 会不会移开视线        （姿态由情绪推导）
 *   3 段：情绪 × 3 + 强度 + 视线                          （姿态、移开视线由其他答案推导）
 *
 * 推导的做法和手部动作一样（gestureRules.ts）：从 Jev 已有的答案算，不额外问。
 * 每段的问题里直接带上那一段的原文，同时 state 里有整句和上下文，Jev 判断的是
 * "在这句话、这个语境里，说到这一段时"的情绪，而不是孤立地给一段文字贴标签。
 */
export function buildQuestions(speech: string): Record<string, Question> {
  const segs = splitSegments(speech);
  const q: Record<string, Question> = {};
  segs.forEach((seg, i) => {
    q[segKey(i)] = {
      type: 'choice',
      instructions:
        segs.length === 1
          ? '角色说出这句回应时，脸上的主导情绪是哪一种？只判断角色自己的情绪，不是用户的。'
          : `角色说到第 ${i + 1} 段「${seg.text}」时，脸上的情绪是哪一种？` +
            '要结合整句和上下文判断（同一句话里情绪可以变化），只判断角色自己的情绪。',
      criteria: EMOTION_CRITERIA,
    };
  });
  q.intensity = {
    type: 'score',
    instructions: '整句话说下来，情绪在脸上表现得有多强？',
    criteria: INTENSITY_LEVELS,
  };
  q.gaze = {
    type: 'choice',
    instructions: '说这句话时，角色的视线主要落在哪里？',
    criteria: GAZE_CRITERIA,
  };
  if (segs.length <= 2) {
    q.looks_away = {
      type: 'noul',
      instructions:
        '说这句话的过程中，角色会在中途把视线从对方身上移开一下吗？（斟酌、回避、不好意思时会）',
    };
  }
  if (segs.length === 1) {
    q.posture = {
      type: 'choice',
      instructions: '角色此刻整体的身体状态更接近哪一种？',
      criteria: POSTURE_CRITERIA,
    };
  }
  return q;
}

/**
 * 倾听时的第一反应：用户话音刚落、角色还没开口时脸上的表情。
 *
 * 真人听到一句话，表情先于回答出现 —— 听到好消息先笑，再说"太好了"。
 * 台词要等输入层（DeepSeek）写出来，整句的判断又要等台词，所以这一问单独发，
 * 和输入层**并行**：只看用户说了什么。2 个问题，1 credit。
 */
export function buildReactionQuestions(): Record<string, Question> {
  return {
    reaction: {
      type: 'choice',
      instructions:
        '角色刚听完用户这句话、还没开口回答的那一刻，脸上的第一反应是哪一种情绪？只判断角色自己的反应。',
      criteria: EMOTION_CRITERIA,
    },
    reaction_intensity: {
      type: 'score',
      instructions: '这个第一反应在脸上有多明显？',
      criteria: INTENSITY_LEVELS,
    },
  };
}

// ---- 答案 → Act IR ----

/**
 * 置信度 → 表演幅度。
 *
 * 这里踩过一次反向的坑，值得写清楚。
 *
 * 文档说 confidence 就是从概率分布的形状导出的：集中=高，分散=低。
 * 所以**低 confidence 不等于"Jev 不确定"，而等于"情绪本身就是混的"**。
 * 实测「哈，行吧。反正我也习惯了」→ sad 0.38 + relaxed 0.31 + angry 0.17，
 * confidence 只有 0.26 —— 这不是判断不准，这就是苦笑的正确答案。
 *
 * 最初按文档的三档法压到 0.45，结果情绪最丰富的句子演得最淡：
 * 分布已经用来做混合了，再拿同一个信号去衰减幅度，等于对复杂情绪双重惩罚。
 *
 * 现在只保留很轻的对冲（0.75~1.0）。留一点是因为分布也可能在**对立**情绪之间
 * 摊平（happy 0.5 / angry 0.5），那种脸全给满会很怪；但不该把三路苦笑压没。
 */
function confidenceGain(confidence: number): number {
  return 0.75 + 0.25 * Math.max(0, Math.min(1, confidence));
}

const isChoice = (a: unknown): a is ChoiceAnswer =>
  !!a && typeof (a as ChoiceAnswer).choice === 'string';
const isScore = (a: unknown): a is ScoreAnswer =>
  !!a && typeof (a as ScoreAnswer).score === 'number';
const isNoul = (a: unknown): a is NoulAnswer =>
  !!a && typeof (a as NoulAnswer).noul === 'number';

export interface EmotionMeta {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevMeta {
  backend?: 'vercel' | 'jevstation' | 'typesafe';
  /** 每一段的情绪判断（一句话里的情绪变化） */
  segments?: Array<EmotionMeta & { text: string }>;
  /** 整句的情绪：各段按字数加权平均。手势推导和旧面板用 */
  emotion?: EmotionMeta;
  intensity?: { score: number; confidence: number };
  gaze?: { choice: string; confidence: number };
  /** derived = 这一项不是 Jev 直接回答的，是从其他答案推导的（段数多时省下的问题） */
  posture?: { choice: string; confidence: number; derived?: boolean };
  looksAway?: number;
  looksAwayDerived?: boolean;
  /** 倾听时的第一反应（和输入层并行的那一次判断） */
  reaction?: EmotionMeta & { intensity: number };
  /** 从上面几项推导出的手部动作（不是 Jev 直接回答的） */
  gesture?: { id: string; label: string; score: number };
  /** JevStation 计 credit */
  credits?: { charged: number; remaining: number };
  /** Vercel AI Gateway 计美元 */
  costUsd?: string;
}

type Blend = Array<[Emotion, number]>;

/**
 * 概率分布 → 混合：归一到"主导情绪 = 1"，次要情绪按相对概率叠加。
 * 门槛 0.15 是为了滤掉长尾噪声，否则六个情绪全挂上去会糊成一团。
 */
function blendOf(probs: Record<string, number>): { blend: Blend; dominant: Emotion } {
  const entries = Object.entries(probs ?? {})
    .filter(([k]) => k in EMOTION_CRITERIA)
    .sort((a, b) => b[1] - a[1]) as Blend;
  if (!entries.length) return { blend: [['neutral', 1]], dominant: 'neutral' };
  const top = entries[0][1] || 1;
  return {
    blend: entries.filter(([, p]) => p >= 0.15).map(([k, p]) => [k, p / top]),
    dominant: entries[0][0],
  };
}

/** 两个分布有多像（余弦），用来判断下一段是不是"同一个情绪的延续" */
function similarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = Object.keys(EMOTION_CRITERIA);
  const va = keys.map((k) => a[k] ?? 0);
  const vb = keys.map((k) => b[k] ?? 0);
  const dot = va.reduce((s, x, i) => s + x * vb[i], 0);
  return dot / ((Math.hypot(...va) || 1) * (Math.hypot(...vb) || 1));
}

/** score → 表演强度。最低给 0.3，否则"几乎看不出来"会变成完全没表情 */
function intensityOf(score: number): { raw: number; scaled: number } {
  const raw = Math.max(0, Math.min(1, score / (INTENSITY_LEVELS.length - 1)));
  return { raw, scaled: 0.3 + raw * 0.7 };
}

/** 没问姿态时，从情绪推导（和手势一样，不额外问 Jev） */
function derivePosture(probs: Record<string, number>, intensity: number): PostureId {
  const { dominant } = blendOf(probs);
  if (dominant === 'sad') return 'idle_low';
  if (dominant === 'angry' || (dominant === 'surprised' && intensity > 0.6)) return 'idle_alert';
  if ((dominant === 'happy' || dominant === 'surprised') && intensity > 0.45) return 'idle_cheerful';
  return 'idle_neutral';
}

export function composeAct(
  speech: string,
  answers: Answers,
  extra: Partial<JevMeta> = {},
): { act: ActScript; meta: JevMeta } {
  const meta: JevMeta = { ...extra };
  const segs = splitSegments(speech);

  // --- 每段的情绪 ---
  // 兼容只有一个 emotion 答案的旧格式：整句一个情绪
  const legacy = answers.emotion;
  const perSeg = segs.map((seg, i) => {
    const a = answers[segKey(i)] ?? legacy;
    const probs = isChoice(a) ? a.probabilities ?? {} : { neutral: 1 };
    return {
      seg,
      answer: isChoice(a) ? a : null,
      probs,
      gain: isChoice(a) ? confidenceGain(a.confidence) : 1,
      ...blendOf(probs),
    };
  });
  meta.segments = perSeg.map((p) => ({
    text: p.seg.text,
    choice: p.answer?.choice ?? 'neutral',
    confidence: p.answer?.confidence ?? 0,
    probabilities: p.probs,
  }));

  // 整句的分布：各段按字数加权
  const overall: Record<string, number> = {};
  const totalLen = segs.reduce((n, s) => n + Math.max(1, [...s.text].length), 0);
  for (const p of perSeg) {
    const k = Math.max(1, [...p.seg.text].length) / totalLen;
    for (const [e, v] of Object.entries(p.probs)) overall[e] = (overall[e] ?? 0) + v * k;
  }
  const overallTop = Object.entries(overall).sort((a, b) => b[1] - a[1])[0] ?? ['neutral', 1];
  meta.emotion = {
    choice: overallTop[0],
    confidence: perSeg.reduce((s, p) => s + (p.answer?.confidence ?? 0), 0) / perSeg.length,
    probabilities: overall,
  };
  const dominant = blendOf(overall).dominant;

  // --- 强度 ---
  let intensity = 0.65;
  let intensityRaw = 0.5;
  const inten = answers.intensity;
  if (isScore(inten)) {
    meta.intensity = { score: inten.score, confidence: inten.confidence };
    ({ raw: intensityRaw, scaled: intensity } = intensityOf(inten.score));
  }

  // --- 视线 ---
  let primaryGaze: GazeTarget = 'camera';
  let awayGaze: GazeTarget = 'away_left';
  let pCamera = 1;
  const gz = answers.gaze;
  if (isChoice(gz)) {
    meta.gaze = { choice: gz.choice, confidence: gz.confidence };
    if (gz.choice in GAZE_CRITERIA) primaryGaze = gz.choice as GazeTarget;
    pCamera = gz.probabilities?.camera ?? (gz.choice === 'camera' ? 1 : 0);
    // 中途移开时看哪儿：取概率第二高的非 camera 项，又一次白拿分布
    const alt = Object.entries(gz.probabilities ?? {})
      .filter(([k]) => k !== 'camera' && k in GAZE_CRITERIA)
      .sort((a, b) => b[1] - a[1])[0];
    if (alt) awayGaze = alt[0] as GazeTarget;
  }

  // --- 姿态、移开视线：问了就用答案，没问就推导 ---
  let posture: PostureId;
  const po = answers.posture;
  if (isChoice(po) && po.choice in POSTURE_CRITERIA) {
    posture = po.choice as PostureId;
    meta.posture = { choice: po.choice, confidence: po.confidence };
  } else {
    posture = derivePosture(overall, intensityRaw);
    meta.posture = { choice: posture, confidence: 0, derived: true };
  }

  const away = answers.looks_away;
  let looksAway: number;
  if (isNoul(away)) {
    looksAway = away.noul;
  } else {
    // 视线分布里"不看对方"的概率就是移开的倾向
    looksAway = Math.max(0, Math.min(1, (1 - pCamera) * 1.2));
    meta.looksAwayDerived = true;
  }
  meta.looksAway = looksAway;

  // --- 锚点：每段开头一个 <b:segN>，另有 mid / settle 给视线和手势用 ---
  const text = [...speech];
  const marks = new Map<number, string[]>();
  const mark = (at: number, name: string) => {
    const i = Math.max(0, Math.min(text.length, at));
    marks.set(i, [...(marks.get(i) ?? []), name]);
  };
  segs.forEach((seg, i) => {
    if (i > 0) mark(seg.start, `seg${i + 1}`);
  });
  const midAnchor = Math.max(1, Math.round(text.length * 0.45));
  const endAnchor = Math.max(midAnchor + 1, Math.round(text.length * 0.8));
  mark(midAnchor, 'mid');
  mark(endAnchor, 'settle');
  let marked = '';
  for (let i = 0; i <= text.length; i++) {
    for (const name of marks.get(i) ?? []) marked += `<b:${name}>`;
    if (i < text.length) marked += text[i];
  }
  const segAt = (i: number): ActScript['tracks']['expression'][number]['at'] =>
    i === 0 ? 0 : { anchor: `seg${i + 1}` };

  // --- 表情：每段一拍，每拍发整个混合 ---
  //
  // 每一拍都发**整个混合**、只缩放幅度，不能只发主导情绪 ——
  // 最初的写法中段只发 dominant，于是苦笑演到 45% 就被拍平成纯难过。
  //
  // 相邻两段情绪差不多（余弦 > 0.92）时不重发：重发会让表情"再冲一次峰值"，
  // 同一个情绪说两句话，脸不该一抽一抽的。渲染层的峰值回落会自然接住。
  // 第一段快（0.22s）—— 开口那一下是反应；之后换情绪 0.32s，回到平静 0.5s。
  const expression: ActScript['tracks']['expression'] = [];
  perSeg.forEach((p, i) => {
    if (i > 0 && similarity(p.probs, perSeg[i - 1].probs) > 0.92) return;
    const scale = i === 0 ? 1 : 0.95;
    const changed = i > 0 && p.dominant !== perSeg[i - 1].dominant;
    // 回到平静比换一种情绪更慢：情绪的消退本来就比出现慢
    const fade = i === 0 ? 0.22 : p.dominant === 'neutral' ? 0.5 : changed ? 0.32 : 0.4;
    for (const [emo, rel] of p.blend) {
      expression.push({
        at: segAt(i),
        preset: emo,
        weight: Math.max(0, Math.min(1, rel * scale * intensity * p.gain)),
        fade,
      });
    }
  });

  // --- 视线 ---
  // 说话人在一句话中段移开视线、在句尾看回对方，是交出话轮的信号
  const gaze: ActScript['tracks']['gaze'] = [{ at: 0, target: primaryGaze }];
  if (looksAway > 0.5) {
    const at = segs.length >= 2 ? { anchor: 'seg2' } : { anchor: 'mid' };
    gaze.push({ at, target: awayGaze, hold: 0.5 + looksAway * 1.2 });
    gaze.push({ at: segs.length >= 3 ? { anchor: `seg${segs.length}` } : { anchor: 'settle' }, target: 'camera' });
  }

  // --- 手部动作：从情绪推导，挑最匹配的那一段出手 ---
  let bestPick: { pick: NonNullable<ReturnType<typeof pickGesture>>; seg: number } | null = null;
  perSeg.forEach((p, i) => {
    const pick = pickGesture(p.probs, intensityRaw, looksAway);
    if (pick && (!bestPick || pick.score > bestPick.pick.score)) bestPick = { pick, seg: i };
  });
  const gestureTrack: ActScript['tracks']['gesture'] = [];
  if (bestPick) {
    const { pick, seg } = bestPick as { pick: NonNullable<ReturnType<typeof pickGesture>>; seg: number };
    meta.gesture = { id: pick.gesture.id, label: pick.gesture.label, score: +pick.score.toFixed(3) };
    gestureTrack.push({
      // start 类稍微晚一点点出手：情绪先上脸，手再跟上，才像是被触发的
      at: pick.gesture.at === 'start' ? (seg === 0 ? 0.15 : segAt(seg)) : { anchor: 'mid' },
      clip: pick.gesture.id,
      weight: 1,
      speed: 1,
    });
  }

  return {
    act: {
      speech: marked,
      emotion: {
        valence:
          dominant === 'happy' || dominant === 'relaxed'
            ? intensity
            : dominant === 'sad' || dominant === 'angry'
              ? -intensity
              : 0,
        arousal: intensity,
      },
      tracks: { posture, expression, gesture: gestureTrack, gaze },
    },
    meta,
  };
}

/**
 * 倾听反应 → 一个表情混合。比开口后的表情收一点（0.85）：反应是"脸上闪过"，不是在演。
 */
export function composeReaction(answers: Answers): { mix: Blend; meta: NonNullable<JevMeta['reaction']> } | null {
  const r = answers.reaction;
  if (!isChoice(r)) return null;
  const inten = answers.reaction_intensity;
  const { scaled } = intensityOf(isScore(inten) ? inten.score : 1);
  const { blend } = blendOf(r.probabilities ?? {});
  const gain = confidenceGain(r.confidence) * scaled * 0.85;
  return {
    mix: blend.map(([e, w]) => [e, Math.max(0, Math.min(1, w * gain))]),
    meta: {
      choice: r.choice,
      confidence: r.confidence,
      probabilities: r.probabilities ?? {},
      intensity: isScore(inten) ? inten.score : 1,
    },
  };
}
