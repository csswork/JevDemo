/**
 * 下载背景场景用的 Poly Haven 素材（全部 CC0）到 public/scene/。
 *   咖啡店  程序生成的，只有打光用的 HDRI（转成环境光，不显示）
 *   公园    远景是一张公园全景图（backplates：投影到地面上，人站在里面），打光用同一张的 1k HDR，
 *           近处是真实模型（路灯、石头）和木板材质
 *
 *   npm run assets
 *
 * 清单在下面的 MANIFEST，增删素材只改这里（模型 / 材质也支持，但写实模型和动漫角色放在一起很突兀，试过后撤掉了）。已经下载过的文件会跳过，可以反复运行。
 * 下载下来的文件进 git（部署到 web 时直接带上；CC0 允许再分发），这个脚本是"文件是从哪来的"的记录，
 * 也方便以后换分辨率（RES）重新拉一遍。
 *
 * Poly Haven 的 API 要求调用方带上自己的 User-Agent，默认的会被拒（403）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const RES = '1k';
const OUT = path.resolve('public/scene');
const UA = { 'User-Agent': 'JevDemo/0.1 (three-vrm cafe scene; asset fetch script)' };

const MANIFEST = {
  models: [
    'street_lamp_01', // 公园：欧式路灯
    'rock_moss_set_01', // 公园：一组带青苔的石头
  ],
  // diffuse + 法线（OpenGL）+ arm（R=AO G=粗糙度 B=金属度）
  textures: [
    'weathered_brown_planks', // 公园：木平台
  ],
  hdris: [
    'wooden_lounge', // 咖啡店：只用来打光（环境光 / 反射），不显示
    'nagoya_wall_path', // 公园：打光
  ],
  // 显示出来的全景背景：Poly Haven 的 tonemapped JPG（8k、12MB 左右），本地缩到 BACKPLATE_W 宽再存
  backplates: ['nagoya_wall_path'],
};
const BACKPLATE_W = 4096;

async function api(p) {
  const r = await fetch(`https://api.polyhaven.com/${p}`, { headers: UA });
  if (!r.ok) throw new Error(`api ${p}: ${r.status}`);
  return r.json();
}

let downloaded = 0;
let skipped = 0;
let bytes = 0;
async function save(url, file) {
  if (fs.existsSync(file)) {
    skipped++;
    return;
  }
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`下载失败 ${r.status}：${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  downloaded++;
  bytes += buf.length;
}

async function main() {
  const credits = [];
  for (const id of MANIFEST.models) {
    const [files, info] = await Promise.all([api(`files/${id}`), api(`info/${id}`)]);
    const g = files.gltf?.[RES]?.gltf;
    if (!g) throw new Error(`${id} 没有 ${RES} 的 glTF`);
    const dir = path.join(OUT, 'models', id);
    await save(g.url, path.join(dir, `${id}.gltf`));
    // glTF 里引用的 .bin 和贴图，按它要的相对路径存
    for (const [rel, f] of Object.entries(g.include ?? {})) await save(f.url, path.join(dir, rel));
    credits.push(`- 模型 [${info.name}](https://polyhaven.com/a/${id}) — ${Object.keys(info.authors ?? {}).join(', ')}`);
    console.log(`模型 ${id}`);
  }
  for (const id of MANIFEST.textures) {
    const [files, info] = await Promise.all([api(`files/${id}`), api(`info/${id}`)]);
    for (const map of ['Diffuse', 'nor_gl', 'arm']) {
      const f = files[map]?.[RES]?.jpg;
      if (f) await save(f.url, path.join(OUT, 'textures', id, `${map.toLowerCase()}.jpg`));
    }
    credits.push(`- 材质 [${info.name}](https://polyhaven.com/a/${id}) — ${Object.keys(info.authors ?? {}).join(', ')}`);
    console.log(`材质 ${id}`);
  }
  for (const id of MANIFEST.hdris) {
    const [files, info] = await Promise.all([api(`files/${id}`), api(`info/${id}`)]);
    await save(files.hdri[RES].hdr.url, path.join(OUT, 'hdri', `${id}_${RES}.hdr`));
    credits.push(`- HDRI [${info.name}](https://polyhaven.com/a/${id}) — ${Object.keys(info.authors ?? {}).join(', ')}`);
    console.log(`HDRI ${id}`);
  }
  for (const id of MANIFEST.backplates) {
    const [files, info] = await Promise.all([api(`files/${id}`), api(`info/${id}`)]);
    const out = path.join(OUT, 'hdri', `${id}_${BACKPLATE_W / 1024}k.jpg`);
    if (fs.existsSync(out)) skipped++;
    else {
      // 原图先下到系统临时目录，缩好了再存进仓库（macOS 自带的 sips；别的系统没有就原样存）
      const tmp = path.join(os.tmpdir(), `${id}_tonemapped.jpg`);
      await save(files.tonemapped.url, tmp);
      try {
        execFileSync('sips', ['-Z', String(BACKPLATE_W), '-s', 'formatOptions', '82', tmp, '--out', out], { stdio: 'ignore' });
      } catch {
        console.warn(`没有 sips，${id} 的全景图按原尺寸存（${(fs.statSync(tmp).size / 1e6).toFixed(1)}MB）`);
        fs.copyFileSync(tmp, out);
      }
    }
    credits.push(`- 全景背景 [${info.name}](https://polyhaven.com/a/${id}) — ${Object.keys(info.authors ?? {}).join(', ')}`);
    console.log(`全景 ${id}`);
  }
  fs.writeFileSync(
    path.join(OUT, 'CREDITS.md'),
    `# 场景素材\n\n咖啡店场景本身是程序生成的（src/vrm/scenes/cafe.ts），这里只有它打光用的 HDRI；\n公园（src/vrm/scenes/park.ts）用全景背景 + 真实模型。\n\n全部来自 [Poly Haven](https://polyhaven.com)，**CC0**（公有领域，可商用、可再分发、不要求署名）。\n` +
      `由 \`scripts/fetch-scene-assets.mjs\` 下载（${RES} 分辨率）。署名不是必须的，这里列出作者以示感谢：\n\n${credits.join('\n')}\n`,
  );
  console.log(`完成：新下载 ${downloaded} 个文件（${(bytes / 1e6).toFixed(1)}MB），跳过已有 ${skipped} 个`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
