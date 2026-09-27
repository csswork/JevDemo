/**
 * 开发用：把浏览器里渲染的对比图存到 dev-out/（gitignored）。
 *
 *   POST /__dev/save?name=faces_Vita.jpg   body = 图片字节
 *   GET  /__dev/save?name=faces_Vita.jpg   读回来（拼对比总图用）
 *
 * 审计工具（src/dev/audit.ts 的 __faces）截完图直接存盘，不用靠截屏把图拿出来。
 * configureServer 只在 `vite dev` 时生效，生产构建里没有这个接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const OUT = path.resolve('dev-out');

export function devSave(): Plugin {
  return {
    name: 'dev-save',
    configureServer(server) {
      server.middlewares.use('/__dev/save', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!/^[\w.-]+\.(jpe?g|png)$/.test(name) || (req.method !== 'POST' && req.method !== 'GET')) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        if (req.method === 'GET') {
          const file = path.join(OUT, name);
          if (!fs.existsSync(file)) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          res.setHeader('content-type', name.endsWith('.png') ? 'image/png' : 'image/jpeg');
          res.end(fs.readFileSync(file));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync(OUT, { recursive: true });
          const file = path.join(OUT, name);
          fs.writeFileSync(file, Buffer.concat(chunks));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ file: path.relative(process.cwd(), file) }));
        });
      });
    },
  };
}
