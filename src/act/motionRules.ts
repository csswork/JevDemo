import type { Emotion, MotionId } from './schema.ts';

/**
 * 对话里什么时候出动作。
 *
 * 动作都是 VRoid 官方的全身动捕（7~12 秒），不是点头摊手这类小手势，
 * 所以门槛很高：**不做动作才是常态**。只有三个会自动触发，其余只在预览面板里播：
 *
 *   打招呼  台词开头是问候 / 道别（"你好""欢迎""拜拜"……）。这是说话的礼节，
 *           不是情绪，所以看台词；但 Jev 判成难过 / 生气时不挥手（"再见……"不该笑着招手）
 *   比耶    Jev 判断这一段是很强的开心（开心 ≥ 0.6，强度 ≥ 0.75）
 *   转圈    开心又惊喜，强度拉满（开心、惊讶都 ≥ 0.3，强度 ≥ 0.85）—— 最少见
 *
 * 和表情一样，情绪是什么、多强由 Jev 决定；这里只是把 Jev 已有的答案换算成"要不要动"，
 * 不多问 Jev 一个问题（多一个问题就多一次评估）。
 */

export interface MotionPick {
  id: MotionId;
  label: string;
  /** 为什么选它（调试面板显示） */
  reason: string;
}

const GREETING = /^[\s…。，、！!？?～~]*(?:[嗯哦啊哟诶欸哎呀]+[\s…。，、！!]*)?(你好|您好|嗨|哈喽|hello|hi\b|欢迎|早上好|早安|中午好|下午好|晚上好|你来(?:啦|了)|拜拜|再见|晚安|回头见|下次见|明天见)/i;

/** 台词开头是不是问候 / 道别 */
export function isGreeting(speech: string): boolean {
  return GREETING.test(speech.replace(/<b:[a-z0-9_]+>/gi, ''));
}

/**
 * @param speech   整句台词
 * @param first    第一段的情绪分布（打招呼看开头那一段）
 * @param peak     情绪最强的那一段的分布（比耶 / 转圈看它）
 * @param intensity 强度 0..1（Jev 的 intensity 换算后的 raw 值）
 */
export function pickMotion(
  speech: string,
  first: Record<string, number>,
  peak: Record<string, number>,
  intensity: number,
): MotionPick | null {
  const p = (d: Record<string, number>, e: Emotion) => d[e] ?? 0;
  const negative = (d: Record<string, number>) => p(d, 'sad') + p(d, 'angry');

  if (isGreeting(speech) && negative(first) < 0.35) {
    return { id: 'greeting', label: '打招呼', reason: '台词开头是问候 / 道别' };
  }
  if (negative(peak) < 0.2 && p(peak, 'happy') >= 0.3 && p(peak, 'surprised') >= 0.3 && intensity >= 0.85) {
    return { id: 'spin', label: '转圈', reason: '开心又惊喜，强度拉满' };
  }
  if (negative(peak) < 0.2 && p(peak, 'happy') >= 0.6 && intensity >= 0.75) {
    return { id: 'peace_sign', label: '比耶', reason: '很强的开心' };
  }
  return null;
}
