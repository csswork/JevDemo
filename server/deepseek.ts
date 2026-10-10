/**
 * 输入层 —— 一期用来替代实时语音交互的对话来源。
 *
 * 位置很关键，别和 Jev 搞混：
 *
 *   一期：文本输入 → **DeepSeek（这一层）** → Jev 判断表演 → Act IR → three-vrm
 *   二期：实时语音 → gpt-live-1 ───────────┘   ← 直接顶掉这一层，右边全不动
 *
 * 它只负责"角色说什么"，完全不碰"怎么演"。表演是 Jev 的活，两边职责不重叠。
 * 所以这里的 system prompt 里不该出现任何表情、动作、视线相关的要求 ——
 * 那些写了也没用，Act IR 不从这里来。
 *
 * DeepSeek 是 OpenAI 兼容接口，直接 fetch 就够了，不引 SDK
 * （和 jevstation.ts 保持一致，也少一个依赖）。
 */

const DEFAULT_BASE = 'https://api.deepseek.com';
/** 实时对话里延迟直接决定观感，所以默认用 flash 档 */
const DEFAULT_MODEL = 'deepseek-flash';

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** 省略则完全不发 reasoning 相关参数，走最朴素的兼容形状 */
  reasoningEffort?: string;
  /** 通用规则（server/persona.md 的原文）。没有就用内置的兜底规则 */
  personaRules?: string | null;
  /** 角色段：这个模型的人设（src/personas.ts 拼好的），放在通用规则前面 */
  character?: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      /** 推理模型把思考过程放这里，content 可能为空 */
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message?: string };
}

const FALLBACK_PERSONA = `你正在和对方面对面聊天。
- 说人话。口语、短句，一次回应 1~3 句，不要写成书面语。
- 不确定就说不确定，不要硬编。
- 不要提到自己是 AI、模型或程序，除非用户直接问。`;

function readPersona(rules?: string | null): string {
  // 文件开头的 <!-- --> 是写给人看的说明，不发给模型
  return rules ? rules.replace(/<!--[\s\S]*?-->/g, '').trim() : FALLBACK_PERSONA;
}

async function postWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 && r.status < 500) return r;
    last = r;
    await new Promise((res) => setTimeout(res, 400 * 2 ** i + Math.random() * 200));
  }
  return last!;
}

export async function writeSpeech(
  opts: DeepSeekOptions,
  params: {
    input: string;
    /** 调用方已经按长度截好（见 src/chatMemory.ts 的 recentForModel），这里原样全带上 */
    history?: Array<{ role: 'user' | 'character'; text: string }>;
    /** 此刻在哪、几点了（server/scene.ts 写好的一段）。没有就不加 */
    scene?: string | null;
  },
): Promise<string> {
  const url = `${(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/chat/completions`;

  const persona = [opts.character, readPersona(opts.personaRules)].filter(Boolean).join('\n\n');
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: persona },
    // 场景每一轮都按当前的写（换了背景、拖了时间，这一句就知道）
    ...(params.scene ? [{ role: 'system' as const, content: params.scene }] : []),
    {
      role: 'system',
      // 说清楚只要台词本身：加了旁白或动作描述，后面 Jev 拿到的 state 就脏了
      content:
        '只输出角色要说的那句话本身。不要引号，不要旁白，不要括号里的动作描述，不要解释。1~3 句口语。',
    },
  ];
  for (const t of params.history ?? []) {
    messages.push({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text });
  }
  messages.push({ role: 'user', content: params.input });

  const body: Record<string, unknown> = {
    model: opts.model || DEFAULT_MODEL,
    messages,
    stream: false,
  };
  // 文档没有写 thinking 的 disabled 取值，所以默认整个不发这两个参数，
  // 走最朴素的兼容形状。需要推理时用 DEEPSEEK_REASONING_EFFORT 打开。
  if (opts.reasoningEffort) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = opts.reasoningEffort;
  }

  const res = await postWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as ChatResponse | null;
  if (!res.ok) {
    throw new Error(
      `DeepSeek 返回 ${res.status} ${res.statusText}${json?.error?.message ? ` — ${json.error.message}` : ''}`,
    );
  }

  const choice = json?.choices?.[0];
  const text = choice?.message?.content?.trim();

  if (!text) {
    // 空 content 有好几种原因，猜不如报清楚：
    // finish_reason=length 是被 max_tokens 截断；有 reasoning_content 而没 content
    // 说明模型把预算全花在思考上了；两者都没有则是真的空响应。
    const reasoning = choice?.message?.reasoning_content?.trim();
    const detail = [
      choice?.finish_reason ? `finish_reason=${choice.finish_reason}` : null,
      reasoning ? `有 reasoning_content(${reasoning.length} 字)但 content 为空` : null,
      json?.usage ? `completion_tokens=${json.usage.completion_tokens}` : null,
      !choice ? `响应里没有 choices：${JSON.stringify(json).slice(0, 200)}` : null,
    ]
      .filter(Boolean)
      .join('，');
    throw new Error(`DeepSeek 没有返回台词${detail ? `（${detail}）` : ''}`);
  }

  // 模型偶尔会自己套一层引号，剥掉以免进了 TTS 和 Jev 的 state
  return text.replace(/^["'「『]|["'」』]$/g, '').trim();
}
