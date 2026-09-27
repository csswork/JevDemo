/**
 * 聊天记录：每个模型一个 session（session id = 模型 id），存成 data/chats/<id>.json。
 *
 * 为什么放服务端而不是浏览器：输入层（DeepSeek）要"记得之前聊过什么"，历史从这里读，
 * 前端不用每次把整段记录传上来；换浏览器、清缓存也不会丢；以后搬到服务器上，
 * 这一层原样换成数据库就行。data/ 在 .gitignore 里，聊天内容不进仓库。
 *
 * 重置不是删除：旧记录挪到 data/chats/archive/<id>-<时间>.json，想找回来还在。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ChatTurn {
  role: 'user' | 'character';
  text: string;
  /** ISO 时间 */
  at: string;
}

interface ChatFile {
  session: string;
  turns: ChatTurn[];
  updatedAt: string;
}

const DIR = path.resolve('data/chats');
const ARCHIVE = path.join(DIR, 'archive');

/** session id 会拼进文件名，只认字母数字下划线横线 */
export function validSession(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(id);
}

const fileOf = (id: string) => path.join(DIR, `${id}.json`);

export function loadChat(id: string): ChatTurn[] {
  try {
    const json = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as ChatFile;
    return Array.isArray(json.turns) ? json.turns : [];
  } catch {
    return [];
  }
}

function save(id: string, turns: ChatTurn[]) {
  fs.mkdirSync(DIR, { recursive: true });
  const body: ChatFile = { session: id, turns, updatedAt: new Date().toISOString() };
  // 先写临时文件再改名：写到一半进程被杀，也不会留下半个 JSON 把整段记录弄坏
  const tmp = `${fileOf(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, fileOf(id));
}

export function appendChat(id: string, turns: Array<Pick<ChatTurn, 'role' | 'text'>>): ChatTurn[] {
  const at = new Date().toISOString();
  const clean = turns
    .filter((t) => (t.role === 'user' || t.role === 'character') && typeof t.text === 'string' && t.text.trim())
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, 2000), at }));
  const all = [...loadChat(id), ...clean];
  save(id, all);
  return all;
}

/** 重置：归档旧记录，返回归档文件（没有记录时返回 null） */
export function resetChat(id: string): string | null {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(ARCHIVE, `${id}-${stamp}.json`);
  fs.renameSync(file, dest);
  return path.relative(process.cwd(), dest);
}

/**
 * 给输入层的历史：从最新往前取，最多 maxTurns 条、合计 maxChars 字。
 * 聊得再久，每次请求的长度也有上限（费用、延迟都跟着长度走）。
 * 更早的内容暂时就不带了 —— 以后要"长期记忆"，在这里加一段摘要。
 */
export function recentForModel(turns: ChatTurn[], maxTurns = 40, maxChars = 6000): ChatTurn[] {
  const out: ChatTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < maxTurns; i--) {
    chars += turns[i].text.length;
    if (chars > maxChars && out.length) break;
    out.unshift(turns[i]);
  }
  return out;
}
