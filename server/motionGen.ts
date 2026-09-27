/**
 * 命令行：用混元文生动作生成一个动作，存到 public/motions/hunyuan/<name>.fbx。
 *
 *   node --experimental-strip-types server/motionGen.ts <name> <秒数> "<描述>"
 *   node --experimental-strip-types server/motionGen.ts listen_smile 8 "一个女孩站着认真聆听对方说话……"
 *
 * 旁边写一份 <name>.json（描述、JobId、时长、生成时间），以后知道这个动作是怎么来的。
 * public/motions/ 在 .gitignore 里，生成的文件不进仓库。每次运行都会扣积分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateMotion, type TencentCreds } from './tencent3d.ts';

/** 只读需要的两个变量，不打印任何值 */
function readCreds(): TencentCreds {
  const text = fs.readFileSync(path.resolve('.env.local'), 'utf8');
  const get = (k: string) =>
    (text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  const secretId = get('TENCENTCLOUD_SECRET_ID');
  const secretKey = get('TENCENTCLOUD_SECRET_KEY');
  if (!secretId || !secretKey) throw new Error('.env.local 里没有 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  return { secretId, secretKey, region: get('TENCENTCLOUD_REGION') || undefined };
}

async function main() {
  const [name, secs, ...rest] = process.argv.slice(2);
  const prompt = rest.join(' ').trim();
  if (!name || !/^[a-z0-9_]+$/.test(name) || !prompt) {
    console.error('用法：node --experimental-strip-types server/motionGen.ts <name> <秒数> "<描述>"');
    process.exit(1);
  }
  const duration = Number(secs) || 5;
  const t0 = Date.now();
  const { jobId, files } = await generateMotion(readCreds(), { prompt, duration }, (s) => console.log(s));
  const fbx = files.find((f) => f.type.toUpperCase() === 'FBX') ?? files[0];
  if (!fbx) throw new Error(`任务完成但没有文件（JobId ${jobId}）`);

  const dir = path.resolve('public/motions/hunyuan');
  fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(fbx.url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(dir, `${name}.fbx`), buf);
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ name, prompt, duration, jobId, files: files.map((f) => f.type), createdAt: new Date().toISOString() }, null, 2),
  );
  console.log(`完成：public/motions/hunyuan/${name}.fbx（${(buf.length / 1024).toFixed(0)}KB，用时 ${Math.round((Date.now() - t0) / 1000)}s）`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
