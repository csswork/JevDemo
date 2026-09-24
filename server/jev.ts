import type { ActScript } from '../src/act/schema.ts';
import {
  buildQuestions,
  buildReactionQuestions,
  composeAct,
  composeReaction,
  type Answers,
  type JevMeta,
  type JevPayload,
} from '../src/act/fromJev.ts';

/** JevStation 包一层 data，Vercel / TypeSafe 直接放顶层 */
type JevResponse = JevPayload & { data?: JevPayload };

export type { JevMeta } from '../src/act/fromJev.ts';

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
 * 所以每次评估刻意**卡在 5 个问题以内**。每轮对话最多两次评估：
 *   倾听反应（2 问，和输入层并行）+ 整句表演（≤5 问，按段出题），见 fromJev.ts。
 * 倾听反应可以用 JEV_REACTION=off 关掉，关掉后每轮 1 次评估。
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

interface JevError {
  message?: string;
  error_type?: string;
  error?: { message?: string; type?: string };
}

// ---- 调用 ----

export interface JevOptions {
  apiKey: string;
  /**
   * 超时（毫秒）。默认 6000。
   *
   * 不是为了省钱，是因为**过期的判断没有价值**：一句台词只播 3~6 秒，
   * 渲染层的 upgrade 只能改还没触发的节拍，判断回来时台词已经说完就什么都改不了。
   * 实测走 Vercel AI Gateway 的延迟方差很大（p50 约 3.8s，见过 19.5s），
   * 所以宁可干净地放弃、退回基线表演，也不要挂着一个注定没用的请求。
   */
  timeoutMs?: number;
  /** 省略则按 key 前缀自动判断 */
  backend?: JevBackend;
  /** 省略则用后端默认地址 */
  baseUrl?: string;
  /** 省略则用后端默认模型（JevStation 不发） */
  model?: string;
}

/**
 * 429/529 按文档要求做指数退避重试，整体受 deadline 约束。
 * 重试不能把总时长拖过超时 —— 那样等于把"及时放弃"的意义抵消掉。
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  deadline: number,
  tries = 3,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const left = deadline - Date.now();
    if (left <= 0) break;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), left);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if (r.status !== 429 && r.status !== 529) return r;
      last = r;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') {
        throw new Error(`Jev 超时（${Math.round((Date.now() - (deadline - left)) / 100) / 10}s 未返回）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((res) => setTimeout(res, Math.min(400 * 2 ** i, deadline - Date.now())));
  }
  if (!last) throw new Error('Jev 超时');
  return last;
}

/**
 * 发一次 Jev 评估：state + 问题 → 答案。两种判断（倾听反应、整句表演）共用。
 */
async function evaluate(
  opts: JevOptions,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
): Promise<{ answers: Answers; payload: JevPayload; backend: JevBackend }> {
  const backend = opts.backend ?? detectBackend(opts.apiKey);
  const spec = BACKENDS[backend];
  const url = `${(opts.baseUrl || spec.base).replace(/\/+$/, '')}${spec.path}`;

  const model = opts.model ?? spec.model;
  const body: Record<string, unknown> = { state, questions };
  // Vercel / TypeSafe 需要 model 来路由；JevStation 在部署层面钉死，发了会被忽略
  if (model) body.model = model;

  const deadline = Date.now() + (opts.timeoutMs ?? 6000);
  const res = await postWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    deadline,
  );

  // 先拿文本再尝试解析：网关边缘的错误未必是 JSON，直接 res.json() 会把线索吃掉
  const raw = await res.text().catch(() => '');
  let json: (JevResponse & JevError) | null = null;
  try {
    json = raw ? (JSON.parse(raw) as JevResponse & JevError) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    // Vercel 文档的错误形状是 { message, error_type }，但边缘层可能返回别的东西，
    // 所以解析不出来就把原文透出去 —— 猜错误原因比看原文慢得多
    const detail = json?.error?.message ?? json?.message ?? raw.slice(0, 400);
    const hint =
      res.status === 401 || res.status === 403
        ? `｜当前按 ${backend} 后端在调 ${url}`
        : '';
    throw new Error(
      `Jev 返回 ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}${hint}`,
    );
  }

  // JevStation 包一层 data，Vercel / TypeSafe 直接在顶层
  const payload: JevPayload | undefined = spec.wrapped ? json?.data : (json ?? undefined);
  const answers = payload?.answers;
  if (!payload || !answers) {
    throw new Error(`Jev 响应里没有 answers（后端 ${backend}）`);
  }
  return { answers, payload, backend };
}

const SCENE = '一个虚拟角色正在和用户面对面说话';

/**
 * 让 Jev 判断"这句台词该怎么演"。
 *
 * state 同时带上用户输入和角色要说的话 —— 表演是**回应**，
 * 只看台词判断不出"她是在附和还是在反驳"。
 * 问题按台词切成的段数出（见 buildQuestions），每段一个情绪，总数不超过 5 个。
 */
export async function judgePerformance(
  opts: JevOptions,
  params: {
    userInput: string;
    speech: string;
    history?: Array<{ role: 'user' | 'character'; text: string }>;
  },
): Promise<{ act: ActScript; meta: JevMeta }> {
  const { answers, payload, backend } = await evaluate(
    opts,
    {
      对话场景: `${SCENE}，需要判断角色说这句话时的表演`,
      最近几轮: (params.history ?? []).slice(-4).map((t) => `${t.role}: ${t.text}`),
      用户刚说: params.userInput,
      角色要说: params.speech,
    },
    buildQuestions(params.speech),
  );
  return composeAct(params.speech, answers, {
    backend,
    credits: payload.credits,
    costUsd: payload.provider_metadata?.gateway?.cost,
  });
}

/**
 * 倾听时的第一反应：只看用户说了什么，和输入层（写台词）并行发出。
 * 见 fromJev.ts 的 buildReactionQuestions。
 */
export async function judgeReaction(
  opts: JevOptions,
  params: {
    userInput: string;
    history?: Array<{ role: 'user' | 'character'; text: string }>;
  },
): Promise<{ mix: Array<[string, number]>; meta: JevMeta }> {
  const { answers, payload, backend } = await evaluate(
    opts,
    {
      对话场景: `${SCENE}，用户刚说完一句话，角色还没开口`,
      最近几轮: (params.history ?? []).slice(-4).map((t) => `${t.role}: ${t.text}`),
      用户刚说: params.userInput,
    },
    buildReactionQuestions(),
  );
  const r = composeReaction(answers);
  if (!r) throw new Error('Jev 没有回答倾听反应');
  return {
    mix: r.mix,
    meta: {
      backend,
      reaction: r.meta,
      credits: payload.credits,
      costUsd: payload.provider_metadata?.gateway?.cost,
    },
  };
}
