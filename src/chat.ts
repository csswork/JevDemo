/**
 * 聊天记录的前端接口。每个模型一个 session（session id = 模型 id），各有各的人设和记忆。
 *
 * 记录存在哪有两种，第一次打开时自动判断：
 *
 *   server   本机开发：存服务端的 data/chats/（server/chatStore.ts）。渐进式管线里台词是服务端写的，
 *            服务端写完顺手记下；只有台词由前端产生时（规则模板、passthrough）才需要前端 append
 *   browser  部署到 Vercel（函数没有可写的磁盘，/api/chat/* 回 404），或者干脆没有服务端（纯静态）：
 *            存 localStorage，每轮由前端记；给输入层的历史由前端截好带上（DecideContext.memory）
 */
import { cleanTurns } from './chatMemory';
import { personaOf } from './personas';

export interface ChatTurn {
  role: 'user' | 'character';
  text: string;
  at?: string;
}

export interface ChatSession {
  persona: { id: string; name: string; greeting: string };
  turns: ChatTurn[];
  /** 这次打开时才记下开场白（新 session，或刚重置）：前端据此让她开口打招呼 */
  greeted: boolean;
  /** 重置时旧记录归档到哪 */
  archived?: string | null;
}

export type ChatStorage = 'server' | 'browser';

let storage: ChatStorage | null = null;

/** 记录存在哪；第一次 openChat 之前是 null */
export const chatStorage = () => storage;

/** 服务端没有聊天记录接口（404 / 不是 JSON / 连不上）：改存浏览器 */
class NoServerStore extends Error {}

async function post<T>(action: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api/chat/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NoServerStore();
  }
  if (r.status === 404 || !r.headers.get('content-type')?.includes('application/json')) throw new NoServerStore();
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(json.error ?? `${r.status} ${r.statusText}`);
  return json;
}

// ---- 浏览器里的记录 ----

/** 每个 session 最多留这么多条，localStorage 只有几 MB */
const MAX_TURNS = 500;
const keyOf = (session: string) => `jev.chat.${session}`;

function loadLocal(session: string): ChatTurn[] {
  try {
    return cleanTurns(JSON.parse(localStorage.getItem(keyOf(session)) ?? '[]'));
  } catch {
    return [];
  }
}

function saveLocal(session: string, turns: ChatTurn[]) {
  try {
    localStorage.setItem(keyOf(session), JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    // 存不下（隐私模式、满了）：这一页里照样能聊，只是刷新后不记得
  }
}

function openLocal(session: string, archived: string | null = null): ChatSession {
  const persona = personaOf(session);
  let turns = loadLocal(session);
  let greeted = false;
  if (!turns.length) {
    turns = [{ role: 'character', text: persona.greeting }];
    saveLocal(session, turns);
    greeted = true;
  }
  return { persona: { id: persona.id, name: persona.name, greeting: persona.greeting }, turns, greeted, archived };
}

// ---- 对外 ----

export async function openChat(session: string): Promise<ChatSession> {
  if (storage !== 'browser') {
    try {
      const chat = await post<ChatSession>('open', { session });
      storage = 'server';
      return chat;
    } catch (e) {
      if (!(e instanceof NoServerStore)) throw e;
      storage = 'browser';
    }
  }
  return openLocal(session);
}

export async function resetChat(session: string): Promise<ChatSession> {
  if (storage === 'server') return post<ChatSession>('reset', { session });
  // 浏览器里只留最近一份归档（同样不是删除）
  const old = loadLocal(session);
  if (old.length) {
    try {
      localStorage.setItem(`${keyOf(session)}.archive`, JSON.stringify(old));
    } catch {
      // 存不下就算了
    }
  }
  try {
    localStorage.removeItem(keyOf(session));
  } catch {
    // 同上
  }
  return openLocal(session, old.length ? '浏览器' : null);
}

export async function appendChat(session: string, turns: ChatTurn[]): Promise<{ turns: ChatTurn[] }> {
  if (storage === 'server') return post<{ turns: ChatTurn[] }>('append', { session, turns });
  const at = new Date().toISOString();
  const all = [...loadLocal(session), ...cleanTurns(turns).map((t) => ({ ...t, at }))];
  saveLocal(session, all);
  return { turns: all };
}
