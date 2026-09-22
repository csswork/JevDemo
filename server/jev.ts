import type { ActScript, Emotion, GazeTarget, PostureId } from '../src/act/schema';

/**
 * Jev 适配层 —— 判断层。
 *
 * Jev 是判断模型，不是对话模型：给它 state + 类型化问题，返回类型化答案。
 * 它**不生成台词**。所以这一层只负责"怎么演"，台词由输入层提供（见 deepseek.ts）。
 *
 * 同一个模型有三种接法，端点、鉴权和响应形状都不一样，由 backend 区分：
 *
 *   vercel      Vercel AI Gateway。key 形如 vck_，**必须**带 model 字段，
 *               answers 在顶层，计费信息在 provider_metadata.gateway.cost（美元）。
 *   jevstation  jevstation.com 的工作台。key 形如 sk_，model 字段被忽略，
 *               answers 包在 data 里，另带 credits 余额。
 *   typesafe    TypeSafe 官方直连（候补名单）。Vercel 文档说自己实现的就是
 *               "TypeSafe 的请求/响应形状"，所以和 vercel 共用一套解析。
 *
 * 这个分工反而比用通用 LLM 出 Act IR 更合适：
 *   - choice 的 criteria 就是闭集枚举，和 act/schema.ts 的词表天然对齐，
 *     不会出现"LLM 发明了一个不存在的手势名"这类问题
 *   - choice 回的是**整个概率分布**，不只是 top-1 —— 直接喂给 ExpressionLayer.setBlend，
 *     混合表情白拿。happy 0.6 + surprised 0.3 比单一 happy 1.0 像人得多
 *   - score 回的是级别之间的连续值（文档例子里是 1.04），正好当权重用
 *   - confidence 可以用来决定"要不要敢演"：模型自己都不确定的时候，
 *     与其演错一个强表情，不如收着演
 *
 * 成本：文档说一次评估 1 credit，问题数超过 5 个或 state 超过 8000 字符变 3 credit。
 * 所以下面刻意**卡在 5 个问题**。
 */

export type JevBackend = 'vercel' | 'jevstation' | 'typesafe';

interface BackendSpec {
  base: string;
  path: string;
  /** 请求里要不要带 model，带什么 */
  model?: string;
  /** answers 是否包在 data 里 */
  wrapped: boolean;
}

const BACKENDS: Record<JevBackend, BackendSpec> = {
  vercel: {
    base: 'https://ai-gateway.vercel.sh/typesafe',
    path: '/v1/systemone',
    model: 'typesafe-ai/jev',
    wrapped: false,
  },
  jevstation: {
    base: 'https://jevstation.com',
    path: '/api/v1/systemone',
    // JevStation 在部署层面钉死了模型，这个字段发了也会被忽略
    wrapped: true,
  },
  typesafe: {
    base: 'https://api.typesafe.ai',
    path: '/v1/systemone',
    model: 'jev-latest',
    wrapped: false,
  },
};

/** 从 key 前缀猜后端。vck_ 是 Vercel AI Gateway，sk_ 是 JevStation。 */
export function detectBackend(apiKey: string): JevBackend {
  if (/^vck_/i.test(apiKey)) return 'vercel';
  if (/^sk_/i.test(apiKey)) return 'jevstation';
  return 'typesafe';
}

// ---- 线上协议类型（照文档写，不是猜的）----

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
type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
interface ScoreAnswer {
  score: number;
  legend: Record<string, string> | string[];
  confidence: number;
}
interface NoulAnswer {
  noul: number;
}

type Answers = Record<string, ChoiceAnswer | ScoreAnswer | NoulAnswer>;

interface JevPayload {
  answers: Answers;
  credits?: { charged: number; remaining: number };
  usage?: { input_tokens: number; output_tokens: number };
  provider_metadata?: { gateway?: { cost?: string; generationId?: string } };
}

/** JevStation 包一层 data，Vercel / TypeSafe 直接放顶层 */
type JevResponse = JevPayload & { data?: JevPayload };

interface JevError {
  message?: string;
  error_type?: string;
}

// ---- 问题集：5 个，卡在 1 credit 的上限内 ----

const EMOTION_CRITERIA: Record<Emotion, string> = {
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
const INTENSITY_LEVELS = ['几乎看不出来', '明显但克制', '强烈外露'];

function buildQuestions(): Record<string, Question> {
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
 * 用文档建议的三档法，但落点是"敢不敢演"而不是"要不要人工介入"：
 * 模型自己都不确定的时候，演错一个强表情比演淡了难看得多，所以收着来。
 */
function confidenceGain(confidence: number): number {
  if (confidence >= 0.6) return 1;
  if (confidence >= 0.35) return 0.7;
  return 0.45;
}

const isChoice = (a: unknown): a is ChoiceAnswer =>
  !!a && typeof (a as ChoiceAnswer).choice === 'string';
const isScore = (a: unknown): a is ScoreAnswer =>
  !!a && typeof (a as ScoreAnswer).score === 'number';
const isNoul = (a: unknown): a is NoulAnswer =>
  !!a && typeof (a as NoulAnswer).noul === 'number';

export interface JevMeta {
  backend?: JevBackend;
  emotion?: { choice: string; confidence: number; probabilities: Record<string, number> };
  intensity?: { score: number; confidence: number };
  gaze?: { choice: string; confidence: number };
  posture?: { choice: string; confidence: number };
  looksAway?: number;
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
  const inten = answers.intensity;
  if (isScore(inten)) {
    meta.intensity = { score: inten.score, confidence: inten.confidence };
    intensity = Math.max(0, Math.min(1, inten.score / (INTENSITY_LEVELS.length - 1)));
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

  const expression: ActScript['tracks']['expression'] = [];
  for (const [emoKey, rel] of blend) {
    expression.push({ at: 0, preset: emoKey, weight: w(rel), fade: 0.22 });
  }
  // 中段轻微回落，收尾再稳住主导情绪 —— 三个节拍，避免一句话一个表情
  expression.push({ at: { anchor: 'mid' }, preset: dominant, weight: w(0.75), fade: 0.3 });
  expression.push({ at: { anchor: 'settle' }, preset: dominant, weight: w(0.55), fade: 0.35 });

  const gaze: ActScript['tracks']['gaze'] = [{ at: 0, target: primaryGaze }];
  if (looksAway > 0.5) {
    // noul 是概率，直接当"移开多久"用：越确定移得越久
    gaze.push({ at: { anchor: 'mid' }, target: awayGaze, hold: 0.5 + looksAway * 1.2 });
    gaze.push({ at: { anchor: 'settle' }, target: 'camera' });
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
      tracks: { posture, expression, gesture: [], gaze },
    },
    meta,
  };
}

// ---- 调用 ----

export interface JevOptions {
  apiKey: string;
  /** 省略则按 key 前缀自动判断 */
  backend?: JevBackend;
  /** 省略则用后端默认地址 */
  baseUrl?: string;
  /** 省略则用后端默认模型（JevStation 不发） */
  model?: string;
}

/** 429/529 按文档要求做指数退避重试。 */
async function postWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 && r.status !== 529) return r;
    last = r;
    await new Promise((res) => setTimeout(res, 400 * 2 ** i + Math.random() * 200));
  }
  return last!;
}

/**
 * 让 Jev 判断"这句台词该怎么演"。
 *
 * state 同时带上用户输入和角色要说的话 —— 表演是**回应**，
 * 只看台词判断不出"她是在附和还是在反驳"。
 */
export async function judgePerformance(
  opts: JevOptions,
  params: {
    userInput: string;
    speech: string;
    history?: Array<{ role: 'user' | 'character'; text: string }>;
  },
): Promise<{ act: ActScript; meta: JevMeta }> {
  const backend = opts.backend ?? detectBackend(opts.apiKey);
  const spec = BACKENDS[backend];
  const url = `${(opts.baseUrl || spec.base).replace(/\/+$/, '')}${spec.path}`;

  const model = opts.model ?? spec.model;
  const body: Record<string, unknown> = {
    state: {
      对话场景: '一个虚拟角色正在和用户面对面说话，需要判断角色说这句话时的表演',
      最近几轮: (params.history ?? []).slice(-4).map((t) => `${t.role}: ${t.text}`),
      用户刚说: params.userInput,
      角色要说: params.speech,
    },
    questions: buildQuestions(),
  };
  // Vercel / TypeSafe 需要 model 来路由；JevStation 在部署层面钉死，发了会被忽略
  if (model) body.model = model;

  const res = await postWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as (JevResponse & JevError) | null;

  if (!res.ok) {
    // Vercel 的错误形状是 { message, error_type }，JevStation 是纯文本
    const detail = json?.message ?? '';
    const hint =
      res.status === 401 || res.status === 403
        ? `（当前按 ${backend} 后端在调 ${url}，key 前缀和后端对不上时就会这样）`
        : '';
    throw new Error(
      `Jev 返回 ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}${hint}`,
    );
  }

  // JevStation 包一层 data，Vercel / TypeSafe 直接在顶层
  const payload: JevPayload | undefined = spec.wrapped ? json?.data : (json ?? undefined);
  const answers = payload?.answers;
  if (!answers) {
    throw new Error(`Jev 响应里没有 answers（后端 ${backend}）`);
  }

  return composeAct(params.speech, answers, {
    backend,
    credits: payload?.credits,
    costUsd: payload?.provider_metadata?.gateway?.cost,
  });
}
