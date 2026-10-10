import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { MeshoptDecoder } from 'meshoptimizer/decoder';

export function readGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length');
  const length = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  const offset = 20 + length;
  assert.equal(bytes.readUInt32LE(offset + 4), 0x004e4942);
  assert.equal(offset + 8 + bytes.readUInt32LE(offset), bytes.length, 'Only JSON/BIN chunks supported');
  assert.equal(json.buffers.length, 1, 'Only self-contained GLB supported');
  assert.ok(!json.buffers[0].uri);
  return { json, bin: bytes.subarray(offset + 8) };
}

export function writeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const j = Buffer.alloc((text.length + 3) & ~3, 0x20);
  text.copy(j);
  const b = Buffer.alloc((bin.length + 3) & ~3);
  bin.copy(b);
  const out = Buffer.alloc(28 + j.length + b.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(j.length, 12); out.writeUInt32LE(0x4e4f534a, 16); j.copy(out, 20);
  out.writeUInt32LE(b.length, 20 + j.length); out.writeUInt32LE(0x004e4942, 24 + j.length); b.copy(out, 28 + j.length);
  return out;
}

export async function webp(bytes, quality = 92) {
  const out = await sharp(bytes).webp({ quality, alphaQuality: 100, effort: 6 }).toBuffer();
  return out.length < bytes.length * 0.95 ? out : bytes;
}

/** Rewrite buffer storage only. Nodes, skins, morphs, materials and unknown extensions stay intact. */
export async function optimizeGlb(bytes, { geometry = false } = {}) {
  const { json, bin } = readGlb(bytes);
  const before = structuredClone(json);
  const imageViews = new Map((json.images ?? []).filter(i => i.bufferView !== undefined).map(i => [i.bufferView, i]));
  const parts = [];
  let offset = 0;
  let fallbackLength = 0;
  let compressed = false;
  const add = (data) => {
    const start = offset;
    parts.push(data);
    const padding = (4 - data.length % 4) % 4;
    if (padding) parts.push(Buffer.alloc(padding));
    offset += data.length + padding;
    return start;
  };
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  for (const [index, view] of (json.bufferViews ?? []).entries()) {
    assert.equal(view.buffer, 0);
    const original = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    let data = original;
    const image = imageViews.get(index);
    if (image && ['image/png', 'image/jpeg'].includes(image.mimeType)) {
      data = await webp(original);
      if (data !== original) image.mimeType = 'image/webp';
    }
    // Preserve index order exactly: INDICES, rather than TRIANGLES (which may rotate triangles).
    const accessors = (json.accessors ?? []).filter(a => a.bufferView === index);
    const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
    const components = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const a = accessors[0];
    const stride = view.byteStride ?? (a ? sizes[a.type] * components[a.componentType] : 0);
    const mode = view.target === 34963 ? 'INDICES' : 'ATTRIBUTES';
    const eligible = geometry && !image && a && !a.sparse && !a.byteOffset &&
      stride > 0 && data.length % stride === 0 &&
      (mode === 'INDICES' ? [2, 4].includes(stride) : stride % 4 === 0 && stride <= 256);
    if (eligible) {
      const count = data.length / stride;
      const encoded = Buffer.from(MeshoptEncoder.encodeGltfBuffer(data, count, stride, mode));
      if (encoded.length + 160 < data.length) {
        const decoded = new Uint8Array(data.length);
        MeshoptDecoder.decodeGltfBuffer(decoded, count, stride, encoded, mode);
        assert.deepEqual(Buffer.from(decoded), original, 'Meshopt must restore every original byte');
        view.buffer = 1;
        view.byteOffset = fallbackLength;
        fallbackLength += (view.byteLength + 3) & ~3;
        view.extensions = { ...view.extensions, EXT_meshopt_compression: {
          buffer: 0, byteOffset: add(encoded), byteLength: encoded.length, byteStride: stride, count, mode,
        } };
        compressed = true;
        continue;
      }
    }
    view.byteOffset = add(data);
    view.byteLength = data.length;
    if (!image) assert.deepEqual(data, original, 'Non-image data must be unchanged');
  }
  for (const texture of json.textures ?? []) {
    if (json.images[texture.source]?.mimeType === 'image/webp') {
      texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: texture.source } };
      delete texture.source;
    }
  }
  const extensions = [
    ...(compressed ? ['EXT_meshopt_compression'] : []),
    ...((json.images ?? []).some(i => i.mimeType === 'image/webp') ? ['EXT_texture_webp'] : []),
  ];
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (extensions.length) json[key] = [...new Set([...(json[key] ?? []), ...extensions])];
  }
  json.buffers[0].byteLength = offset;
  if (compressed) json.buffers.push({ byteLength: fallbackLength, extensions: { EXT_meshopt_compression: { fallback: true } } });
  // Check all semantic JSON, including proprietary VRM metadata, with only storage edits removed.
  const semantic = doc => {
    const copy = structuredClone(doc);
    for (const key of ['buffers', 'bufferViews', 'images', 'textures', 'extensionsUsed', 'extensionsRequired']) delete copy[key];
    return copy;
  };
  assert.deepEqual(semantic(json), semantic(before), 'GLB semantic metadata must be preserved');
  return writeGlb(json, Buffer.concat(parts));
}
