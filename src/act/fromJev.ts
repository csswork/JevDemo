import type { ActScript, Emotion, GazeTarget, PostureId } from './schema.ts';
import { pickGesture } from './gestureRules.ts';

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

// ---- 问题集：5 个，卡在 1 credit 的上限内 ----

export const EMOTION_CRITERIA: Record<Emotion, string> = {
  neutral: '平静，没有明显情绪',
  happy: '开心、愉快、被逗笑',
  angry: '生气、不满、被冒犯',
  sad: '难过、失落、同情对方',
  relaxed: '放松、温和、亲切',
  surprised: '意外、吃惊、没想到',
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

export function buildQuestions(): Record<string, Question> {
  return {
    emotion: {
      type: 'choice',
      instructions:
        '角色说出这句回应时，脸上的主导情绪是哪一种？只判断角色自己的情绪，不是用户的。',
      criteria: EMOTION_CRITERIA,
    },
    intensity: {
      type: 'score',
      instructions: '这个情绪在脸上表现得有多强？',
      criteria: INTENSITY_LEVELS,
    },
    gaze: {
      type: 'choice',
      instructions: '说这句话时，角色的视线主要落在哪里？',
      criteria: GAZE_CRITERIA,
    },
    posture: {
      type: 'choice',
      instructions: '角色此刻整体的身体状态更接近哪一种？',
      criteria: POSTURE_CRITERIA,
    },
    looks_away: {
      type: 'noul',
      instructions:
        '说这句话的过程中，角色会在中途把视线从对方身上移开一下吗？（斟酌、回避、不好意思时会）',
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

export interface JevMeta {
  backend?: 'vercel' | 'jevstation' | 'typesafe';
  emotion?: { choice: string; confidence: number; probabilities: Record<string, number> };
  intensity?: { score: number; confidence: number };
  gaze?: { choice: string; confidence: number };
  posture?: { choice: string; confidence: number };
  looksAway?: number;
  /** 从上面几项推导出的手部动作（不是 Jev 直接回答的） */
  gesture?: { id: string; label: string; score: number };
  /** JevStation 计 credit */
  credits?: { charged: number; remaining: number };
  /** Vercel AI Gateway 计美元 */
  costUsd?: string;
}

export function composeAct(
  speech: string,
  answers: Answers,
  extra: Partial<JevMeta> = {},
): { act: ActScript; meta: JevMeta } {
  const meta: JevMeta = { ...extra };

  // --- 情绪：用整个分布做混合，而不是只取 top-1 ---
  const emo = answers.emotion;
  let blend: Array<[Emotion, number]> = [['neutral', 1]];
  let dominant: Emotion = 'neutral';
  let gain = 1;

  if (isChoice(emo)) {
    meta.emotion = {
      choice: emo.choice,
      confidence: emo.confidence,
      probabilities: emo.probabilities,
    };
    gain = confidenceGain(emo.confidence);
    const entries = Object.entries(emo.probabilities ?? {})
      .filter(([k]) => k in EMOTION_CRITERIA)
      .sort((a, b) => b[1] - a[1]) as Array<[Emotion, number]>;
    if (entries.length) {
      dominant = entries[0][0];
      const top = entries[0][1] || 1;
      // 归一到"主导情绪 = 1"，次要情绪按相对概率叠加。
      // 门槛 0.15 是为了滤掉长尾噪声，否则六个情绪全挂上去会糊成一团。
      blend = entries.filter(([, p]) => p >= 0.15).map(([k, p]) => [k, p / top]);
    }
  }

  // --- 强度：score 落在级别之间，直接当权重用 ---
  let intensity = 0.65;
  let intensityRaw = 0.5;
  const inten = answers.intensity;
  if (isScore(inten)) {
    meta.intensity = { score: inten.score, confidence: inten.confidence };
    intensity = Math.max(0, Math.min(1, inten.score / (INTENSITY_LEVELS.length - 1)));
    intensityRaw = intensity;
    // 最低给 0.3，否则"几乎看不出来"会变成完全没表情
    intensity = 0.3 + intensity * 0.7;
  }

  const w = (rel: number) => Math.max(0, Math.min(1, rel * intensity * gain));

  // --- 视线 ---
  let primaryGaze: GazeTarget = 'camera';
  let awayGaze: GazeTarget = 'away_left';
  const gz = answers.gaze;
  if (isChoice(gz)) {
    meta.gaze = { choice: gz.choice, confidence: gz.confidence };
    if (gz.choice in GAZE_CRITERIA) primaryGaze = gz.choice as GazeTarget;
    // 中途移开时看哪儿：取概率第二高的非 camera 项，又一次白拿分布
    const alt = Object.entries(gz.probabilities ?? {})
      .filter(([k]) => k !== 'camera' && k in GAZE_CRITERIA)
      .sort((a, b) => b[1] - a[1])[0];
    if (alt) awayGaze = alt[0] as GazeTarget;
  }

  let posture: PostureId = 'idle_neutral';
  const po = answers.posture;
  if (isChoice(po)) {
    meta.posture = { choice: po.choice, confidence: po.confidence };
    if (po.choice in POSTURE_CRITERIA) posture = po.choice as PostureId;
  }

  const away = answers.looks_away;
  const looksAway = isNoul(away) ? away.noul : 0;
  meta.looksAway = looksAway;

  // --- 组装节拍 ---
  // Jev 判断的是整句的表演基调；节拍结构在代码里合成，这正是文档说的
  // "拆成原子问题，用自己的公式组合"。锚点按字符位置插，时间由 TTS 时长决定。
  const chars = [...speech].length;
  const midAnchor = Math.max(1, Math.round(chars * 0.45));
  const endAnchor = Math.max(midAnchor + 1, Math.round(chars * 0.8));
  const arr = [...speech];
  const marked =
    arr.slice(0, midAnchor).join('') +
    '<b:mid>' +
    arr.slice(midAnchor, endAnchor).join('') +
    '<b:settle>' +
    arr.slice(endAnchor).join('');

  // 三个节拍：起、中段回落、收尾再落一点。避免一句话一个表情。
  //
  // 关键是每一拍都发**整个混合**、只缩放幅度，不能只发主导情绪 ——
  // 最初的写法中段只发 dominant，于是苦笑演到 45% 就被拍平成纯难过，
  // 前面辛苦混出来的脸在半句话之后就没了。
  const BEATS: Array<[number | { anchor: string }, number, number]> = [
    [0, 1, 0.22],
    [{ anchor: 'mid' }, 0.75, 0.3],
    [{ anchor: 'settle' }, 0.55, 0.35],
  ];
  const expression: ActScript['tracks']['expression'] = [];
  for (const [at, scale, fade] of BEATS) {
    for (const [emoKey, rel] of blend) {
      expression.push({ at, preset: emoKey, weight: w(rel * scale), fade });
    }
  }

  const gaze: ActScript['tracks']['gaze'] = [{ at: 0, target: primaryGaze }];
  if (looksAway > 0.5) {
    // noul 是概率，直接当"移开多久"用：越确定移得越久
    gaze.push({ at: { anchor: 'mid' }, target: awayGaze, hold: 0.5 + looksAway * 1.2 });
    gaze.push({ at: { anchor: 'settle' }, target: 'camera' });
  }

  // --- 手部动作：从情绪分布推导，不额外问 Jev ---
  const probs = isChoice(emo) ? emo.probabilities : {};
  const pick = pickGesture(probs, intensityRaw, looksAway);
  const gestureTrack: ActScript['tracks']['gesture'] = [];
  if (pick) {
    meta.gesture = { id: pick.gesture.id, label: pick.gesture.label, score: +pick.score.toFixed(3) };
    gestureTrack.push({
      // start 类稍微晚一点点出手：情绪先上脸，手再跟上，才像是被触发的
      at: pick.gesture.at === 'start' ? 0.15 : { anchor: 'mid' },
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

