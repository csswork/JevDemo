import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import sharp from 'sharp';
import { optimizeGlb, webp } from './asset-codecs.mjs';
import { decryptModel, encryptModel } from '../src/vrm/protect.ts';

const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, '.asset-cache');
const files = path.join(cache, 'files');
const records = path.join(cache, 'records');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// These tiny flower atlases show visible chroma shifts with lossy WebP (only 264KB saved together).
const preserveOriginal = name => /^scene\/eztree\/flower_(blue|white|yellow)\.glb$/.test(name);
const policy = digest(Buffer.concat([
  fs.readFileSync(new URL('./asset-codecs.mjs', import.meta.url)),
  // Bump this when orchestration changes a codec setting; unrelated dependency changes keep the cache.
  Buffer.from(`v2:sharp-${sharp.versions.sharp}:webp92:data96:tree92:meshopt1.1.1:opus64k:vrm-lossless-meshopt`),
]));

export async function prepareAssets() {
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(records, { recursive: true });
  const writeAtomic = (filename, bytes) => {
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, filename);
  };
  const manifest = {};
  const report = [];
  const treeImages = new Map();
  const old = fs.existsSync(path.join(cache, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(cache, 'index.json'))) : {};
  const next = {};
  async function store(name, bytes, transform, ext = path.extname(name)) {
    const key = digest(Buffer.concat([Buffer.from(policy + name + (preserveOriginal(name) ? ':original-atlas-v1' : '')), bytes]));
    const recordFile = path.join(records, `${key}.json`);
    // Multiple dev/build processes can have different recipes. Cache each recipe
    // separately so a preview cannot invalidate another build's completed work.
    let record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile)) : old[name];
    if (record?.key !== key || !fs.existsSync(path.join(files, record.file))) {
      const output = await transform(bytes);
      if (/\.(webp|jpg|jpeg|png)$/.test(ext)) {
        ext = output.toString('ascii', 0, 4) === 'RIFF' ? '.webp' : output[0] === 0x89 ? '.png' : '.jpg';
      }
      const file = `${path.basename(name, path.extname(name))}.${digest(output).slice(0, 20)}${ext}`;
      if (!fs.existsSync(path.join(files, file))) writeAtomic(path.join(files, file), output);
      record = { key, file, original: bytes.length, optimized: output.length };
    }
    next[name] = record;
    writeAtomic(recordFile, JSON.stringify(record));
    // Retain completed work if a later codec/download fails.
    writeAtomic(path.join(cache, 'index.json'), JSON.stringify({ ...old, ...next }, null, 2));
    report.push({ source: name, ...record });
    return `/optimized/${record.file}`;
  }
  const tracked = execFileSync('git', ['ls-files', '-z', 'public'], { cwd: root }).toString().split('\0').filter(Boolean)
    .sort((a, b) => Number(a.endsWith('.ogg')) - Number(b.endsWith('.ogg')));
  for (const file of tracked) {
    const relative = file.slice('public/'.length);
    if (!/^(models|motions|scene|audio|avatars)\//.test(relative) || !/\.(vrm|vrmx|vrma|vrmax|glb|gltf|bin|jpg|jpeg|png|ogg|hdr)$/.test(relative)) continue;
    const bytes = fs.readFileSync(path.join(root, file));
    const ext = path.extname(file);
    let outputExt = ext;
    let transform = async b => b;
    if (preserveOriginal(relative)) transform = async b => b;
    else if (ext === '.vrm' || ext === '.glb') transform = b => optimizeGlb(b, { geometry: true });
    else if (ext === '.vrmx') transform = async b => {
      const plain = Buffer.from(await decryptModel(new Uint8Array(b).buffer));
      const optimized = await optimizeGlb(plain, { geometry: true });
      const encrypted = Buffer.from(await encryptModel(new Uint8Array(optimized)));
      if (!Buffer.from(await decryptModel(new Uint8Array(encrypted).buffer)).equals(optimized)) throw new Error('Protected model roundtrip failed');
      return encrypted;
    };
    else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      // Keep normals and packed data maps at higher quality than diffuse images.
      const quality = /_(nor|arm|rough|ao)/.test(file) ? 96 : 92;
      transform = b => webp(b, quality);
      // MIME sniffing detects the retained original when WebP would be larger.
      outputExt = ext;
    } else if (ext === '.ogg') transform = async () => {
      const destination = path.join(cache, `audio.${process.pid}.tmp.ogg`);
      execFileSync(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(root, file), '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', destination]);
      const output = fs.readFileSync(destination);
      fs.unlinkSync(destination);
      return output.length < bytes.length ? output : bytes;
    };
    manifest[`/${relative}`] = await store(relative, bytes, transform, outputExt);
  }
  const treeSource = fs.readFileSync(path.join(root, 'node_modules/@dgreenheck/ez-tree/build/ez-tree.es.js'), 'utf8');
  for (const [index, match] of [...treeSource.matchAll(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g)].entries()) {
    const original = Buffer.from(match[0].split(',')[1], 'base64');
    const url = await store(`ez-tree/image-${index}.webp`, original, b => webp(b, 92), '.webp');
    treeImages.set(match[0], url);
  }
  writeAtomic(path.join(cache, 'index.json'), JSON.stringify(next, null, 2));
  writeAtomic(path.join(cache, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`资源：${(report.reduce((n, r) => n + r.original, 0) / 1e6).toFixed(1)} → ${(report.reduce((n, r) => n + r.optimized, 0) / 1e6).toFixed(1)} MB（原始文件保留）`);
  return { manifest, report, treeImages };
}

/** Hashed files are emitted by Vite, outside public/, so candidates never enter this pipeline. */
export function optimizedAssetsPlugin(assets) {
  return {
    name: 'optimized-assets',
    resolveId(id) { if (id === 'virtual:asset-manifest') return '\0virtual:asset-manifest'; },
    load(id) { if (id === '\0virtual:asset-manifest') return `export default ${JSON.stringify(assets.manifest)}`; },
    transform(code, id) {
      if (!id.includes('/@dgreenheck/ez-tree/')) return;
      for (const [uri, url] of assets.treeImages) code = code.replaceAll(uri, url);
      if (assets.treeImages.size) {
        // The pinned library eagerly loads every species at module import. Memoized
        // getters keep the same Texture instances, fetching only the species used.
        let count = 0;
        code = code.replace(/^(\s*)(ao|color|normal|roughness|ash|aspen|oak|pine): j\(([^)]*)\)(,?)$/gm,
          (_, indent, name, args, comma) => {
            count++;
            return `${indent}get ${name}() { const value = j(${args}); Object.defineProperty(this, '${name}', { value }); return value; }${comma}`;
          });
        if (count !== 20) throw new Error('ez-tree texture layout changed; review lazy texture transform before upgrading');
      }
      return { code, map: null };
    },
    configureServer(server) {
      server.middlewares.use('/optimized/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '');
        if (name !== path.basename(name) || !Object.values(assets.manifest).includes(`/optimized/${name}`) && ![...assets.treeImages.values()].includes(`/optimized/${name}`)) return next();
        const filename = path.join(files, name);
        if (!fs.existsSync(filename)) return next();
        res.setHeader('Content-Length', fs.statSync(filename).size);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(filename).pipe(res);
      });
    },
    generateBundle() {
      const names = new Set([...Object.values(assets.manifest), ...assets.treeImages.values()]);
      for (const url of names) this.emitFile({ type: 'asset', fileName: url.slice(1), source: fs.readFileSync(path.join(files, path.basename(url))) });
    },
  };
}
