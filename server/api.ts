import type { IncomingMessage, ServerResponse } from 'node:http';
import { createJevApi } from './jevProxy.ts';
import { createTtsApi } from './ttsProxy.ts';
import type { ChatStore } from './chatStore.ts';
import type { ApiContext } from './http.ts';

/**
 * 服务端接口（/api/act、/api/speech、/api/react、/api/judge、/api/chat/*、/api/tts/*）。
 *
 * 一份代码两个宿主：
 *   本机    server/viteApi.ts 挂在 Vite 的 dev server 上，聊天记录存 data/chats/
 *   Vercel  server/vercel.ts 打包成一个 Function（scripts/build-vercel.mjs），
 *           没有可写的磁盘，不传 store，聊天记录存浏览器
 *
 * 存在的理由：**key 不能进浏览器**。这里读的 JEV_* / DEEPSEEK_* / MINIMAX_* 都没有 VITE_ 前缀，
 * 只活在 Node 侧（本机来自 .env.local，Vercel 上来自项目的环境变量）。
 */

export interface ApiOptions extends ApiContext {
  store: ChatStore | null;
  /** server/persona.md 的原文 */
  personaRules: () => string | null;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** 处理一个请求；不是这里的接口返回 false（交给下一个中间件，或者回 404） */
export function createApi(env: Record<string, string | undefined>, opts: ApiOptions): ApiHandler & { describe: () => string[] } {
  const jev = createJevApi(env, opts);
  const tts = createTtsApi(env, opts);
  const handle: ApiHandler = async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    return (await jev(req, res, pathname)) || (await tts.handle(req, res, pathname));
  };
  return Object.assign(handle, { describe: () => [tts.describe()] });
}
