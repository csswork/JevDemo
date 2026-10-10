/**
 * 在本机跑 .vercel/output（scripts/build-vercel.mjs 的产物），按部署后的样子检查：
 *
 *   npm run build && npm run build:vercel && npm run preview:vercel
 *
 * 只模拟用得上的部分：config.json 里的 /api/* 改写进函数，其余按文件返回。
 * 环境变量读 .env.local（和 Vercel 项目里配的应该是同一组）。没有可写的磁盘这一点也一样：
 * 函数不存聊天记录，前端会改存浏览器。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.vercel/output');
const staticDir = path.join(out, 'static');
if (!fs.existsSync(staticDir)) {
  console.error('没有 .vercel/output：先跑 npm run build && npm run build:vercel');
  process.exit(1);
}
try {
  process.loadEnvFile(path.join(root, '.env.local'));
} catch {
  console.warn('没有 .env.local：函数按没配 key 的样子跑');
}
const { default: handler } = await import(path.join(out, 'functions/api.func/index.mjs'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.hdr': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const api = /^\/api\/(.*)$/.exec(url.pathname);
  if (api) {
    url.searchParams.set('__path', api[1]);
    req.url = `/api${url.search}`;
    return void handler(req, res);
  }
  let file = path.join(staticDir, decodeURIComponent(url.pathname));
  if (!file.startsWith(staticDir)) return void res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT) || 4180;
server.listen(port, () => console.log(`Vercel 输出：http://localhost:${port}`));
