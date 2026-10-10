import type { ActScript } from '../act/schema';
import type { SceneContext } from './scene';
import type { MoodState } from '../act/mood';

export interface DecideContext {
  /** 最近几轮对话，最新的在最后 */
  history: Array<{ role: 'user' | 'character'; text: string }>;
  /**
   * 聊天记录的 session（= 模型 id）。带上它，服务端的输入层用这个角色的人设和完整记忆，
   * 说完自己记下这一轮（见 src/chat.ts）
   */
  session?: string;
  /**
   * 聊天记录存浏览器时（部署在 Vercel，见 src/chat.ts）给输入层的更长的历史。
   * 服务端自己存记录时不用带，服务端从 data/chats/ 取
   */
  memory?: Array<{ role: 'user' | 'character'; text: string }>;
  /** 此刻在哪、几点了：输入层据此知道周围的环境（见 src/jev/scene.ts、server/scene.ts） */
  scene?: SceneContext;
  /**
   * 她此刻的心情（前几轮累积的，见 src/act/mood.ts）：输入层据此写台词 —— 还在生气就别一句话就热情起来。
   * 只发数值，怎么跟模型说是服务端的事（server/mood.ts）
   */
  mood?: MoodState;
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
