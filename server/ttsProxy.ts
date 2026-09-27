import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';

/**
 * 本地语音服务（tts/server.py，Qwen3-TTS · Vivian）的代理和自动启动。
 *
 * 前端只打同源的 /api/tts/*，这里转给 127.0.0.1 上的 Python 服务 —— 语音服务不开 CORS、
 * 不对外监听，和 Jev / DeepSeek 的 key 不进浏览器是同一个思路。
 *
 * 自动启动：dev server 起来时探一下语音服务，没在跑就用 tts/.venv 拉起来。
 * 模型加载 + 预热约 20 秒，期间 /api/tts/health 返回 ready: false，前端先用无声模式。
 *
 * 配置重载（改了 vite.config / server/*）时**不杀**语音服务：新的插件实例探到它还活着就直接复用，
 * 否则每改一次配置就要重新加载一遍 4GB 的模型。只在 Node 进程退出时才关掉它。
 *
 *   TTS=off              完全不用本地语音（UI 回落到系统语音）
 *   TTS_URL=...          语音服务地址，默认 http://127.0.0.1:8765
 *   TTS_AUTOSTART=off    不自动启动（自己另开终端跑 npm run tts）
 */

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

export function ttsProxy(): Plugin {
  let url = 'http://127.0.0.1:8765';
  let enabled = true;
  let autostart = true;
  let root = process.cwd();
  /** 传给 Python 进程的配置。.env.local 里的值 Vite 不会放进 process.env，得显式传 */
  let childEnv: Record<string, string> = {};

  return {
    name: 'tts-proxy',
    configResolved(resolved) {
      const env = loadEnv(resolved.mode, resolved.envDir || resolved.root, '');
      root = resolved.root;
      url = (env.TTS_URL || 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
      enabled = !/^(off|false|0|no)$/i.test((env.TTS || '').trim());
      autostart = !/^(off|false|0|no)$/i.test((env.TTS_AUTOSTART || '').trim());
      childEnv = Object.fromEntries(
        ['TTS_SPEAKER', 'TTS_MODEL', 'TTS_DESIGN_MODEL'].filter((k) => env[k]?.trim()).map((k) => [k, env[k].trim()]),
      );
    },
    configureServer(server) {
      const log = server.config.logger;
      const python = resolve(root, 'tts/.venv/bin/python');
      const script = resolve(root, 'tts/server.py');

      if (enabled && autostart) {
        void (async () => {
          if (await healthy(url)) {
            // 注意：复用的是已经在跑的进程，改了 TTS_SPEAKER 要先结束它才会生效
            log.info('[tts] 语音服务已在运行，直接复用');
            return;
          }
          if (!existsSync(python)) {
            log.warn('[tts] 没找到 tts/.venv，跳过本地语音（安装方法见 README 的"语音"一节）');
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
                log.info(`[tts] ${line.trim()}`);
              }
            }
          };
          child.stdout?.on('data', pipe);
          child.stderr?.on('data', pipe);
          child.on('exit', (code) => {
            if (code) log.warn(`[tts] 语音服务退出（code ${code}）`);
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
              const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
              return send(200, await r.json());
            }
            if (req.method === 'POST' && req.url?.startsWith('/synth')) {
              const chunks: Buffer[] = [];
              for await (const c of req) chunks.push(c as Buffer);
              const r = await fetch(`${url}/synth`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: Buffer.concat(chunks),
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
              return;
            }
            next();
          } catch (e) {
            // 语音服务没起来或正在重启：告诉前端"不可用"，前端退回无声模式
            send(req.method === 'GET' ? 200 : 503, {
              ready: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })();
      });
    },
  };
}
