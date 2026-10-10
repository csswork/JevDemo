import type { IncomingMessage, ServerResponse } from 'node:http';
import { baselineAct, sanitizeAct, type ActScript } from '../src/act/schema.ts';
import { detectBackend, judgePerformance, judgeReaction, type JevBackend, type JevMeta } from './jev.ts';
import { writeSpeech } from './deepseek.ts';
import type { ChatStore } from './chatStore.ts';
import { cleanTurns, recentForModel, validSession, type MemoryTurn } from '../src/chatMemory.ts';
import { personaOf, personaPrompt } from '../src/personas.ts';
import { scenePrompt } from './scene.ts';
import { moodPrompt } from './mood.ts';
import type { SceneContext } from '../src/jev/scene.ts';
import { readBody, sendJson, type ApiContext } from './http.ts';

/**
 * Jev 决策层的服务端代理。
 *
 * 存在的唯一理由：**key 不能进浏览器**。Vite 只会把 `VITE_` 前缀的变量注入客户端
 * bundle，所以这里读的 JEV_* / DEEPSEEK_* 都没有前缀，只活在 Node 侧。
 * 前端一律打 `/api/act` 等同源接口（无凭据），由这里转发。
 * 本机由 Vite 的 dev server 挂载，部署时是 Vercel Function —— 见 server/api.ts。
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
  /** passthrough 模式 */
  endpoint?: string;
  endpointKey?: string;
  authHeader: string;
}

function readConfig(env: Record<string, string | undefined>): JevConfig {
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
    endpoint: endpoint || undefined,
    endpointKey: (env.JEV_API_KEY || '').trim() || undefined,
    authHeader: (env.JEV_AUTH_HEADER || 'Authorization').trim(),
  };
}

interface DecideRequest {
  input: string;
  /**
   * 聊天记录的 session（= 模型 id）。输入层按它选人设（src/personas.ts）；
   * 服务端有存储（本机 data/chats/）时历史也从那里取，说完这一轮记下来
   */
  session?: string;
  /** 最近几轮。Jev 的判断只看这几轮；服务端没存储、也没带 memory 时输入层也用它 */
  history?: MemoryTurn[];
  /** 聊天记录存在浏览器时（Vercel），给输入层的更长的历史（前端按 recentForModel 截好） */
  memory?: MemoryTurn[];
  /** 前端的规则模板台词。只在输入层没配 DeepSeek 时用得上。 */
  draft?: string;
  /** 此刻在哪、几点了（输入层用，见 server/scene.ts） */
  scene?: SceneContext;
  /** 她此刻的心情（前几轮累积的，输入层用，见 server/mood.ts） */
  mood?: unknown;
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
async function runSpeech(
  cfg: JevConfig,
  deps: JevDeps,
  payload: DecideRequest,
): Promise<{ speech: string; scene: string | null }> {
  const session = validSession(payload.session) ? payload.session : null;
  const { store } = deps;
  const history =
    store && session
      ? recentForModel(store.load(session))
      : payload.memory
        ? recentForModel(cleanTurns(payload.memory))
        : cleanTurns(payload.history).slice(-8);
  // 场景和心情都是"此刻"的状态，合成一段 system prompt（调试面板"她感知到的场景"里也能看到心情这一段）
  const scene = [scenePrompt(session, payload.scene), moodPrompt(payload.mood)].filter(Boolean).join('\n\n') || null;
  const speech =
    cfg.speechSource === 'deepseek' && cfg.deepseekKey
      ? await writeSpeech(
          {
            apiKey: cfg.deepseekKey,
            baseUrl: cfg.deepseekUrl,
            model: cfg.deepseekModel,
            reasoningEffort: cfg.deepseekEffort,
            personaRules: deps.personaRules(),
            character: personaPrompt(personaOf(session)),
          },
          { input: payload.input, history, scene },
        )
      : (payload.draft || '').trim();

  if (!speech) {
    throw new Error('没有台词可演：输入层没配 DEEPSEEK_API_KEY，前端也没带 draft。');
  }
  // 谁写的台词谁记：这一轮说完就进聊天记录，下一轮的输入层就能看到（记录存浏览器时由前端记）
  if (store && session) {
    store.append(session, [
      { role: 'user', text: payload.input },
      { role: 'character', text: speech },
    ]);
  }
  return { speech, scene };
}

/**
 * 第二段：判断这句话该怎么演。
 *
 * 判断层是**增强**而不是硬依赖：Jev 挂了、余额没了、网络不通，角色也得把话说完。
 * 所以这里不抛错，失败时退回基线表演并把原因带出去，由前端决定要不要提示。
 */
async function runJudge(
  cfg: JevConfig,
  deps: JevDeps,
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
    deps.log.error(`[jev] ${msg}`);
    return { ...sanitizeAct(baselineAct(speech), speech), _jevError: msg };
  }
}

/**
 * 倾听反应。和 runSpeech 并行，只看用户输入。
 * 失败就返回 null —— 这只是锦上添花，没有它角色照样说话（用基线表情开口）。
 */
async function runReaction(
  cfg: JevConfig,
  deps: JevDeps,
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
    deps.log.error(`[jev] 倾听反应：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 一次性拿完整脚本。passthrough 模式和不支持渐进的调用方走这条。 */
async function viaJev(
  cfg: JevConfig,
  deps: JevDeps,
  payload: DecideRequest,
): Promise<ActScript & { _jev?: JevMeta; _jevError?: string; _speechSource?: string; _scene?: string | null }> {
  const { speech, scene } = await runSpeech(cfg, deps, payload);
  const judged = await runJudge(cfg, deps, { ...payload, speech });
  return { ...judged, _speechSource: cfg.speechSource, _scene: scene };
}

interface JevDeps extends ApiContext {
  /** 服务端的聊天记录存储；null = 记录存浏览器（Vercel） */
  store: ChatStore | null;
  /** 输入层的通用规则（server/persona.md 的原文）。本机每次现读，改完不用重启 */
  personaRules: () => string | null;
}

/**
 * Jev / 输入层 / 聊天记录的接口。返回的函数处理一个请求，不认识的路径返回 false。
 *
 *   GET  /api/act           配置状态（前端据此决定走哪条管线）
 *   POST /api/act           一次性拿完整脚本（passthrough 模式、不支持渐进的调用方）
 *   POST /api/speech        渐进式第一段：只出台词，拿到就开口
 *   POST /api/react         倾听反应：和 /api/speech 并行，只看用户那句话
 *   POST /api/judge         渐进式第二段：Jev 判断这句话怎么演，回来后升级还没触发的节拍
 *   POST /api/chat/open     {session} → {persona, turns, greeted}；没有记录就先记一句开场白（greeted = true）
 *   POST /api/chat/reset    {session} → 同上；旧记录归档到 data/chats/archive/
 *   POST /api/chat/append   {session, turns} → {turns}  台词不是服务端写的时候用（规则模板模式）
 *
 * 没有存储（store = null）时 /api/chat/* 回 404，前端改用浏览器里的记录（src/chat.ts）。
 */
export function createJevApi(env: Record<string, string | undefined>, deps: JevDeps) {
  const cfg = readConfig(env);
  const { log, store } = deps;

  const opened = (session: string, archived: string | null = null) => {
    const persona = personaOf(session);
    let turns = store!.load(session);
    let greeted = false;
    if (!turns.length) {
      turns = store!.append(session, [{ role: 'character', text: persona.greeting }]);
      greeted = true;
    }
    return { persona: { id: persona.id, name: persona.name, greeting: persona.greeting }, turns, greeted, archived };
  };

  /** 输入层 / 判断层失败：502 带上原因 */
  const failed = (res: ServerResponse, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`[jev] ${msg}`);
    sendJson(res, 502, { error: msg });
  };

  const readPayload = async (req: IncomingMessage) =>
    JSON.parse((await readBody(req)) || '{}') as DecideRequest & { speech?: string };

  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (path === '/api/act' && req.method === 'GET') {
      sendJson(res, 200, {
        configured: cfg.mode !== 'unconfigured',
        mode: cfg.mode,
        // 输入层没配 DeepSeek 时，台词得由前端的规则模板补上
        needsDraft: cfg.mode === 'jev' && cfg.speechSource === 'draft',
        speechSource: cfg.mode === 'jev' ? cfg.speechSource : undefined,
        speechModel: cfg.mode === 'jev' && cfg.speechSource === 'deepseek' ? cfg.deepseekModel : undefined,
        backend: cfg.mode === 'jev' ? cfg.jevBackend : undefined,
        // passthrough 由对方服务一次性出完整脚本，没法拆两段
        progressive: cfg.mode === 'jev',
        reaction: cfg.mode === 'jev' && cfg.reaction,
        endpoint: cfg.mode === 'passthrough' ? cfg.endpoint : undefined,
      });
      return true;
    }
    if (req.method !== 'POST') return false;

    switch (path) {
      case '/api/speech':
        if (cfg.mode !== 'jev') return sendJson(res, 400, { error: '当前模式不支持渐进式管线' }), true;
        try {
          const payload = await readPayload(req);
          if (!payload?.input) return sendJson(res, 400, { error: '缺少 input 字段' }), true;
          const { speech, scene } = await runSpeech(cfg, deps, payload);
          // scene：这一轮给输入层的场景描述，调试面板显示
          sendJson(res, 200, { speech, source: cfg.speechSource, scene });
        } catch (e) {
          failed(res, e);
        }
        return true;

      case '/api/react':
        if (cfg.mode !== 'jev' || !cfg.reaction) return sendJson(res, 400, { error: '倾听反应没有开启' }), true;
        try {
          const payload = await readPayload(req);
          if (!payload?.input) return sendJson(res, 400, { error: '缺少 input 字段' }), true;
          sendJson(res, 200, (await runReaction(cfg, deps, payload)) ?? { mix: null });
        } catch (e) {
          failed(res, e);
        }
        return true;

      case '/api/judge':
        if (cfg.mode !== 'jev') return sendJson(res, 400, { error: '当前模式不支持渐进式管线' }), true;
        try {
          const payload = await readPayload(req);
          if (!payload?.input || !payload?.speech) return sendJson(res, 400, { error: '缺少 input 或 speech 字段' }), true;
          sendJson(res, 200, await runJudge(cfg, deps, { ...payload, speech: payload.speech }));
        } catch (e) {
          failed(res, e);
        }
        return true;

      case '/api/act':
        if (cfg.mode === 'unconfigured') {
          return sendJson(res, 503, { error: '还没配置 Jev：设置 JEV_KEY（本机写在 .env.local，改完重启 dev server）' }), true;
        }
        try {
          const payload = await readPayload(req);
          if (!payload?.input) return sendJson(res, 400, { error: '缺少 input 字段' }), true;
          sendJson(res, 200, cfg.mode === 'jev' ? await viaJev(cfg, deps, payload) : await viaPassthrough(cfg, payload));
        } catch (e) {
          failed(res, e);
        }
        return true;

      case '/api/chat/open':
      case '/api/chat/reset':
      case '/api/chat/append': {
        if (!store) return sendJson(res, 404, { error: '服务端不存聊天记录', store: 'browser' }), true;
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as { session?: string; turns?: MemoryTurn[] };
          if (!validSession(body.session)) return sendJson(res, 400, { error: 'session 不合法' }), true;
          if (path === '/api/chat/open') return sendJson(res, 200, opened(body.session)), true;
          if (path === '/api/chat/reset') {
            const archived = store.reset(body.session);
            log.info(`[chat] 重置 ${body.session}${archived ? `，旧记录 → ${archived}` : ''}`);
            return sendJson(res, 200, opened(body.session, archived)), true;
          }
          sendJson(res, 200, { turns: store.append(body.session, body.turns ?? []) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error(`[chat] ${msg}`);
          sendJson(res, 500, { error: msg });
        }
        return true;
      }
    }
    return false;
  };
}
