import type { IncomingMessage, ServerResponse } from 'node:http';

/** 接口共用的上下文：本机是 Vite 的 logger，Vercel 上是 console */
export interface ApiContext {
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** 读请求体（最多 1MB）。Vercel 有时已经替我们读好放在 req.body 上，那就直接用 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (typeof pre === 'string') return pre;
  if (Buffer.isBuffer(pre)) return pre.toString();
  if (pre && typeof pre === 'object') return JSON.stringify(pre);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString();
}
