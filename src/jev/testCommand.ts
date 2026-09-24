import { composeAct, composeReaction, type Answers, type ChoiceAnswer, type JevMeta } from '../act/fromJev';
import { splitSegments } from '../act/segments';
import { EMOTIONS, GESTURES, type ActScript, type Emotion, type GestureId } from '../act/schema';

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
 *   测试: 开心 90%                         单一情绪
 *   测试: 难过 40% 放松 30%                混合（验证概率分布驱动的叠加）
 *   测试: 开心 60% | 今天天气不错            自定义台词
 *   测试: 惊讶 80% > 开心 70% > 难过 40%    一句话里的情绪变化，按台词的段依次对应
 *   测试: 反应 惊讶 70%; 开心 80%          先模拟"倾听 → 思考 → 第一反应 → 开口"整个过程
 *   test: happy 90%                        英文同义
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
/** 多段测试的默认台词：切出来分别是 2 段、3 段（见 segments.ts） */
const DEFAULT_ARC_SPEECH: Record<number, string> = {
  2: '哈，行吧。反正我也习惯了。',
  3: '诶？真的吗！那也太好了吧。',
};

/** 手势的中文别名。测试指令里可以直接写「掩嘴笑」。 */
const GESTURE_ALIASES: Record<string, GestureId> = {
  掩嘴笑: 'cover_mouth_laugh',
  捂嘴笑: 'cover_mouth_laugh',
  捂嘴: 'cover_mouth_gasp',
  捂嘴惊讶: 'cover_mouth_gasp',
  倒吸气: 'cover_mouth_gasp',
  手贴脸: 'hand_to_cheek',
  脸颊: 'hand_to_cheek',
  害羞: 'hand_to_cheek',
  托腮: 'hand_to_chin',
  摸下巴: 'hand_to_chin',
  思考: 'hand_to_chin',
  摸后颈: 'rub_neck',
  挠头: 'rub_neck',
  尴尬: 'rub_neck',
  抚胸: 'hand_on_chest',
  松口气: 'hand_on_chest',
  扶额: 'palm_forehead',
  撑额头: 'palm_forehead',
  无奈: 'palm_forehead',
};

function toGesture(word: string): GestureId | null {
  const w = word.trim();
  if ((GESTURES as readonly string[]).includes(w)) return w as GestureId;
  return GESTURE_ALIASES[w] ?? null;
}

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
  /** 模拟的倾听反应。有它时调用方应先"思考"一会儿、上反应，再开口 */
  reaction?: Array<[Emotion, number]>;
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

  const [specAll, speechPart] = body.split(/[|｜]/, 2);

  // 「反应 惊讶 70%;」前缀：模拟倾听反应
  let reactionSpec: string | null = null;
  let specPart = specAll;
  const rm = /^\s*反应\s*([^;；]*)[;；]/.exec(specAll);
  if (rm) {
    reactionSpec = rm[1];
    specPart = specAll.slice(rm[0].length);
  }

  // 先把手势名摘出来 —— 它不带百分比，剩下的才交给情绪解析
  let gesture: GestureId | null = null;
  const words = specPart.match(/[一-龥A-Za-z_]+/g) ?? [];
  for (const w of words) {
    const g = toGesture(w);
    if (g) {
      gesture = g;
      break;
    }
  }

  // 「>」分段：每一段一个情绪（或混合）
  const segSpecs = specPart.split(/[>＞→]/).map(parsePairs);
  const hasEmotion = segSpecs.some((p) => p.length > 0);
  // 只写手势名也算合法：「测试: 掩嘴笑」
  if (!hasEmotion && !gesture && !reactionSpec) return null;
  const specs = segSpecs.map((p) => (p.length ? p : ([['neutral', 0.6]] as Array<[Emotion, number]>)));

  const speech = speechPart?.trim() || DEFAULT_ARC_SPEECH[specs.length] || DEFAULT_SPEECH;
  const segCount = splitSegments(speech).length;

  // --- 构造一份合成的 Jev 答案：每段一个 emotion_N，段比指定的多就沿用最后一个 ---
  const answers: Answers = {};
  let sumMax = 0;
  for (let i = 0; i < segCount; i++) {
    const { answer, sum } = syntheticChoice(specs[Math.min(i, specs.length - 1)]);
    answers[`emotion_${i + 1}`] = answer;
    sumMax = Math.max(sumMax, sum);
  }
  answers.intensity = {
    // 指定的总占比越高，演得越强。score 的量程是 0~(级别数-1)
    score: Math.min(2, sumMax * 2),
    legend: [],
    confidence: 0.9,
  };
  answers.gaze = {
    choice: 'camera',
    probabilities: { camera: 1, away_left: 0, away_right: 0, up: 0, down: 0 },
    confidence: 1,
  };
  answers.posture = {
    choice: 'idle_neutral',
    probabilities: { idle_neutral: 1, idle_cheerful: 0, idle_low: 0, idle_alert: 0 },
    confidence: 1,
  };
  answers.looks_away = { noul: 0 };

  let reaction: Array<[Emotion, number]> | undefined;
  if (reactionSpec) {
    const pairs = parsePairs(reactionSpec);
    const { answer, sum } = syntheticChoice(pairs.length ? pairs : [['neutral', 0.6]]);
    reaction = composeReaction({
      reaction: answer,
      reaction_intensity: { score: Math.min(2, sum * 2), legend: [], confidence: 0.9 },
    })?.mix;
  }

  const { act, meta } = composeAct(speech, answers);
  if (gesture) {
    act.tracks.gesture = [{ at: 0.35, clip: gesture, weight: 1, speed: 1 }];
  }
  const spec = [
    specs.map((pairs) => pairs.map(([e, p]) => `${e} ${Math.round(p * 100)}%`).join(' + ')).join(' → '),
    ...(gesture ? [gesture] : []),
  ].join(' + ');
  return {
    act,
    meta: { ...meta, backend: undefined },
    note: `测试模式：${spec}（跳过 DeepSeek 和 Jev，其余链路不变）`,
    reaction,
  };
}

/** 「开心 90%」「happy 90%」「难过40%」都要能认 */
function parsePairs(spec: string): Array<[Emotion, number]> {
  const pairs: Array<[Emotion, number]> = [];
  const re = /([一-龥A-Za-z]+)\s*(\d{1,3})\s*%?/g;
  for (let m = re.exec(spec); m !== null; m = re.exec(spec)) {
    const emo = toEmotion(m[1]);
    const pct = Number(m[2]) / 100;
    if (emo && pct > 0) pairs.push([emo, Math.min(1, pct)]);
  }
  return pairs;
}

/** 指定的情绪占比 → 一份归一的 choice 答案（剩余概率给 neutral，Jev 回的也是归一的分布） */
function syntheticChoice(pairs: Array<[Emotion, number]>): { answer: ChoiceAnswer; sum: number } {
  const probabilities: Record<string, number> = Object.fromEntries(EMOTIONS.map((e) => [e, 0]));
  let sum = 0;
  for (const [emo, p] of pairs) {
    probabilities[emo] = (probabilities[emo] ?? 0) + p;
    sum += p;
  }
  if (sum < 1) probabilities.neutral = (probabilities.neutral ?? 0) + (1 - sum);
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(probabilities)) probabilities[k] /= total;
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return {
    // Jev 的 confidence 就是分布集中度，这里照同样的语义合成
    answer: { choice: top[0], probabilities, confidence: top[1] },
    sum,
  };
}
