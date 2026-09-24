import { resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { loadEnv } from 'vite';
import { baselineAct, sanitizeAct, type ActScript } from '../src/act/schema.ts';
import { detectBackend, judgePerformance, judgeReaction, type JevBackend, type JevMeta } from './jev.ts';
import { writeSpeech } from './deepseek.ts';

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
  jevTimeoutMs: number;
  /**
   * 倾听反应：用户话音刚落时先让 Jev 判断角色的第一反应，和输入层并行。
   * 每轮多 1 次评估（1 credit），换来"先有表情再开口"。JEV_REACTION=off 关掉。
   */
  reaction: boolean;
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
    jevTimeoutMs: Number(env.JEV_TIMEOUT_MS || '') || 6000,
    reaction: !/^(off|false|0|no)$/i.test((env.JEV_REACTION || '').trim()),
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

/** 由 configureServer 注入，方便上面两个函数打日志 */
let server_log: (msg: string) => void = () => {};

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

/**
 * 第一段：只出台词。
 *
 * 拆出来是为了让前端拿到台词就能开口 —— 判断层要等 Jev，而 Jev 判断的对象
 * 正是这句话，两者天然串行，没法并发。既然不能并发，就让说话别等判断。
 */
async function runSpeech(cfg: JevConfig, payload: DecideRequest): Promise<string> {
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
  return speech;
}

/**
 * 第二段：判断这句话该怎么演。
 *
 * 判断层是**增强**而不是硬依赖：Jev 挂了、余额没了、网络不通，角色也得把话说完。
 * 所以这里不抛错，失败时退回基线表演并把原因带出去，由前端决定要不要提示。
 */
async function runJudge(
  cfg: JevConfig,
  payload: DecideRequest & { speech: string },
): Promise<ActScript & { _jev?: JevMeta; _jevError?: string }> {
  const { speech } = payload;
  try {
    const { act, meta } = await judgePerformance(
      {
        apiKey: cfg.jevKey!,
        backend: cfg.jevBackend,
        baseUrl: cfg.jevUrl,
        model: cfg.jevModel,
        timeoutMs: cfg.jevTimeoutMs,
      },
      { userInput: payload.input, speech, history: payload.history },
    );
    return { ...sanitizeAct(act, speech), _jev: meta };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    server_log(msg);
    return { ...sanitizeAct(baselineAct(speech), speech), _jevError: msg };
  }
}

/**
 * 倾听反应。和 runSpeech 并行，只看用户输入。
 * 失败就返回 null —— 这只是锦上添花，没有它角色照样说话（用基线表情开口）。
 */
async function runReaction(
  cfg: JevConfig,
  payload: DecideRequest,
): Promise<{ mix: Array<[string, number]>; meta: JevMeta } | null> {
  try {
    return await judgeReaction(
      {
        apiKey: cfg.jevKey!,
        backend: cfg.jevBackend,
        baseUrl: cfg.jevUrl,
        model: cfg.jevModel,
        timeoutMs: cfg.jevTimeoutMs,
      },
      { userInput: payload.input, history: payload.history },
    );
  } catch (e) {
    server_log(`倾听反应：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 一次性拿完整脚本。passthrough 模式和不支持渐进的调用方走这条。 */
async function viaJev(
  cfg: JevConfig,
  payload: DecideRequest,
): Promise<ActScript & { _jev?: JevMeta; _jevError?: string; _speechSource?: string }> {
  const speech = await runSpeech(cfg, payload);
  const judged = await runJudge(cfg, { ...payload, speech });
  return { ...judged, _speechSource: cfg.speechSource };
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
      server_log = (msg) => server.config.logger.error(`[jev] ${msg}`);

      const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };

      const readJson = async (req: Connect.IncomingMessage) =>
        JSON.parse(await readBody(req)) as DecideRequest & { speech?: string };

      // --- 渐进式管线的两段 ---
      // 前端先打 /api/speech，拿到台词立刻开口 + 基线表演；
      // 再打 /api/judge，Jev 的判断回来后升级还没触发的节拍。
      server.middlewares.use('/api/speech', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          if (cfg.mode !== 'jev') return json(res, 400, { error: '当前模式不支持渐进式管线' });
          try {
            const payload = await readJson(req);
            if (!payload?.input) return json(res, 400, { error: '缺少 input 字段' });
            const speech = await runSpeech(cfg, payload);
            json(res, 200, { speech, source: cfg.speechSource });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            server_log(msg);
            json(res, 502, { error: msg });
          }
        })();
      });

      server.middlewares.use('/api/react', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          if (cfg.mode !== 'jev' || !cfg.reaction) return json(res, 400, { error: '倾听反应没有开启' });
          try {
            const payload = await readJson(req);
            if (!payload?.input) return json(res, 400, { error: '缺少 input 字段' });
            const r = await runReaction(cfg, payload);
            json(res, 200, r ?? { mix: null });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            server_log(msg);
            json(res, 502, { error: msg });
          }
        })();
      });

      server.middlewares.use('/api/judge', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          if (cfg.mode !== 'jev') return json(res, 400, { error: '当前模式不支持渐进式管线' });
          try {
            const payload = await readJson(req);
            if (!payload?.input || !payload?.speech) {
              return json(res, 400, { error: '缺少 input 或 speech 字段' });
            }
            json(res, 200, await runJudge(cfg, { ...payload, speech: payload.speech }));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            server_log(msg);
            json(res, 502, { error: msg });
          }
        })();
      });

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
              // passthrough 由对方服务一次性出完整脚本，没法拆两段
              progressive: cfg.mode === 'jev',
              reaction: cfg.mode === 'jev' && cfg.reaction,
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
