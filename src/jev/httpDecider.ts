import { sanitizeAct, type ActScript } from '../act/schema';
import type { ActDecider, DecideContext } from './decider';

/** 服务端代理的默认地址。key 在代理那一侧，这里不持有任何凭据。 */
export const JEV_PROXY = '/api/act';

export interface JevStatus {
  configured: boolean;
  mode: 'jev' | 'passthrough' | 'unconfigured';
  /** 判断层走的是哪个后端 */
  backend?: 'vercel' | 'jevstation' | 'typesafe';
  /** 输入层没配 DeepSeek —— 台词得由前端的规则模板补上 */
  needsDraft?: boolean;
  /** 输入层实际用的是什么 */
  speechSource?: 'deepseek' | 'draft';
  speechModel?: string;
  endpoint?: string;
}

/** Jev 的原始判断，仅用于调试面板展示 */
export interface JevMeta {
  backend?: 'vercel' | 'jevstation' | 'typesafe';
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

/** 探测代理是否已配置，用于决定 UI 上的开关能不能点。 */
export async function probeJev(): Promise<JevStatus> {
  try {
    const r = await fetch(JEV_PROXY, { method: 'GET' });
    if (!r.ok) return { configured: false, mode: 'unconfigured' };
    return (await r.json()) as JevStatus;
  } catch {
    return { configured: false, mode: 'unconfigured' };
  }
}

/**
 * 走服务端代理的决策器。
 *
 * 前端刻意不直连 Jev，也不持有 key —— Vite 会把 `VITE_` 前缀的变量打进客户端 bundle，
 * 任何人开 DevTools 都能看到。凭据全部留在 server/jevProxy.ts 那一侧。
 */
export class HttpDecider implements ActDecider {
  readonly name = 'jev-proxy';
  private endpoint: string;
  /**
   * 台词兜底来源。输入层（DeepSeek）没配时才用得上 ——
   * Jev 只判断表演、不生成文本，总得有人把话写出来。
   */
  private draftSource: ActDecider | null;
  /** 最近一次 Jev 的原始判断，供调试面板读取 */
  lastMeta: JevMeta | null = null;

  constructor(opts: { endpoint?: string; draftSource?: ActDecider | null } = {}) {
    this.endpoint = opts.endpoint ?? JEV_PROXY;
    this.draftSource = opts.draftSource ?? null;
  }

  async decide(input: string, ctx: DecideContext): Promise<ActScript> {
    const draft = this.draftSource
      ? (await this.draftSource.decide(input, ctx)).speech.replace(/<b:[a-z0-9_]+>/gi, '')
      : undefined;

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, history: ctx.history, draft }),
    });

    if (!res.ok) {
      const detail = await res
        .json()
        .then((j: { error?: string }) => j.error)
        .catch(() => null);
      throw new Error(detail ?? `${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { _jev?: JevMeta };
    this.lastMeta = json._jev ?? null;
    return sanitizeAct(json, '（Jev 没有返回台词）');
  }
}
