import { resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { loadEnv } from 'vite';
import { sanitizeAct, type ActScript } from '../src/act/schema';
import { detectBackend, judgePerformance, type JevBackend, type JevMeta } from './jev';
import { writeSpeech } from './deepseek';

/**
 * Jev 决策层的服务端代理。
 *
 * 存在的唯一理由：**key 不能进浏览器**。Vite 只会把 `VITE_` 前缀的变量注入客户端
 * bundle，所以这里读的 JEV_* / DEEPSEEK_* 都没有前缀，只活在 Node 侧。
 * 前端一律打 `/api/act`（同源、无凭据），由这里转发。
 *
 * 两条独立的链路，配好哪条走哪条：
 *
 *   输入层（说什么）   DeepSeek → 见 deepseek.ts。二期会被 gpt-live-1 顶掉。
 *                      没配 key 时回落到前端 MockDecider 的规则模板。
 *   判断层（怎么演）   Jev     → 见 jev.ts。后端有 vercel / jevstation / typesafe 三种，
 *                                   按 key 前缀自动判断（vck_ → Vercel AI Gateway）。
 *
 * 另有 passthrough 模式：Jev 是你自己的 HTTP 服务，自己就输出完整 Act IR，
 * 这里只做转发和鉴权，输入层也一并由那边负责。
 *
 * 两种模式返回给前端的都保证是合法 ActScript —— sanitizeAct 对越界值就近修正、
 * 非法枚举丢弃，决策层再怎么抽风也不会让角色卡死。
 */

interface JevConfig {
  mode: 'jev' | 'passthrough' | 'unconfigured';
  /** 判断层的 key、后端与地址 */
  jevKey?: string;
  jevBackend?: JevBackend;
  jevUrl?: string;
  jevModel?: string;
  /** 输入层：台词从哪来 */
  speechSource: 'deepseek' | 'draft';
  deepseekKey?: string;
  deepseekUrl?: string;
  deepseekModel: string;
  deepseekEffort?: string;
  personaPath: string;
  /** passthrough 模式 */
  endpoint?: string;
  endpointKey?: string;
  authHeader: string;
}

function readConfig(env: Record<string, string>, root: string): JevConfig {
  const declared = (env.JEV_MODE || '').trim();
  // JEV_KEY 是现在的名字；JEVSTATION_API_KEY 作为旧名继续认，省得改配置
  const jevKey = (env.JEV_KEY || env.JEVSTATION_API_KEY || '').trim();
  const endpoint = (env.JEV_ENDPOINT || '').trim();
  const deepseekKey = (env.DEEPSEEK_API_KEY || '').trim();

  let mode: JevConfig['mode'] = 'unconfigured';
  if (declared === 'jev' || declared === 'jevstation') mode = 'jev';
  else if (declared === 'passthrough') mode = 'passthrough';
  else if (jevKey) mode = 'jev';
  else if (endpoint) mode = 'passthrough';

  const declaredBackend = (env.JEV_BACKEND || '').trim();
  const backend: JevBackend | undefined = !jevKey
    ? undefined
    : declaredBackend === 'vercel' || declaredBackend === 'jevstation' || declaredBackend === 'typesafe'
      ? declaredBackend
      : detectBackend(jevKey);

  return {
    mode,
    jevKey: jevKey || undefined,
    jevBackend: backend,
    jevUrl: (env.JEV_BASE_URL || env.JEVSTATION_URL || '').trim() || undefined,
    jevModel: (env.JEV_MODEL || '').trim() || undefined,
    // 配了 DeepSeek 就用它写台词，否则回落到前端的规则模板
    speechSource: (env.JEV_SPEECH || '').trim() === 'draft' || !deepseekKey ? 'draft' : 'deepseek',
    deepseekKey: deepseekKey || undefined,
    deepseekUrl: (env.DEEPSEEK_BASE_URL || '').trim() || undefined,
    deepseekModel: (env.DEEPSEEK_MODEL || 'deepseek-flash').trim(),
    deepseekEffort: (env.DEEPSEEK_REASONING_EFFORT || '').trim() || undefined,
    personaPath: resolve(root, 'server/persona.md'),
    endpoint: endpoint || undefined,
    endpointKey: (env.JEV_API_KEY || '').trim() || undefined,
    authHeader: (env.JEV_AUTH_HEADER || 'Authorization').trim(),
  };
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1_000_000) rej(new Error('payload too large'));
    });
    req.on('end', () => res(buf));
    req.on('error', rej);
  });
}

interface DecideRequest {
  input: string;
  history?: Array<{ role: 'user' | 'character'; text: string }>;
  /** 前端的规则模板台词。只在输入层没配 DeepSeek 时用得上。 */
  draft?: string;
}

async function viaPassthrough(cfg: JevConfig, payload: DecideRequest): Promise<ActScript> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.endpointKey) {
    headers[cfg.authHeader] =
      cfg.authHeader.toLowerCase() === 'authorization'
        ? `Bearer ${cfg.endpointKey}`
        : cfg.endpointKey;
  }
  const r = await fetch(cfg.endpoint!, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Jev 服务返回 ${r.status} ${r.statusText}`);
  const json = (await r.json()) as { act?: unknown };
  return sanitizeAct(json.act ?? json, '（Jev 没有返回台词）');
}

async function viaJev(
  cfg: JevConfig,
  payload: DecideRequest,
): Promise<ActScript & { _jev?: JevMeta; _speechSource?: string }> {
  // 输入层先出台词，判断层再决定怎么演。两步是串行的：
  // Jev 的 state 里要带上这句话，否则判断不出该用什么表情。
  const speech =
    cfg.speechSource === 'deepseek' && cfg.deepseekKey
      ? await writeSpeech(
          {
            apiKey: cfg.deepseekKey,
            baseUrl: cfg.deepseekUrl,
            model: cfg.deepseekModel,
            reasoningEffort: cfg.deepseekEffort,
            personaPath: cfg.personaPath,
          },
          { input: payload.input, history: payload.history },
        )
      : (payload.draft || '').trim();

  if (!speech) {
    throw new Error('没有台词可演：输入层没配 DEEPSEEK_API_KEY，前端也没带 draft。');
  }

  const { act, meta } = await judgePerformance(
    {
      apiKey: cfg.jevKey!,
      backend: cfg.jevBackend,
      baseUrl: cfg.jevUrl,
      model: cfg.jevModel,
    },
    { userInput: payload.input, speech, history: payload.history },
  );
  return { ...sanitizeAct(act, speech), _jev: meta, _speechSource: cfg.speechSource };
}

export function jevProxy(): Plugin {
  let cfg: JevConfig;

  return {
    name: 'jev-proxy',
    configResolved(resolved) {
      // 第三个参数传空字符串 = 加载**所有**环境变量，不只是 VITE_ 前缀的。
      // 这些值只留在 Node 进程里，不会进客户端 bundle。
      const env = loadEnv(resolved.mode, resolved.envDir || resolved.root, '');
      cfg = readConfig(env, resolved.root);
    },
    configureServer(server) {
      server.middlewares.use('/api/act', (req, res, next) => {
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              configured: cfg.mode !== 'unconfigured',
              mode: cfg.mode,
              // 输入层没配 DeepSeek 时，台词得由前端的规则模板补上
              needsDraft: cfg.mode === 'jev' && cfg.speechSource === 'draft',
              speechSource: cfg.mode === 'jev' ? cfg.speechSource : undefined,
              speechModel:
                cfg.mode === 'jev' && cfg.speechSource === 'deepseek' ? cfg.deepseekModel : undefined,
              backend: cfg.mode === 'jev' ? cfg.jevBackend : undefined,
              endpoint: cfg.mode === 'passthrough' ? cfg.endpoint : undefined,
            }),
          );
          return;
        }
        if (req.method !== 'POST') return next();

        void (async () => {
          const fail = (status: number, message: string) => {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: message }));
          };

          if (cfg.mode === 'unconfigured') {
            return fail(503, '还没配置 Jev：把 .env.local 填好再重启 dev server');
          }

          try {
            const payload = JSON.parse(await readBody(req)) as DecideRequest;
            if (!payload?.input) return fail(400, '缺少 input 字段');

            const act =
              cfg.mode === 'jev'
                ? await viaJev(cfg, payload)
                : await viaPassthrough(cfg, payload);

            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(act));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            server.config.logger.error(`[jev] ${msg}`);
            fail(502, msg);
          }
        })();
      });
    },
  };
}
