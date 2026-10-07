import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { MINIMAX_VOICES, synthesizeMiniMax, type MiniMaxConfig } from './minimaxTts.ts';
import type { VoiceStyle } from '../src/act/voiceStyle.ts';
import { detectBase, lastDetectError, QWEN_VOICES, synthesize, type QwenConfig, type VoiceMeta } from './qwenTts.ts';

/**
 * 语音合成的代理。两种后端，对浏览器是同一套接口（/api/tts/health、/api/tts/synth）：
 *
 *   qwen   远程千问 Qwen3-TTS（server/qwenTts.ts）。配了 DASHSCOPE_API_KEY 就默认用它。
 *          轻：不占本机内存，以后搬到服务器也只是一个 key
 *   local  本机的 tts/server.py（mlx-audio，Apple Silicon）。要 4.5~9GB 内存，
 *          没配千问 key、或者 TTS_BACKEND=local 时用
 *
 * 前端只打同源的 /api/tts/*：key 不进浏览器，本地服务也不开 CORS、不对外监听。
 * 音色列表由这里统一给（health 里的 voices），前端不用知道是哪个后端。
 *
 *   TTS=off                 完全不用这里的语音（UI 回落到系统语音）
 *   TTS_BACKEND=qwen|local  指定后端；默认有 DASHSCOPE_API_KEY 就是 qwen
 *   DASHSCOPE_API_KEY       千问的 key
 *   DASHSCOPE_BASE_URL      千问的接口地址；默认自动探测（千问 AI 平台 / 百炼北京 / 百炼国际）
 *   QWEN_TTS_MODEL          默认 qwen3-tts-instruct-flash（支持语气指令）
 *   TTS_SPEAKER             默认音色（界面下拉框没选过时用）
 *   MINIMAX_API_KEY         配了就**只用 MiniMax**：界面只列 MiniMax 音色，千问 / 本地的音色隐藏（代码都留着）。
 *                           实测 MiniMax 的效果比千问好很多。没配时和以前一样走千问 / 本地
 *   TTS_SHOW_QWEN=on        配了 MiniMax 时仍然把千问 / 本地的音色列出来（对比试听用）
 *   TTS_URL / TTS_AUTOSTART 本地后端的地址、是否自动启动
 *
 * 本地后端的自动启动：dev server 起来时探一下，没在跑就用 tts/.venv 拉起来。
 * 配置重载时**不杀**它（新的插件实例探到它还活着就复用，免得每次重新加载模型），
 * 只在 Node 进程退出时才关掉。
 */

/** 本地后端（CustomVoice 预设）里的女声。设计音色另从 tts/server.py 的 health 里来 */
const LOCAL_VOICES: VoiceMeta[] = [
  ['vivian', 'Vivian', '年轻女声，明亮、略带锐感'],
  ['serena', 'Serena', '年轻女声，温暖、柔和'],
  ['ono_anna', 'Ono Anna', '俏皮女声，轻快（母语日语，中文带口音）'],
  ['sohee', 'Sohee', '温暖女声，情感丰富（母语韩语，中文带口音）'],
].map(([id, name, desc]) => ({ id, name, desc, group: '预设音色' }));

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

let child: ChildProcess | null = null;
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const kill = () => {
    if (child && child.exitCode == null) child.kill('SIGTERM');
  };
  process.on('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      kill();
      process.exit();
    });
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
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

/** 音频块如果带着 WAV 头（有的部署第一块是完整的 WAV 头），把头剥掉，只留 PCM */
function stripWavHeader(bytes: Buffer): Buffer {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return bytes;
  const data = bytes.indexOf('data', 12, 'ascii');
  return data >= 0 ? bytes.subarray(data + 8) : bytes.subarray(44);
}

export function ttsProxy(): Plugin {
  let url = 'http://127.0.0.1:8765';
  let enabled = true;
  let autostart = true;
  let backend: 'qwen' | 'local' = 'local';
  let qwen: QwenConfig | null = null;
  let minimax: MiniMaxConfig | null = null;
  /** 配了 MiniMax 时只用它：千问 / 本地的音色不列出来，本地服务也不自动拉起 */
  let minimaxOnly = false;
  let minimaxDefault = 'minimax:female-shaonv';
  let root = process.cwd();
  /** 传给 Python 进程的配置。.env.local 里的值 Vite 不会放进 process.env，得显式传 */
  let childEnv: Record<string, string> = {};

  return {
    name: 'tts-proxy',
    configResolved(resolved) {
      const env = loadEnv(resolved.mode, resolved.envDir || resolved.root, '');
      const off = (v?: string) => /^(off|false|0|no)$/i.test((v || '').trim());
      root = resolved.root;
      url = (env.TTS_URL || 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
      enabled = !off(env.TTS);
      autostart = !off(env.TTS_AUTOSTART);
      const key = (env.DASHSCOPE_API_KEY || '').trim();
      const declared = (env.TTS_BACKEND || '').trim();
      backend = declared === 'local' || declared === 'qwen' ? declared : key ? 'qwen' : 'local';
      qwen = key
        ? {
            apiKey: key,
            baseUrl: (env.DASHSCOPE_BASE_URL || '').trim() || undefined,
            model: (env.QWEN_TTS_MODEL || 'qwen3-tts-instruct-flash').trim(),
            defaultVoice: (env.TTS_SPEAKER || 'Vivian').trim(),
          }
        : null;
      // MiniMax 仅增加可选音色，不参与默认后端和默认音色的选择。
      const minimaxKey = (env.MINIMAX_API_KEY || '').trim();
      minimax = minimaxKey ? {
        apiKey: minimaxKey,
        baseUrl: (env.MINIMAX_BASE_URL || 'https://api.minimax.cn').trim(),
      } : null;
      const on = (v?: string) => /^(on|true|1|yes)$/i.test((v || '').trim());
      minimaxOnly = !!minimax && !on(env.TTS_SHOW_QWEN);
      const sp = (env.TTS_SPEAKER || '').trim();
      if (MINIMAX_VOICES.some((v) => v.id === sp)) minimaxDefault = sp;
      childEnv = Object.fromEntries(
        ['TTS_SPEAKER', 'TTS_MODEL', 'TTS_DESIGN_MODEL'].filter((k) => env[k]?.trim()).map((k) => [k, env[k].trim()]),
      );
    },
    configureServer(server) {
      const log = server.config.logger;

      if (enabled && minimaxOnly) log.info(`[tts] MiniMax 语音（千问 / 本地音色已隐藏，TTS_SHOW_QWEN=on 可显示）· 默认 ${minimaxDefault}`);
      if (enabled && !minimaxOnly && backend === 'qwen' && qwen) {
        const cfg = qwen;
        void detectBase(cfg).then((base) =>
          base
            ? log.info(`[tts] 远程千问语音：${new URL(base).host} · ${cfg.model} · 默认 ${cfg.defaultVoice}`)
            : log.warn(`[tts] ${lastDetectError()}`),
        );
      }
      if (enabled && !minimaxOnly && backend === 'local' && autostart) startLocal(log);

      function startLocal(logger: typeof log) {
        const python = resolve(root, 'tts/.venv/bin/python');
        const script = resolve(root, 'tts/server.py');
        void (async () => {
          if (await healthy(url)) {
            // 注意：复用的是已经在跑的进程，改了 TTS_SPEAKER 要先结束它才会生效
            logger.info('[tts] 本地语音服务已在运行，直接复用');
            return;
          }
          if (!existsSync(python)) {
            logger.warn('[tts] 没找到 tts/.venv，跳过本地语音（安装方法见 README 的"语音"一节）');
            return;
          }
          const port = new URL(url).port || '8765';
          child = spawn(python, [script], {
            cwd: root,
            env: { ...process.env, ...childEnv, PYTHONUNBUFFERED: '1', TTS_PORT: port },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          hookExit();
          const pipe = (buf: Buffer) => {
            for (const line of buf.toString().split('\n')) {
              // transformers / tqdm 的噪音不转发
              if (line.trim() && !/it\/s\]|Fetching|\[transformers\]|Initialized encoder/.test(line)) {
                logger.info(`[tts] ${line.trim()}`);
              }
            }
          };
          child.stdout?.on('data', pipe);
          child.stderr?.on('data', pipe);
          child.on('exit', (code) => {
            if (code) logger.warn(`[tts] 本地语音服务退出（code ${code}）`);
            child = null;
          });
        })();
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
              if (minimaxOnly) return send(200, minimaxHealth());
              return send(200, backend === 'qwen' ? await qwenHealth() : await localHealth());
            }
            if (req.method === 'GET' && req.url?.startsWith('/times')) {
              const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
              const hit = subtitleTimes.get(id);
              subtitleTimes.delete(id);
              return send(200, { times: hit?.times ?? null });
            }
            if (req.method === 'POST' && req.url?.startsWith('/synth')) {
              const chunks: Buffer[] = [];
              for await (const c of req) chunks.push(c as Buffer);
              const body = Buffer.concat(chunks);
              const params = JSON.parse(body.toString() || '{}');
              if (typeof params.speaker === 'string' && params.speaker.startsWith('minimax:')) {
                if (!minimax) throw new Error('没配 MINIMAX_API_KEY');
                return await remoteSynth(params, res);
              }
              if (backend === 'qwen') return await remoteSynth(params, res);
              return await localSynth(body, res);
            }
            next();
          } catch (e) {
            // 后端不可用：告诉前端"不可用"，前端退回无声模式
            const msg = e instanceof Error ? e.message : String(e);
            if (req.method !== 'GET') log.warn(`[tts] ${msg}`);
            if (res.headersSent) return res.end();
            send(req.method === 'GET' ? 200 : 503, { ready: false, error: msg });
          }
        })();
      });

      function minimaxHealth() {
        return { ready: true, backend, speaker: minimaxDefault, voices: MINIMAX_VOICES, error: null };
      }

      async function qwenHealth() {
        if (!qwen) return { ready: false, backend, error: '没配 DASHSCOPE_API_KEY' };
        const base = await detectBase(qwen);
        return {
          ready: !!base,
          backend,
          speaker: qwen.defaultVoice,
          voices: [...QWEN_VOICES, ...(minimax ? MINIMAX_VOICES : [])],
          error: base ? null : lastDetectError(),
        };
      }

      async function localHealth() {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
        const h = (await r.json()) as {
          ready: boolean;
          speaker?: string;
          speakers?: string[];
          designed?: Array<{ id: string; name: string; desc: string }>;
          designed_ready?: boolean;
          error?: string | null;
          design_error?: string | null;
        };
        const voices: Array<VoiceMeta & { disabled?: boolean }> = [
          ...LOCAL_VOICES.filter((v) => h.speakers?.includes(v.id)),
          ...(h.designed ?? []).map((d) => ({
            ...d,
            group: h.designed_ready ? '设计音色' : '设计音色（加载中）',
            disabled: !h.designed_ready,
          })),
        ];
        voices.push(...(minimax ? MINIMAX_VOICES : []));
        return {
          ready: h.ready,
          backend,
          speaker: h.speaker,
          voices,
          // 设计音色还在加载：前端继续探测，加载好了才能选
          pending: (h.designed?.length ?? 0) > 0 && !h.designed_ready && !h.design_error,
          error: h.error ?? null,
        };
      }

      async function remoteSynth(
        body: { text?: string; instruct?: string | null; style?: VoiceStyle | null; speaker?: string; stream?: boolean },
        res: ServerResponse,
      ) {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('缺少 text');
        const useMiniMax = body.speaker?.startsWith('minimax:') ?? false;
        if (!useMiniMax && !qwen) throw new Error('没配 DASHSCOPE_API_KEY');
        const label = useMiniMax ? 'MiniMax Turbo' : '千问';
        const t = Date.now();
        let first = 0;
        const pcm: Buffer[] = [];
        let headerSent = false;
        // 只有 MiniMax 有逐字时间戳
        const id = useMiniMax ? randomUUID() : null;
        if (id) res.setHeader('x-tts-id', id);
        const onAudio = (bytes: Buffer) => {
          const data = stripWavHeader(bytes);
          if (!first) first = Date.now() - t;
          if (body.stream) {
            // 两个远程后端都使用 24kHz PCM，第一块到了才写响应头。
            if (!headerSent) {
              res.statusCode = 200;
              res.setHeader('content-type', 'application/octet-stream');
              res.setHeader('x-sample-rate', '24000');
              headerSent = true;
            }
            res.write(data);
          } else pcm.push(data);
        };
        const signal = AbortSignal.timeout(20000);
        const { sampleRate, times } = useMiniMax
          ? await synthesizeMiniMax(minimax!, { text, voice: body.speaker!, instructions: body.instruct, style: body.style }, onAudio, signal)
          : { ...(await synthesize(qwen!, { text, voice: body.speaker, instructions: body.instruct }, onAudio, signal)), times: undefined };
        if (id && times) keepTimes(id, times);
        const who = body.speaker || qwen!.defaultVoice;
        if (body.stream) {
          if (!headerSent) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/octet-stream');
            res.setHeader('x-sample-rate', String(sampleRate));
          }
          res.end();
          log.info(`[tts] ${label} ${((Date.now() - t) / 1000).toFixed(2)}s 首包 ${(first / 1000).toFixed(2)}s（流式） [${who}] 「${text}」 ${body.instruct ?? ''}`);
          return;
        }
        const all = Buffer.concat(pcm);
        const seconds = all.length / 2 / sampleRate;
        res.statusCode = 200;
        res.setHeader('content-type', 'audio/wav');
        res.setHeader('x-audio-seconds', seconds.toFixed(3));
        res.setHeader('x-gen-seconds', ((Date.now() - t) / 1000).toFixed(3));
        res.end(wavOf(all, sampleRate));
        log.info(`[tts] ${label} ${((Date.now() - t) / 1000).toFixed(2)}s → ${seconds.toFixed(2)}s [${who}] 「${text}」 ${body.instruct ?? ''}`);
      }

      async function localSynth(body: Buffer, res: ServerResponse) {
        const r = await fetch(`${url}/synth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(20000),
        });
        res.statusCode = r.status;
        for (const h of ['content-type', 'x-audio-seconds', 'x-gen-seconds', 'x-sample-rate']) {
          const v = r.headers.get(h);
          if (v) res.setHeader(h, v);
        }
        // 逐块转发，不能先攒完：流式合成的意义就是第一块尽早到浏览器
        if (r.body) {
          for await (const chunk of r.body) res.write(chunk);
        }
        res.end();
      }
    },
  };
}
