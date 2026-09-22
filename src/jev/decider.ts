import type { ActScript } from '../act/schema';

export interface DecideContext {
  /** 最近几轮对话，最新的在最后 */
  history: Array<{ role: 'user' | 'character'; text: string }>;
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
