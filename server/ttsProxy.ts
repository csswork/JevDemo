import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { MINIMAX_SAMPLE_RATE, MINIMAX_VOICES, synthesizeMiniMax, type MiniMaxConfig } from './minimaxTts.ts';
import type { VoiceStyle } from '../src/act/voiceStyle.ts';

/**
 * 语音合成的代理：MiniMax Turbo（server/minimaxTts.ts）。浏览器只打同源的 /api/tts/*，key 不进浏览器。
 *
 *   GET  /api/tts/health   {ready, speaker, voices, error}，音色列表由这里给
 *   POST /api/tts/synth    {text, instruct?, style?, speaker, stream?} → 流式 PCM（x-sample-rate）或 WAV
 *   GET  /api/tts/times    逐字时间戳（见下面 subtitleTimes）
 *
 *   MINIMAX_API_KEY   没配时 health 回 ready: false，前端退回浏览器的系统语音
 *   MINIMAX_BASE_URL  默认国内 https://api.minimax.cn；海外开放平台的 key 用 https://api.minimax.io
 *   TTS_SPEAKER       默认音色（minimax: 开头的 id，界面下拉框没选过、角色也没配音色时用）
 *   TTS=off           完全不用这里的语音（UI 回落到系统语音）
 */

/**
 * MiniMax 的逐字时间戳，按合成请求的 id 暂存（响应头 x-tts-id）。
 * 流式响应的头在第一块音频时就发出去了，那时还没有字幕（字幕在最后一块里），
 * 所以前端收完音频之后再来取：GET /api/tts/times?id=…。取过就删，没人取的一分钟后清掉
 */
const subtitleTimes = new Map<string, { times: Array<{ c: number; t: number }>; at: number }>();
function keepTimes(id: string, times: Array<{ c: number; t: number }>) {
  const now = Date.now();
  for (const [k, v] of subtitleTimes) if (now - v.at > 60_000) subtitleTimes.delete(k);
  subtitleTimes.set(id, { times, at: now });
}

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

export function ttsProxy(): Plugin {
  let enabled = true;
  let minimax: MiniMaxConfig | null = null;
  let defaultVoice = 'minimax:female-shaonv';

  return {
    name: 'tts-proxy',
    configResolved(resolved) {
      const env = loadEnv(resolved.mode, resolved.envDir || resolved.root, '');
      enabled = !/^(off|false|0|no)$/i.test((env.TTS || '').trim());
      const key = (env.MINIMAX_API_KEY || '').trim();
      minimax = key ? { apiKey: key, baseUrl: (env.MINIMAX_BASE_URL || 'https://api.minimax.cn').trim() } : null;
      const sp = (env.TTS_SPEAKER || '').trim();
      if (MINIMAX_VOICES.some((v) => v.id === sp)) defaultVoice = sp;
    },
    configureServer(server) {
      const log = server.config.logger;
      if (enabled) {
        if (minimax) log.info(`[tts] MiniMax 语音 · 默认 ${defaultVoice}`);
        else log.warn('[tts] 没配 MINIMAX_API_KEY，用浏览器的系统语音');
      }

      server.middlewares.use('/api/tts', (req, res, next) => {
        void (async () => {
          const send = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(body));
          };
          if (!enabled) return send(200, { ready: false, disabled: true });

          try {
            if (req.method === 'GET' && req.url?.startsWith('/health')) {
              if (!minimax) return send(200, { ready: false, error: '没配 MINIMAX_API_KEY' });
              return send(200, { ready: true, speaker: defaultVoice, voices: MINIMAX_VOICES, error: null });
            }
            if (req.method === 'GET' && req.url?.startsWith('/times')) {
              const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
              const hit = subtitleTimes.get(id);
              subtitleTimes.delete(id);
              return send(200, { times: hit?.times ?? null });
            }
            if (req.method === 'POST' && req.url?.startsWith('/synth')) {
              if (!minimax) throw new Error('没配 MINIMAX_API_KEY');
              const chunks: Buffer[] = [];
              for await (const c of req) chunks.push(c as Buffer);
              return await synth(minimax, JSON.parse(Buffer.concat(chunks).toString() || '{}'), res);
            }
            next();
          } catch (e) {
            // 合成失败：告诉前端"不可用"，前端退回无声模式
            const msg = e instanceof Error ? e.message : String(e);
            if (req.method !== 'GET') log.warn(`[tts] ${msg}`);
            if (res.headersSent) return res.end();
            send(req.method === 'GET' ? 200 : 503, { ready: false, error: msg });
          }
        })();
      });

      async function synth(
        cfg: MiniMaxConfig,
        body: { text?: string; instruct?: string | null; style?: VoiceStyle | null; speaker?: string; stream?: boolean },
        res: ServerResponse,
      ) {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('缺少 text');
        const voice = MINIMAX_VOICES.some((v) => v.id === body.speaker) ? body.speaker! : defaultVoice;
        const t = Date.now();
        let first = 0;
        const pcm: Buffer[] = [];
        let headerSent = false;
        const id = randomUUID();
        res.setHeader('x-tts-id', id);
        const onAudio = (data: Buffer) => {
          if (!first) first = Date.now() - t;
          if (body.stream) {
            // 第一块到了才写响应头
            if (!headerSent) {
              res.statusCode = 200;
              res.setHeader('content-type', 'application/octet-stream');
              res.setHeader('x-sample-rate', String(MINIMAX_SAMPLE_RATE));
              headerSent = true;
            }
            res.write(data);
          } else pcm.push(data);
        };
        const { sampleRate, times } = await synthesizeMiniMax(
          cfg,
          { text, voice, instructions: body.instruct, style: body.style },
          onAudio,
          AbortSignal.timeout(20000),
        );
        if (times) keepTimes(id, times);
        if (body.stream) {
          if (!headerSent) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/octet-stream');
            res.setHeader('x-sample-rate', String(sampleRate));
          }
          res.end();
          log.info(`[tts] MiniMax ${((Date.now() - t) / 1000).toFixed(2)}s 首包 ${(first / 1000).toFixed(2)}s（流式） [${voice}] 「${text}」 ${body.instruct ?? ''}`);
          return;
        }
        const all = Buffer.concat(pcm);
        const seconds = all.length / 2 / sampleRate;
        res.statusCode = 200;
        res.setHeader('content-type', 'audio/wav');
        res.setHeader('x-audio-seconds', seconds.toFixed(3));
        res.setHeader('x-gen-seconds', ((Date.now() - t) / 1000).toFixed(3));
        res.end(wavOf(all, sampleRate));
        log.info(`[tts] MiniMax ${((Date.now() - t) / 1000).toFixed(2)}s → ${seconds.toFixed(2)}s [${voice}] 「${text}」 ${body.instruct ?? ''}`);
      }
    },
  };
}
