/**
 * 下载背景场景用的 Poly Haven 素材（全部 CC0）到 public/scene/。
 *   咖啡店  程序生成的，只有打光用的 HDRI（转成环境光，不显示）
 *   公园    树、灌木是 ez-tree 生成的（npm 包），草丛模型来自 ez-tree 的演示场景（public/scene/eztree/）；
 *           这里下的是打光用的 HDR、路灯、石头、木板和草地材质
 *   街景    程序生成的（房子、路、海、远山都是代码和 canvas 画的），借用公园的路灯、木板材质和 HDR，没有自己的清单
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
    'weathered_brown_planks', // 公园：木平台、栈道
    'aerial_grass_rock', // 公园：远处的草地（近处是一丛丛 3D 的草）
  ],
  hdris: [
    'wooden_lounge', // 咖啡店：只用来打光（环境光 / 反射），不显示
    'nagoya_wall_path', // 公园：打光
  ],
  // 显示出来的全景背景：Poly Haven 的 tonemapped JPG（8k、12MB 左右），本地缩到 BACKPLATE_W 宽再存。
  // 现在没有在用的：公园试过用全景照片当背景（nagoya_wall_path），太糊，换成了 3D 的树和草；
  // 咖啡店的窗外试过一张街景全景（venetian_crossroads，按视线方向取景），效果不好，换回了 canvas 画的
  backplates: [],
};
const BACKPLATE_W = 4096;

/**
 * 咖啡店的小物件：Poly Pizza（https://poly.pizza）上的低多边形模型，GLB 直接从 static.poly.pizza 下。
 * 风格统一用 Kenney 和 Quaternius（都是 CC0）；咖啡机 Kenney 只有家用滴漏式，用了 Zsky 的意式咖啡机（CC-BY，要署名）。
 * [文件名, 模型页 id, 文件 uuid, 名字, 作者, 授权]
 */
const POLY_PIZZA = [
  ['espresso_machine', 'kRpKjpQsEd', '607b3787-f8b7-4e68-a8ee-71d34cd91ced', 'Coffee Machine', 'Zsky', 'CC-BY 3.0'],
  ['cup_tea', 'M2sVC8jbmi', '1a3b3f0c-c4af-464f-9cfa-de5117a615c4', 'Cup Tea', 'Kenney', 'CC0'],
  ['cup', 'aSF8ANEIsX', '2b259313-45e2-405f-9b86-18d4ca25a785', 'Cup', 'Kenney', 'CC0'],
  ['frappe', 'ZvYPiZeN0V', 'a3c0d8bc-884d-41b1-a0b3-1c2c01b65286', 'Frappe', 'Kenney', 'CC0'],
  ['cake', 'KGFyP16ebH', 'f61250a2-8e56-4424-81f3-6a73a1549811', 'Cake', 'Kenney', 'CC0'],
  ['cupcake', 'txZDsDca1L', '7b2e3b72-8ffd-4920-9134-c1b60e5ffe91', 'Cupcake', 'Kenney', 'CC0'],
  ['muffin', 'YZWplO0tzB', '920e6336-6a29-4291-8d00-356d423c1230', 'Muffin', 'Kenney', 'CC0'],
  ['donut_sprinkles', 'RnPNAFyKtY', '569364fd-8397-4e26-9ff5-2c4909fc6e27', 'Donut Sprinkles', 'Kenney', 'CC0'],
  ['croissant', 'JDy2TUxcV2', 'b80d6d54-e846-41eb-8155-f84aeaccbcb1', 'Croissant', 'Kenney', 'CC0'],
  ['bar_stool', '2do92chR2k', '92b747ab-ed11-47f4-bcfb-a218b0b7e439', 'Bar Stool', 'Kenney', 'CC0'],
  ['round_table', 'AXbvcMDC8j', 'edb7217c-389f-4233-bfa5-aca3fe649e7c', 'Round Table', 'Kenney', 'CC0'],
  ['chair', 'vHyrBYPBum', 'fca1766a-cc7b-4e22-a60f-49689446bd46', 'Chair', 'Kenney', 'CC0'],
  ['light_ceiling', 'S3HkX8iTl2', '9c07c95e-c245-4db4-80eb-702fef5045ae', 'Light Ceiling', 'Quaternius', 'CC0'],
  ['houseplant_1', 'bfLOqIV5uP', '1683c0b1-4dd9-4d45-910e-cf3e46f163f5', 'Houseplant', 'Quaternius', 'CC0'],
  ['houseplant_2', 'Kr4kr7OCCQ', 'c087694b-eda0-426e-a5d6-a1f9b9d57a28', 'Houseplant', 'Quaternius', 'CC0'],
  ['houseplant_3', 'VtJh4Irl4w', '6e6e6b19-011d-4b1d-9cc0-07269adec9fa', 'Houseplant', 'Quaternius', 'CC0'],
  ['rug_round', 'jeDDiN69Ze', '06a5cc94-d146-4ee6-8506-1be516dc4dbd', 'Rug Round', 'Kenney', 'CC0'],
  ['lamp_round_table', 'auXnXwXD7S', 'a9a2edf1-20f0-4069-846a-f1fc4717c2e8', 'Lamp Round Table', 'Kenney', 'CC0'],
  // 第二批：地板、门窗、沙发角、书架、衣帽架和墙上的摆件（挂画、挂钟、花瓶只有 CC-BY 的）
  ['wood_floor', 'Jw4zM0TcVo', '83f10b45-848d-42cc-bad6-75cb4c532176', 'Wood Floor', 'Quaternius', 'CC0'],
  ['door_double', 'blrNJIEdns', '8e8d87b7-3a2a-4236-90ab-929ea78a10a0', 'Door Double', 'Quaternius', 'CC0'],
  ['window_large', 'EipzkrS9nG', '23e1676f-9152-4fe9-917c-6b98aa66cbe0', 'Window Large', 'Quaternius', 'CC0'],
  ['window_small', 'n88WAcjzTv', '0ab1cc08-63fe-4b22-a166-ea8ac20ae307', 'Window Small', 'Quaternius', 'CC0'],
  ['couch_medium', 'mWgQ94zhDZ', '92a2404e-10d5-4c6a-a188-18b556474f8f', 'Couch Medium', 'Quaternius', 'CC0'],
  ['lounge_chair', 'RY93lbAIFg', '21d3c956-0747-422c-b06d-6d4392380384', 'Lounge Chair', 'Kenney', 'CC0'],
  ['coffee_table', 'y4ZU5S7RuD', '68c4bcbd-0c5d-42ee-ab91-4cce6672fa18', 'Coffee Table', 'Kenney', 'CC0'],
  ['bookcase_books', 'tACDGJ4CGW', '7d59d0aa-6447-4bbb-afc7-0452e9a34353', 'Bookcase with Books', 'Quaternius', 'CC0'],
  ['coat_rack_standing', '8jXUm32dKW', '04ca32d8-db2f-475b-b424-78c5a7e1c3e3', 'Coat Rack Standing', 'Kenney', 'CC0'],
  ['book', 'h3Wh4fxSQX', 'e31bd2aa-b898-47a1-9480-9903fc207111', 'Book', 'Quaternius', 'CC0'],
  ['wall_painting_1', '62zn39CRkbG', 'cd0af234-561a-461c-a048-0e0c58d96ac5', 'Wall painting', 'jeremy', 'CC-BY 3.0'],
  ['wall_painting_2', '0CiZ4f1cZaF', '8b546a02-3167-4183-a4d8-6b6db5c65574', 'Wall painting', 'jeremy', 'CC-BY 3.0'],
  ['analog_clock', '5gAoMR2YHs3', '83ac02a5-b467-464a-b874-17317b9e5dac', 'Analog clock', 'Poly by Google', 'CC-BY 3.0'],
  ['vase', '7img3RnfCzZ', 'aa2dc7de-d0cc-4c4f-bdae-e702effbd553', 'Vase', 'Poly by Google', 'CC-BY 3.0'],
];

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
  const ppCredits = [];
  for (const [file, id, uuid, name, author, licence] of POLY_PIZZA) {
    await save(`https://static.poly.pizza/${uuid}.glb`, path.join(OUT, 'polypizza', `${file}.glb`));
    ppCredits.push(`- [${name}](https://poly.pizza/m/${id}) — ${author}，${licence}`);
  }
  console.log(`Poly Pizza ${POLY_PIZZA.length} 个模型`);
  fs.writeFileSync(
    path.join(OUT, 'CREDITS.md'),
    `# 场景素材\n\n咖啡店场景本身是程序生成的（src/vrm/scenes/cafe.ts），这里只有它打光用的 HDRI；\n公园（src/vrm/scenes/park.ts）用全景背景 + 真实模型；\n街景（src/vrm/scenes/street.ts）除了借用公园的路灯、木板材质、打光的 HDR，咖啡店的几盆绿植，全部程序生成，没有自己的素材文件。\n\n全部来自 [Poly Haven](https://polyhaven.com)，**CC0**（公有领域，可商用、可再分发、不要求署名）。\n` +
      `由 \`scripts/fetch-scene-assets.mjs\` 下载（${RES} 分辨率）。署名不是必须的，这里列出作者以示感谢：\n\n${credits.join('\n')}\n` +
      `\n公园的树和灌木由 [ez-tree](https://github.com/dgreenheck/ez-tree)（npm \`@dgreenheck/ez-tree\`，© 2024 Daniel Greenheck，**MIT**）生成，` +
      `树皮和树叶贴图打包在那个 npm 包里；\`eztree/grass.glb\`（草丛模型）来自 ez-tree 的演示场景，授权原文见 \`eztree/LICENSE\`。\n` +
      `\n## 咖啡店的小物件（\`polypizza/\`）\n\n来自 [Poly Pizza](https://poly.pizza)。CC0 的不要求署名；` +
      `CC-BY（[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)）的必须署名，就是下面这样：\n\n${ppCredits.join('\n')}\n`,
  );
  console.log(`完成：新下载 ${downloaded} 个文件（${(bytes / 1e6).toFixed(1)}MB），跳过已有 ${skipped} 个`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
