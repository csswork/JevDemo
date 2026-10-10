import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApi } from './api.ts';
import { sendJson } from './http.ts';

/**
 * Vercel Function 的入口：所有 /api/* 都进这一个函数（路由见 scripts/build-vercel.mjs）。
 *
 * 由 scripts/build-vercel.mjs 用 rolldown 打包成单个 index.mjs，persona.md 复制到同一目录。
 * 环境变量（JEV_KEY、DEEPSEEK_API_KEY、MINIMAX_API_KEY …）在 Vercel 项目的 Settings → Environment Variables 里配。
 *
 * 没有可写的磁盘，所以不传聊天记录存储：/api/chat/* 回 404，前端改存浏览器（src/chat.ts）。
 */

let rules: string | null | undefined;
const personaRules = () => {
  if (rules === undefined) {
    try {
      rules = fs.readFileSync(new URL('./persona.md', import.meta.url), 'utf8');
    } catch {
      rules = null;
    }
  }
  return rules;
};

const api = createApi(process.env, { store: null, personaRules, log: console });

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // 路由把 /api/<路径> 改写成 /api?__path=<路径>：这里还原成原来的路径再分发
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sub = url.searchParams.get('__path');
  if (sub != null) {
    url.searchParams.delete('__path');
    req.url = `/api/${sub}${url.search}`;
  }
  try {
    if (!(await api(req, res))) sendJson(res, 404, { error: `没有这个接口：${req.method} ${req.url?.split('?')[0]}` });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  }
}
