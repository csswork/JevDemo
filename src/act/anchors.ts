/**
 * 内联时间锚点。
 *
 * Jev 在台词里写 `你好<b:wave>，很高兴见到你`，解析后得到：
 *   text   = "你好，很高兴见到你"
 *   anchors = [{ name: 'wave', charIndex: 2 }]
 *
 * 为什么不让 Jev 直接给秒数：做表演决策的那一刻，TTS 还没合成，时长是未知的。
 * 字符位置是语义稳定的，等音频就绪后再换算成绝对时间；二期接实时语音流时，
 * 用 TTS 的 boundary 事件持续校正同一套锚点即可。
 */

const ANCHOR_RE = /<b:([a-z_][a-z0-9_]*)>/gi;

export interface Anchor {
  name: string;
  /** 在**剥离标记后**的文本中的字符下标 */
  charIndex: number;
}

export interface ParsedSpeech {
  /** 可直接用于显示和 TTS 的干净文本 */
  text: string;
  anchors: Anchor[];
}

export function parseAnchors(speech: string): ParsedSpeech {
  const anchors: Anchor[] = [];
  let text = '';
  let last = 0;

  ANCHOR_RE.lastIndex = 0;
  for (let m = ANCHOR_RE.exec(speech); m !== null; m = ANCHOR_RE.exec(speech)) {
    text += speech.slice(last, m.index);
    anchors.push({ name: m[1].toLowerCase(), charIndex: text.length });
    last = m.index + m[0].length;
  }
  text += speech.slice(last);

  return { text, anchors };
}

/**
 * 字符下标 → 秒。
 *
 * 一期用线性估算：中文按 `cps` 字/秒匀速。接上真实 TTS 后，把 boundary 事件
 * 采样喂给 `makeMeasuredMapper` 做分段线性插值，同一套锚点无需改动。
 */
export function makeLinearMapper(totalChars: number, durationSec: number) {
  const safeChars = Math.max(1, totalChars);
  return (charIndex: number) => (charIndex / safeChars) * durationSec;
}

/** 按语速估算一段中文的朗读时长（秒）。标点按停顿额外计时。 */
export function estimateDuration(text: string, cps = 5.2): number {
  const pauses = (text.match(/[，,、。！？!?；;：:]/g) ?? []).length;
  return Math.max(0.6, text.length / cps + pauses * 0.12);
}

/**
 * 分段线性插值映射器。samples 为 (charIndex, timeSec) 观测点，
 * 用于把 TTS 的 boundary 事件接进来做实时校正。
 */
export function makeMeasuredMapper(
  samples: Array<{ charIndex: number; time: number }>,
  totalChars: number,
  durationSec: number,
) {
  const pts = [{ charIndex: 0, time: 0 }, ...samples, { charIndex: totalChars, time: durationSec }]
    .filter((p) => Number.isFinite(p.charIndex) && Number.isFinite(p.time))
    .sort((a, b) => a.charIndex - b.charIndex);

  return (charIndex: number) => {
    for (let i = 1; i < pts.length; i++) {
      if (charIndex <= pts[i].charIndex) {
        const a = pts[i - 1];
        const b = pts[i];
        const span = b.charIndex - a.charIndex;
        const t = span <= 0 ? 0 : (charIndex - a.charIndex) / span;
        return a.time + (b.time - a.time) * t;
      }
    }
    return durationSec;
  };
}
