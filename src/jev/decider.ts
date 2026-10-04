import type { ActScript } from '../act/schema';
import type { SceneContext } from './scene';

export interface DecideContext {
  /** 最近几轮对话，最新的在最后 */
  history: Array<{ role: 'user' | 'character'; text: string }>;
  /**
   * 聊天记录的 session（= 模型 id）。带上它，服务端的输入层用这个角色的人设和完整记忆，
   * 说完自己记下这一轮（见 src/chat.ts）
   */
  session?: string;
  /** 此刻在哪、几点了：输入层据此知道周围的环境（见 src/jev/scene.ts、server/scene.ts） */
  scene?: SceneContext;
}

/**
 * 表演决策器接口。
 *
 * 一期用 MockDecider（纯规则，离线可跑）；接 Jev 时换成 HttpDecider，
 * 其余所有代码不用改一行 —— 这正是把 Act IR 抽出来的意义。
 */
export interface ActDecider {
  readonly name: string;
  decide(input: string, ctx: DecideContext): Promise<ActScript>;
}
