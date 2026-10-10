/**
 * 聊天记录的服务端存储：每个模型一个 session（session id = 模型 id），存成 data/chats/<id>.json。
 *
 * 为什么放服务端：输入层（DeepSeek）要"记得之前聊过什么"，历史从这里读，
 * 前端不用每次把整段记录传上来；换浏览器、清缓存也不会丢。data/ 在 .gitignore 里，聊天内容不进仓库。
 *
 * 只在本机开发时用。部署到 Vercel 时函数没有可写的磁盘，不传 store（见 server/api.ts），
 * 记录改存浏览器（src/chat.ts）。以后要服务端存储，实现一个同样接口的 ChatStore（数据库 / KV）传进去就行。
 *
 * 重置不是删除：旧记录挪到 data/chats/archive/<id>-<时间>.json，想找回来还在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanTurns, type MemoryTurn } from '../src/chatMemory.ts';

export interface ChatTurn extends MemoryTurn {
  /** ISO 时间 */
  at: string;
}

export interface ChatStore {
  load(id: string): ChatTurn[];
  append(id: string, turns: MemoryTurn[]): ChatTurn[];
  /** 重置：归档旧记录，返回归档到哪（没有记录时返回 null） */
  reset(id: string): string | null;
}

interface ChatFile {
  session: string;
  turns: ChatTurn[];
  updatedAt: string;
}

const DIR = path.resolve('data/chats');
const ARCHIVE = path.join(DIR, 'archive');

const fileOf = (id: string) => path.join(DIR, `${id}.json`);

function load(id: string): ChatTurn[] {
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

export const fileChatStore: ChatStore = {
  load,
  append(id, turns) {
    const at = new Date().toISOString();
    const all = [...load(id), ...cleanTurns(turns).map((t) => ({ ...t, at }))];
    save(id, all);
    return all;
  },
  reset(id) {
    const file = fileOf(id);
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(ARCHIVE, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(ARCHIVE, `${id}-${stamp}.json`);
    fs.renameSync(file, dest);
    return path.relative(process.cwd(), dest);
  },
};
