/**
 * 流式语音的分帧格式（server/ttsProxy.ts 写，speech/voice.ts 读）。前后端都用，不 import 任何东西。
 *
 * 每帧：类型 1 字节 + 长度 4 字节（小端）+ 内容
 *   pcm    16bit 小端单声道 PCM，采样率在响应头 x-sample-rate；每帧都是整数个采样
 *   times  逐字时间戳 JSON（[{c, t}]），在所有音频帧之后（MiniMax 合成完才给字幕）
 *
 * 为什么不直接传裸 PCM：逐字时间戳要和音频走同一个响应。以前是服务端存在内存里、
 * 前端收完音频再来取，部署成 Vercel Function 后两次请求可能落到不同实例上。
 */

export const AUDIO_FRAMES_TYPE = 'application/x-jev-audio-frames';

export const AUDIO_FRAME = { pcm: 1, times: 2 } as const;

export interface AudioFrame {
  type: number;
  payload: Uint8Array;
}

/** 把网络分块拼回完整的帧（一帧可能被拆在几块里，一块里也可能有好几帧） */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): AudioFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const frames: AudioFrame[] = [];
    let at = 0;
    while (merged.length - at >= 5) {
      const len = new DataView(merged.buffer, merged.byteOffset + at + 1, 4).getUint32(0, true);
      if (merged.length - at - 5 < len) break;
      frames.push({ type: merged[at], payload: merged.slice(at + 5, at + 5 + len) });
      at += 5 + len;
    }
    this.buf = merged.slice(at);
    return frames;
  }
}
