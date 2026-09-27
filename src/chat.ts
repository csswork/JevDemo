/**
 * 聊天记录的前端接口（服务端见 server/chatStore.ts、server/jevProxy.ts 的 /api/chat）。
 *
 * 每个模型一个 session（session id = 模型 id），各有各的人设和记忆。
 * 渐进式管线里台词是服务端写的，服务端写完顺手记下；只有台词由前端产生时
 * （规则模板、passthrough）才需要前端 append。
 */

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

async function post<T>(action: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/chat/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(json.error ?? `${r.status} ${r.statusText}`);
  return json;
}

export const openChat = (session: string) => post<ChatSession>('open', { session });

export const resetChat = (session: string) => post<ChatSession>('reset', { session });

export const appendChat = (session: string, turns: ChatTurn[]) =>
  post<{ turns: ChatTurn[] }>('append', { session, turns });
