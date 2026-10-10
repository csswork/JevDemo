import type { IncomingMessage, ServerResponse } from 'node:http';
import { MINIMAX_SAMPLE_RATE, MINIMAX_VOICES, synthesizeMiniMax, type MiniMaxConfig } from './minimaxTts.ts';
import type { VoiceStyle } from '../src/act/voiceStyle.ts';
import { AUDIO_FRAME, AUDIO_FRAMES_TYPE } from '../src/speech/frames.ts';
import { readBody, sendJson, type ApiContext } from './http.ts';

/**
 * 语音合成的接口：MiniMax Turbo（server/minimaxTts.ts）。浏览器只打同源的 /api/tts/*，key 不进浏览器。
 *
 *   GET  /api/tts/health   {ready, speaker, voices, error}，音色列表由这里给
 *   POST /api/tts/synth    {text, instruct?, style?, speaker, stream?}
 *        stream: true  → 分帧的流（格式见 src/speech/frames.ts）：音频帧边合成边发，最后一帧是逐字时间戳
 *        否则          → WAV，逐字时间戳在响应头 x-tts-times（encodeURIComponent 过的 JSON）
 *
 * 时间戳和音频走同一个响应：以前是合成完存在内存里、前端再来取，
 * 部署成 Vercel Function 后两次请求可能落到不同实例上，就取不到了。
 *
 *   MINIMAX_API_KEY   没配时 health 回 ready: false，前端退回浏览器的系统语音
 *   MINIMAX_BASE_URL  默认国内 https://api.minimax.cn；海外开放平台的 key 用 https://api.minimax.io
 *   TTS_SPEAKER       默认音色（minimax: 开头的 id，界面下拉框没选过、角色也没配音色时用）
 *   TTS=off           完全不用这里的语音（UI 回落到系统语音）
 */

function wavOf(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // 单声道
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 一帧：类型 1 字节 + 长度 4 字节（小端）+ 内容 */
function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

interface SynthBody {
  text?: string;
  instruct?: string | null;
  style?: VoiceStyle | null;
  speaker?: string;
  stream?: boolean;
}

export function createTtsApi(env: Record<string, string | undefined>, { log }: ApiContext) {
  const enabled = !/^(off|false|0|no)$/i.test((env.TTS || '').trim());
  const key = (env.MINIMAX_API_KEY || '').trim();
  const minimax: MiniMaxConfig | null = key
    ? { apiKey: key, baseUrl: (env.MINIMAX_BASE_URL || 'https://api.minimax.cn').trim() }
    : null;
  const sp = (env.TTS_SPEAKER || '').trim();
  const defaultVoice = MINIMAX_VOICES.some((v) => v.id === sp) ? sp : 'minimax:female-shaonv';

  async function synth(cfg: MiniMaxConfig, body: SynthBody, res: ServerResponse) {
    const text = String(body.text || '').trim();
    if (!text) throw new Error('缺少 text');
    const voice = MINIMAX_VOICES.some((v) => v.id === body.speaker) ? body.speaker! : defaultVoice;
    const t = Date.now();
    let first = 0;
    const pcm: Buffer[] = [];
    let headerSent = false;
    /** 流式时没凑成一个采样（16bit）的单个字节，留给下一帧：每个音频帧都是整数个采样 */
    let odd: Buffer | null = null;
    const sendHead = (sampleRate: number) => {
      if (headerSent) return;
      res.statusCode = 200;
      res.setHeader('content-type', AUDIO_FRAMES_TYPE);
      res.setHeader('x-sample-rate', String(sampleRate));
      res.setHeader('cache-control', 'no-store');
      headerSent = true;
    };
    const onAudio = (data: Buffer) => {
      if (!first) first = Date.now() - t;
      if (!body.stream) return void pcm.push(data);
      // 第一块到了才写响应头：合成一开始就失败的话还能回 503
      sendHead(MINIMAX_SAMPLE_RATE);
      let bytes = odd ? Buffer.concat([odd, data]) : data;
      odd = null;
      if (bytes.length % 2) {
        odd = bytes.subarray(bytes.length - 1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length) res.write(frame(AUDIO_FRAME.pcm, bytes));
    };
    const { sampleRate, times } = await synthesizeMiniMax(
      cfg,
      { text, voice, instructions: body.instruct, style: body.style },
      onAudio,
      AbortSignal.timeout(20000),
    );
    if (body.stream) {
      sendHead(sampleRate);
      if (times?.length) res.write(frame(AUDIO_FRAME.times, Buffer.from(JSON.stringify(times))));
      res.end();
      log.info(`[tts] MiniMax ${((Date.now() - t) / 1000).toFixed(2)}s 首包 ${(first / 1000).toFixed(2)}s（流式） [${voice}] 「${text}」 ${body.instruct ?? ''}`);
      return;
    }
    const all = Buffer.concat(pcm);
    const seconds = all.length / 2 / sampleRate;
    res.statusCode = 200;
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-audio-seconds', seconds.toFixed(3));
    res.setHeader('x-gen-seconds', ((Date.now() - t) / 1000).toFixed(3));
    if (times?.length) res.setHeader('x-tts-times', encodeURIComponent(JSON.stringify(times)));
    res.end(wavOf(all, sampleRate));
    log.info(`[tts] MiniMax ${((Date.now() - t) / 1000).toFixed(2)}s → ${seconds.toFixed(2)}s [${voice}] 「${text}」 ${body.instruct ?? ''}`);
  }

  return {
    /** 启动时打一行，看得出语音配好没有 */
    describe: () =>
      !enabled ? '[tts] 已关闭（TTS=off），用浏览器的系统语音' : minimax ? `[tts] MiniMax 语音 · 默认 ${defaultVoice}` : '[tts] 没配 MINIMAX_API_KEY，用浏览器的系统语音',

    handle: async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
      if (!path.startsWith('/api/tts/')) return false;
      if (!enabled) return sendJson(res, 200, { ready: false, disabled: true }), true;
      try {
        if (req.method === 'GET' && path === '/api/tts/health') {
          if (!minimax) return sendJson(res, 200, { ready: false, error: '没配 MINIMAX_API_KEY' }), true;
          return sendJson(res, 200, { ready: true, speaker: defaultVoice, voices: MINIMAX_VOICES, error: null }), true;
        }
        if (req.method === 'POST' && path === '/api/tts/synth') {
          if (!minimax) throw new Error('没配 MINIMAX_API_KEY');
          await synth(minimax, JSON.parse((await readBody(req)) || '{}') as SynthBody, res);
          return true;
        }
        return false;
      } catch (e) {
        // 合成失败：告诉前端"不可用"，前端退回无声模式
        const msg = e instanceof Error ? e.message : String(e);
        if (req.method !== 'GET') log.warn(`[tts] ${msg}`);
        if (res.headersSent) res.end();
        else sendJson(res, req.method === 'GET' ? 200 : 503, { ready: false, error: msg });
        return true;
      }
    },
  };
}
