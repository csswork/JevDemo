import type { Emotion } from '../act/schema';

/** 情绪的中文名（面板、预览按钮、实时轨道都用这一份） */
export const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: '平静',
  happy: '开心',
  angry: '生气',
  sad: '难过',
  relaxed: '放松',
  surprised: '惊讶',
  shy: '害羞',
};

/** 情绪 id → 中文；不认识的原样返回 */
export const emotionLabel = (id: string) => (EMOTION_LABEL as Record<string, string>)[id] ?? id;
