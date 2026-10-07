import type { Emotion } from './schema';

/**
 * Jev 的情绪分布 → 语音合成的语气指令（Qwen3-TTS 的 instruct）。
 *
 * 声音的语气和脸上的表情来自**同一个**判断：每一段台词的表情用 Jev 对这一段的情绪分布，
 * 这一段的声音也用它。不会出现脸在笑、声音却是平的。
 *
 * 写法是在本机实测过的（tts/bench.py 的 styles 组）：「用开心、轻快的语气说」这类短句
 * 对音高、语速、音量都有明显而稳定的影响；太长太文学化的描述反而不稳定。
 */

const WORDS: Record<Emotion, string> = {
  neutral: '自然、平静',
  happy: '开心、轻快',
  angry: '生气、不耐烦',
  sad: '难过、失落',
  relaxed: '温柔、放松',
  surprised: '惊讶',
  shy: '害羞、小声',
};

/**
 * 常见的混合有更贴切的说法。键是"主导+次要"，按概率排序后的前两名。
 * 和 fromJev.ts 里 criteria 的描述对应：苦笑 ≈ sad + relaxed。害羞现在是单独的情绪（shy）。
 */
const COMPOUND: Record<string, string> = {
  'happy+surprised': '惊喜',
  'surprised+happy': '又惊又喜',
  'sad+relaxed': '无奈、苦笑着',
  'relaxed+sad': '温柔里带点伤感',
  'sad+angry': '委屈',
  'angry+sad': '又气又委屈',
  'happy+sad': '笑着、但有点心酸',
  'neutral+relaxed': '平和、亲切',
  'shy+happy': '害羞又开心',
  'happy+shy': '开心、有点不好意思',
  'shy+surprised': '慌张又害羞',
};

/** 情绪不明显时用的语气 */
export const DEFAULT_TONE = '用自然、亲切的语气说';

/**
 * @param probs     Jev 这一段的情绪概率分布
 * @param intensity 0..1，整句的强度（Jev 的 score 归一化）
 */
export function toneFor(probs: Record<string, number>, intensity = 0.5): string {
  const ranked = (Object.entries(probs) as Array<[Emotion, number]>)
    .filter(([k]) => k in WORDS)
    .sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) return DEFAULT_TONE;

  // 次要情绪够明显（≥ 主导的 40%，且绝对值 ≥ 0.2）才进语气。
  // 次要是 neutral 时不进：它只说明"没那么强烈"，写成"开心里带着一点自然"反而别扭
  const mixed =
    second && second[1] >= 0.2 && second[1] >= top[1] * 0.4 && (second[0] !== 'neutral' || top[0] === 'neutral');
  let words = WORDS[top[0]];
  if (mixed) {
    words = COMPOUND[`${top[0]}+${second[0]}`] ?? `${WORDS[top[0]]}里带着一点${WORDS[second[0]].split('、')[0]}`;
  }
  if (top[0] === 'neutral' && !mixed) return DEFAULT_TONE;

  if (intensity < 0.35) return `稍微带点${words}的语气说`;
  if (intensity > 0.75) return `用非常${words}的语气说`;
  return `用${words}的语气说`;
}

/**
 * 同一个判断的结构化版本，给 MiniMax 用（server/minimaxTts.ts）。
 *
 * MiniMax 不认千问那种自然语言语气指令，只有一个 emotion 枚举 + 语速 / 音量 / 音高，
 * 外加 (sighs) (gasps) 这类语气词标签。以前是服务端从中文语气描述里用正则猜一个情绪，
 * 强度和混合都丢了；现在直接把 Jev 的分布和强度传过去，由服务端换算。
 */
export interface VoiceStyle {
  /** 主导情绪及其概率 */
  emotion: Emotion;
  p: number;
  /** 次要情绪（概率 ≥ 0.2 才给） */
  second?: Emotion;
  p2?: number;
  /** 整句强度 0..1 */
  intensity: number;
  /** 这一段是不是这个情绪刚开始（第一段，或者主导情绪换了）：开口前的叹气、倒吸气只在这时候加 */
  onset: boolean;
}

/** Jev 的分布 → 结构化语气。onset 由调用方按段的先后定 */
export function styleFor(probs: Record<string, number>, intensity = 0.5, onset = true): VoiceStyle {
  const ranked = (Object.entries(probs) as Array<[Emotion, number]>)
    .filter(([k]) => k in WORDS)
    .sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const style: VoiceStyle = {
    emotion: top?.[0] ?? 'neutral',
    p: top?.[1] ?? 1,
    intensity: Math.max(0, Math.min(1, intensity)),
    onset,
  };
  if (second && second[1] >= 0.2) {
    style.second = second[0];
    style.p2 = second[1];
  }
  return style;
}
