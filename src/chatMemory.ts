/**
 * 聊天记录的共用部分（前后端都用，不 import 任何东西）。
 *
 * 记录存在哪有两种：本机开发时存服务端的 data/chats/（server/chatStore.ts），
 * 部署到 Vercel 时服务端没有可写的磁盘，存浏览器（src/chat.ts），每轮把最近的记录带给输入层。
 * 两边截取"给输入层看多少"用的是同一个函数，表现一致。
 */

export interface MemoryTurn {
  role: 'user' | 'character';
  text: string;
}

/** session id = 模型 id，服务端会拼进文件名，只认字母数字下划线横线 */
export function validSession(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(id);
}

/** 不信任请求里带来的记录：只留合法的 role 和非空文本，每条最多 2000 字 */
export function cleanTurns(raw: unknown): MemoryTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is MemoryTurn =>
        !!t && (t.role === 'user' || t.role === 'character') && typeof t.text === 'string' && !!t.text.trim(),
    )
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, 2000) }));
}

/**
 * 给输入层的历史：从最新往前取，最多 maxTurns 条、合计 maxChars 字。
 * 聊得再久，每次请求的长度也有上限（费用、延迟都跟着长度走）。
 * 更早的内容暂时就不带了 —— 以后要"长期记忆"，在这里加一段摘要。
 */
export function recentForModel<T extends { text: string }>(turns: T[], maxTurns = 40, maxChars = 6000): T[] {
  const out: T[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < maxTurns; i--) {
    chars += turns[i].text.length;
    if (chars > maxChars && out.length) break;
    out.unshift(turns[i]);
  }
  return out;
}
