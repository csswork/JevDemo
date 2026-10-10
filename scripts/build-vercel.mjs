/**
 * 生成 Vercel 的 Build Output（.vercel/output），给 `vercel deploy --prebuilt` 上传。
 *
 *   npm run build            先出前端（dist/）
 *   npm run build:vercel     再跑这个
 *
 * 不用 `vercel build` 自动识别：服务端代码是 .ts 后缀互相 import 的（和 vite.config 共用，见 vite.config.ts），
 * 交给 Vercel 自己编译不一定认。这里直接按 Build Output API v3 的格式产出：
 *
 *   static/                  dist/ 复制过去，跳过 public/ 里没进 git 的文件（本地候选模型这类）
 *   functions/api.func/      server/vercel.ts 用 rolldown 打成单个 index.mjs，persona.md 放在旁边
 *   config.json              /api/* 全部进这个函数；/assets/* 带内容哈希，长缓存
 *
 * 文档：https://vercel.com/docs/build-output-api/v3
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'rolldown';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, '.vercel/output');
const func = path.join(out, 'functions/api.func');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('没有 dist/：先跑 npm run build');
  process.exit(1);
}

// public/ 里没进 git 的文件（比如 public/models/candidates/）也会被 Vite 复制进 dist，
// 部署出去就等于公开分发了：复制时跳过（CI 里是干净的检出，本来就没有）
const untracked = new Set(
  execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--ignored', '-z', 'public'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((f) => path.join(dist, path.relative('public', f))),
);
for (const f of untracked) if (fs.existsSync(f) && !f.endsWith('.DS_Store')) console.warn(`跳过未入库的文件：${path.relative(dist, f)}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(func, { recursive: true });

fs.cpSync(dist, path.join(out, 'static'), { recursive: true, filter: (src) => !src.endsWith('.DS_Store') && !untracked.has(src) });

await build({
  input: path.join(root, 'server/vercel.ts'),
  platform: 'node',
  write: true,
  output: { file: path.join(func, 'index.mjs'), format: 'esm' },
  logLevel: 'warn',
});
fs.copyFileSync(path.join(root, 'server/persona.md'), path.join(func, 'persona.md'));
fs.writeFileSync(
  path.join(func, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      // 第一段语音是边合成边发的流
      supportsResponseStreaming: true,
      // 等外部接口（DeepSeek 写台词 + 重试、MiniMax 合成）最多一分钟
      maxDuration: 60,
      // 香港：DeepSeek、MiniMax 用的是国内接口（api.deepseek.com / api.minimax.cn），
      // 函数放在默认的美东，每段语音都要多跨一次太平洋。Hobby 只能选一个区域
      regions: ['hkg1'],
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // Vite 打包出来的文件名带内容哈希，可以放心长缓存
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        // 非哈希资源只缓存七天；过期可先用旧副本并在后台校验。
        // 同路径替换文件时需要改资源 URL，避免已缓存的客户端继续用旧版本。
        { src: '^/(models|motions|scene|audio)/(.*)$', headers: { 'cache-control': 'public, max-age=604800, stale-while-revalidate=86400' }, continue: true },
        // 所有接口进同一个函数，原路径放在 __path 里（server/vercel.ts 还原）
        { src: '^/api/(.*)$', dest: '/api?__path=$1' },
        { handle: 'filesystem' },
      ],
    },
    null,
    2,
  ),
);

const size = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((n, e) => n + (e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : 0), 0);
console.log(
  `.vercel/output：静态 ${(size(path.join(out, 'static')) / 1e6).toFixed(1)}MB，函数 ${(size(func) / 1e3).toFixed(0)}KB`,
);
