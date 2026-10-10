import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { decryptModel } from '../src/vrm/protect.ts';

const root = path.resolve(import.meta.dirname, '..');
const rows = JSON.parse(fs.readFileSync(path.join(root, '.asset-cache/report.json')));
await MeshoptDecoder.ready;
function glb(bytes) {
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const length = bytes.readUInt32LE(12);
  return { json: JSON.parse(bytes.subarray(20, length + 20).toString()), bin: bytes.subarray(length + 28) };
}
function view(doc, index) {
  const v = doc.json.bufferViews[index];
  const e = v.extensions?.EXT_meshopt_compression;
  if (!e) return doc.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  const decoded = new Uint8Array(v.byteLength);
  MeshoptDecoder.decodeGltfBuffer(decoded, e.count, e.byteStride, doc.bin.subarray(e.byteOffset, e.byteOffset + e.byteLength), e.mode, e.filter);
  return Buffer.from(decoded);
}
let models = 0, geometries = 0, images = 0;
const imageMetrics = [];
for (const row of rows) {
  if (!/\.(vrm|vrmx|glb)$/.test(row.source)) continue;
  const load = async filename => {
    const b = fs.readFileSync(filename);
    return glb(filename.endsWith('.vrmx') ? Buffer.from(await decryptModel(new Uint8Array(b).buffer)) : b);
  };
  const original = await load(path.join(root, 'public', row.source));
  const optimized = await load(path.join(root, '.asset-cache/files', row.file));
  // JSON serialization canonicalizes -0 as 0; they have the same glTF meaning.
  const canonical = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
  for (const key of ['nodes', 'skins', 'meshes', 'accessors', 'materials', 'extensions', 'animations', 'scenes', 'scene']) {
    assert.deepEqual(optimized.json[key], canonical(original.json[key]), `${row.source}: ${key}`);
  }
  assert.equal(optimized.json.bufferViews.length, original.json.bufferViews.length);
  const imageViews = new Set((original.json.images ?? []).map(i => i.bufferView));
  for (let i = 0; i < original.json.bufferViews.length; i++) {
    if (imageViews.has(i)) continue;
    assert.deepEqual(view(optimized, i), view(original, i), `${row.source}: geometry/animation buffer ${i}`);
    geometries++;
  }
  for (const image of original.json.images ?? []) {
    if (image.bufferView === undefined) continue;
    const a = await sharp(view(original, image.bufferView)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(view(optimized, image.bufferView)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(a.info.width, b.info.width); assert.equal(a.info.height, b.info.height);
    let error = 0, count = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i + 3] !== b.data[i + 3]) assert.fail(`${row.source}: alpha at ${i / 4}`);
      // Transparent texels can store arbitrary RGB. Measure their rendered
      // contribution after compositing, while requiring alpha to match exactly.
      if (a.data[i + 3]) for (let c = 0; c < 3; c++) {
        error += ((a.data[i + c] - b.data[i + c]) * a.data[i + 3] / 255) ** 2;
        count++;
      }
    }
    const rmse = Math.sqrt(error / Math.max(1, count));
    imageMetrics.push({ source: row.source, image: image.bufferView, rmse });
    assert.ok(rmse < 12, `${row.source}: image deviation ${rmse.toFixed(2)} exceeds review threshold`);
    images++;
  }
  if (/\.vrmx?$/.test(row.source)) models++;
}
fs.writeFileSync(path.join(root, '.asset-cache/validation.json'), JSON.stringify({ models, geometries, images, imageMetrics }, null, 2));
console.log(`PASS: ${models} models; ${geometries} non-image buffers restored exactly; ${images} images preserve dimensions and alpha`);
