import type { Emotion, GestureId } from './schema.ts';

/**
 * 手到脸手势 ↔ 情绪的配对表。
 *
 * 这张表两边都在用，所以必须只有一份：
 *   预览面板   手势 → 情绪   点「掩嘴笑」时自动配上开心，不然看到的是一张面无表情的脸在捂嘴
 *   Jev 驱动   情绪 → 手势   Jev 回来一个情绪分布，挑一个和它最匹配的手势（见 fromJev.ts）
 *
 * pair 是"这个手势通常伴随的情绪混合"，不是触发条件本身。
 */
export interface HandGesture {
  id: GestureId;
  label: string;
  pair: Partial<Record<Emotion, number>>;
  /**
   * 在台词的哪里出手。
   * start —— 情绪是"被触发"的（被逗笑、吓一跳），手几乎和情绪同时到
   * mid   —— 情绪是"酝酿"出来的（想事情、松口气），说到一半才出手
   */
  at: 'start' | 'mid';
  /** 需要伴随视线移开才成立（想事情、尴尬），否则不触发 */
  needsLookAway?: boolean;
}

export const HAND_GESTURES: HandGesture[] = [
  { id: 'cover_mouth_laugh', label: '掩嘴笑', pair: { happy: 0.9 }, at: 'start' },
  { id: 'cover_mouth_gasp', label: '捂嘴惊讶', pair: { surprised: 0.9 }, at: 'start' },
  { id: 'hand_to_cheek', label: '手贴脸颊', pair: { happy: 0.5, surprised: 0.3 }, at: 'start' },
  // 下面三条的配对是按**真实 Jev 判断**校准过的，不是凭直觉写的：
  //   「嗯……这个我得想想」    Jev → neutral 0.52 + relaxed 0.48（想事情是平静的，不纯是 neutral）
  //   「呃……是我没考虑周全」  Jev → sad 0.96 + 移开 0.74（尴尬地道歉，被判成难过）
  //   「又改？行吧我服了」    Jev → angry 0.98（"无奈"在 Jev 眼里是愤怒，不是难过）
  { id: 'hand_to_chin', label: '托腮', pair: { neutral: 0.7, relaxed: 0.5 }, at: 'mid', needsLookAway: true },
  { id: 'rub_neck', label: '摸后颈', pair: { sad: 0.6, relaxed: 0.4 }, at: 'start', needsLookAway: true },
  { id: 'hand_on_chest', label: '抚胸', pair: { relaxed: 0.7 }, at: 'mid' },
  { id: 'palm_forehead', label: '扶额', pair: { angry: 0.7, sad: 0.4 }, at: 'start' },
];

const EMO_AXES: Emotion[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

export interface GesturePick {
  gesture: HandGesture;
  /** 情绪分布与配对向量的余弦相似度 */
  score: number;
}

/**
 * 从 Jev 的判断里挑一个手到脸的动作，或者不挑。
 *
 * 不给 Jev 加第六个问题（那会让单次评估从 1 credit 变 3 credit），而是用它已有的
 * 答案推导：情绪分布和每个手势的配对向量做余弦相似度，最像的那个胜出。
 *
 * 门槛决定"不挑"，而不挑才是常态 —— 真人不会每句话都捂嘴。手势分两类，门槛不同：
 *
 *   情绪类（笑、惊讶、扶额、抚胸）  要求强度够。平淡的句子不配手部动作。
 *   认知/社交类（托腮、摸后颈）     要求视线移开，**不看强度**。
 *
 * 第二类最初也套了强度门槛，结果「嗯……这个我得想想」被 Jev 判成强度 0.27，
 * 托腮一次都没触发 —— 想事情本来就是低强度的。它的信号是视线，不是情绪幅度。
 * 这里留一个 0.1 的地板，只挡掉完全平淡的陈述句。
 */
export function pickGesture(
  probabilities: Record<string, number>,
  intensity: number,
  looksAway: number,
  thresholds = { intensity: 0.45, cognitiveFloor: 0.1, score: 0.8 },
): GesturePick | null {
  const v = EMO_AXES.map((e) => probabilities[e] ?? 0);
  const nv = Math.hypot(...v) || 1;

  let best: GesturePick | null = null;
  for (const g of HAND_GESTURES) {
    if (g.needsLookAway) {
      if (looksAway <= 0.5 || intensity < thresholds.cognitiveFloor) continue;
    } else if (intensity < thresholds.intensity) {
      continue;
    }
    const u = EMO_AXES.map((e) => g.pair[e] ?? 0);
    const nu = Math.hypot(...u) || 1;
    const score = v.reduce((sum, x, i) => sum + x * u[i], 0) / (nv * nu);
    if (!best || score > best.score) best = { gesture: g, score };
  }
  return best && best.score >= thresholds.score ? best : null;
}

export const HAND_GESTURE_IDS = new Set<GestureId>(HAND_GESTURES.map((g) => g.id));
