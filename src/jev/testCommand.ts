import { composeAct, type Answers, type JevMeta } from '../act/fromJev';
import { EMOTIONS, type ActScript, type Emotion } from '../act/schema';

/**
 * 测试指令。
 *
 * 前端拆掉了所有表演参数的控件（谁说了算必须只有一个答案），但调试时仍然需要
 * 一个确定性的入口：看某个情绪在这个模型上长什么样、验证混合是不是真的混了、
 * 改完渲染层回归一遍。用文本指令代替滑块，UI 保持干净。
 *
 * 关键是它**构造合成的 Jev 答案**，再走 composeAct —— 和真实链路同一份合成代码。
 * 如果测试路径自己算一套 Act IR，测出来的东西不作数。
 *
 * 语法：
 *   测试: 开心 90%                 单一情绪
 *   测试: 难过 40% 放松 30%        混合（验证概率分布驱动的叠加）
 *   测试: 开心 60% | 今天天气不错    自定义台词
 *   test: happy 90%               英文同义
 *
 * 跳过 DeepSeek 和真实 Jev：不花钱、不等网络、结果可复现。
 */

const PREFIX = /^\s*(测试|test)\s*[:：]\s*/i;

/** 中文别名 → VRM 标准表情槽 */
const ALIASES: Record<string, Emotion> = {
  中性: 'neutral',
  平静: 'neutral',
  面无表情: 'neutral',
  开心: 'happy',
  高兴: 'happy',
  快乐: 'happy',
  笑: 'happy',
  生气: 'angry',
  愤怒: 'angry',
  不爽: 'angry',
  难过: 'sad',
  伤心: 'sad',
  低落: 'sad',
  委屈: 'sad',
  放松: 'relaxed',
  温和: 'relaxed',
  平和: 'relaxed',
  惊讶: 'surprised',
  意外: 'surprised',
  吃惊: 'surprised',
  震惊: 'surprised',
};

const DEFAULT_SPEECH = '这是一句用来看表情的测试台词，长度大概够演完三个节拍。';

function toEmotion(word: string): Emotion | null {
  const w = word.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(w)) return w as Emotion;
  return ALIASES[word.trim()] ?? null;
}

export interface TestCommand {
  act: ActScript;
  meta: JevMeta;
  /** 解析过程中的说明，直接显示给用户 */
  note: string;
}

export function isTestCommand(input: string): boolean {
  return PREFIX.test(input);
}

/**
 * 解析并合成。语法不对时返回 null，由调用方退回正常链路。
 */
export function parseTestCommand(input: string): TestCommand | null {
  if (!PREFIX.test(input)) return null;
  const body = input.replace(PREFIX, '');

  const [specPart, speechPart] = body.split(/[|｜]/, 2);
  const speech = speechPart?.trim() || DEFAULT_SPEECH;

  // 「开心 90%」「happy 90%」「难过40%」都要能认
  const pairs: Array<[Emotion, number]> = [];
  const re = /([一-龥A-Za-z]+)\s*(\d{1,3})\s*%?/g;
  for (let m = re.exec(specPart); m !== null; m = re.exec(specPart)) {
    const emo = toEmotion(m[1]);
    const pct = Number(m[2]) / 100;
    if (emo && pct > 0) pairs.push([emo, Math.min(1, pct)]);
  }
  if (pairs.length === 0) return null;

  // --- 构造一份合成的 Jev 答案 ---
  const probabilities: Record<string, number> = Object.fromEntries(
    EMOTIONS.map((e) => [e, 0]),
  );
  let sum = 0;
  for (const [emo, p] of pairs) {
    probabilities[emo] = (probabilities[emo] ?? 0) + p;
    sum += p;
  }
  // 剩余概率给 neutral，让分布归一 —— Jev 回的也是归一的分布
  if (sum < 1) probabilities.neutral = (probabilities.neutral ?? 0) + (1 - sum);
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(probabilities)) probabilities[k] /= total;

  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];

  const answers: Answers = {
    emotion: {
      choice: top[0],
      probabilities,
      // Jev 的 confidence 就是分布集中度，这里照同样的语义合成
      confidence: top[1],
    },
    intensity: {
      // 指定的总占比越高，演得越强。score 的量程是 0~(级别数-1)
      score: Math.min(2, sum * 2),
      legend: [],
      confidence: 0.9,
    },
    gaze: {
      choice: 'camera',
      probabilities: { camera: 1, away_left: 0, away_right: 0, up: 0, down: 0 },
      confidence: 1,
    },
    posture: {
      choice: 'idle_neutral',
      probabilities: { idle_neutral: 1, idle_cheerful: 0, idle_low: 0, idle_alert: 0 },
      confidence: 1,
    },
    looks_away: { noul: 0 },
  };

  const { act, meta } = composeAct(speech, answers);
  const spec = pairs.map(([e, p]) => `${e} ${Math.round(p * 100)}%`).join(' + ');
  return {
    act,
    meta: { ...meta, backend: undefined },
    note: `测试模式：${spec}（跳过 DeepSeek 和 Jev，其余链路不变）`,
  };
}
