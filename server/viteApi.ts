import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { createApi } from './api.ts';
import { fileChatStore } from './chatStore.ts';

/** 本机：把 server/api.ts 的接口挂在 Vite 的 dev server 上（部署时是 server/vercel.ts） */
export function apiServer(): Plugin {
  let api: ReturnType<typeof createApi>;
  return {
    name: 'jev-api',
    configResolved(resolved) {
      // 第三个参数传空字符串 = 加载**所有**环境变量，不只是 VITE_ 前缀的。
      // 这些值只留在 Node 进程里，不会进客户端 bundle。
      const env = loadEnv(resolved.mode, resolved.envDir || resolved.root, '');
      const rules = path.resolve(resolved.root, 'server/persona.md');
      const log = resolved.logger;
      api = createApi(env, {
        store: fileChatStore,
        // 每次现读：改了 persona.md 下一轮就生效，不用重启
        personaRules: () => (fs.existsSync(rules) ? fs.readFileSync(rules, 'utf8') : null),
        log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
      });
    },
    configureServer(server) {
      for (const line of api.describe()) server.config.logger.info(line);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        api(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(next);
      });
    },
  };
}
