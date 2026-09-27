import type { Emotion, MotionId } from './schema.ts';

/**
 * 对话里什么时候出动作。
 *
 * 动作都是 VRoid 官方的全身动捕（7~12 秒），不是点头摊手这类小手势，
 * 所以门槛很高：**不做动作才是常态**。只有三个会自动触发，其余只在预览面板里播：
 *
 *   打招呼  台词开头是问候、开头或结尾是道别（"你好""欢迎""拜拜"……）。这是说话的礼节，
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
  /** 在第几段开头出手 */
  seg: number;
}

/** 开头的问候：前面可以有一两个语气词（"……嗯？你来啦""哟～你来啦"） */
const HELLO =
  /^[\s…。，、！!？?～~]*(?:[嗯哦啊哟诶欸哎呀]+[\s…。，、！!？?～~]*)?(你好|您好|嗨|哈喽|hello|hi\b|欢迎|早上好|早安|中午好|下午好|晚上好|你来(?:啦|了)|(?:大家|前辈|老师|各位)好|拜拜|再见|晚安|回头见|下次见|明天见)/i;
/** 结尾的道别："那就先这样，拜拜～" */
const BYE = /(拜拜|再见|晚安|回头见|下次见|明天见)[\s～~！!。…]*$/;

const clean = (speech: string) => speech.replace(/<b:[a-z0-9_]+>/gi, '').trim();

/** 台词是不是问候（开头）/ 道别（开头或结尾） */
export function isGreeting(speech: string): boolean {
  const text = clean(speech);
  return HELLO.test(text) || BYE.test(text);
}

/**
 * @param speech    整句台词
 * @param segs      每一段的情绪分布（Jev 按段判断的）
 * @param intensity 强度 0..1（Jev 的 intensity 换算后的 raw 值）
 */
export function pickMotion(
  speech: string,
  segs: Array<Record<string, number>>,
  intensity: number,
): MotionPick | null {
  if (!segs.length) return null;
  const p = (d: Record<string, number>, e: Emotion) => d[e] ?? 0;
  const negative = (d: Record<string, number>) => p(d, 'sad') + p(d, 'angry');
  const text = clean(speech);

  // 问候在开头那一段挥手，结尾的道别在最后一段挥手；那一段是难过 / 生气就不挥
  const greet = HELLO.test(text) ? 0 : BYE.test(text) ? segs.length - 1 : -1;
  if (greet >= 0 && negative(segs[greet]) < 0.35) {
    return { id: 'greeting', label: '打招呼', reason: greet === 0 ? '开头是问候' : '结尾是道别', seg: greet };
  }

  // 比耶 / 转圈看情绪最强的那一段
  let peak = 0;
  segs.forEach((d, i) => {
    if (1 - p(d, 'neutral') > 1 - p(segs[peak], 'neutral')) peak = i;
  });
  const d = segs[peak];
  if (negative(d) < 0.2 && p(d, 'happy') >= 0.3 && p(d, 'surprised') >= 0.3 && intensity >= 0.85) {
    return { id: 'spin', label: '转圈', reason: '开心又惊喜，强度拉满', seg: peak };
  }
  if (negative(d) < 0.2 && p(d, 'happy') >= 0.6 && intensity >= 0.75) {
    return { id: 'peace_sign', label: '比耶', reason: '很强的开心', seg: peak };
  }
  return null;
}
