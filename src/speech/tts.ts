/**
 * Web Speech API 封装 —— 本地语音（voice.ts，Qwen3-TTS · Vivian）不可用时的兜底。
 *
 * 零配置：不用 key、不用后端，macOS/Windows 自带中文嗓音。
 * 局限也要说清楚 —— 拿不到音频流，所以口型只能靠估算时长驱动，也没有语气可言。
 */

export interface SpeakHandle {
  cancel: () => void;
}

export function ttsAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** 挑一个中文嗓音；系统没有就退回默认。voices 是异步加载的，需要等一下。 */
export async function pickChineseVoice(): Promise<SpeechSynthesisVoice | null> {
  if (!ttsAvailable()) return null;
  const get = () => window.speechSynthesis.getVoices();
  let voices = get();
  if (voices.length === 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 800);
      window.speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    voices = get();
  }
  return (
    voices.find((v) => /^zh[-_]CN/i.test(v.lang)) ??
    voices.find((v) => /^zh/i.test(v.lang)) ??
    null
  );
}

export function speak(
  text: string,
  opts: {
    voice?: SpeechSynthesisVoice | null;
    rate?: number;
    pitch?: number;
    onBoundary?: (charIndex: number, elapsed: number) => void;
    onEnd?: () => void;
  } = {},
): SpeakHandle {
  if (!ttsAvailable()) {
    opts.onEnd?.();
    return { cancel: () => {} };
  }

  window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  if (opts.voice) u.voice = opts.voice;
  u.lang = opts.voice?.lang ?? 'zh-CN';
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;

  const t0 = performance.now();
  u.onboundary = (e) => opts.onBoundary?.(e.charIndex, (performance.now() - t0) / 1000);
  u.onend = () => opts.onEnd?.();
  u.onerror = () => opts.onEnd?.();

  window.speechSynthesis.speak(u);
  return { cancel: () => window.speechSynthesis.cancel() };
}
