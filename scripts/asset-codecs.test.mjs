import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { readGlb, writeGlb, optimizeGlb } from './asset-codecs.mjs';

test('VRM image replacement preserves opaque extension references, skins and morph targets', async () => {
  const image = await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 90, g: 40, b: 180, alpha: 0.5 } } }).png().toBuffer();
  const geometry = Buffer.from(new Float32Array([0, 1, 2, 3, 4, 5]).buffer);
  const doc = {
    asset: { version: '2.0' }, buffers: [{ byteLength: geometry.length + image.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: geometry.length }, { buffer: 0, byteOffset: geometry.length, byteLength: image.length }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 2 }],
    images: [{ bufferView: 1, mimeType: 'image/png' }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    nodes: [{ name: 'hips', mesh: 0, skin: 0 }], skins: [{ joints: [0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }] }],
    extensionsUsed: ['VRM', 'UNKNOWN_custom'],
    extensions: {
      VRM: {
        humanoid: { humanBones: [{ bone: 'hips', node: 0 }] },
        materialProperties: [{ textureProperties: { _MainTex: 0 } }],
        blendShapeMaster: { blendShapeGroups: [{ binds: [{ mesh: 0, index: 0, weight: 100 }] }] },
      },
      UNKNOWN_custom: { keep: [0, { ref: 1 }] },
    },
  };
  const result = readGlb(await optimizeGlb(writeGlb(doc, Buffer.concat([geometry, image]))));
  for (const key of ['nodes', 'skins', 'meshes', 'materials', 'extensions', 'accessors']) assert.deepEqual(result.json[key], doc[key]);
  assert.ok(result.bin.subarray(0, geometry.length).equals(geometry));
  assert.equal(result.json.images[0].mimeType, 'image/webp');
  assert.equal(result.json.textures[0].extensions.EXT_texture_webp.source, 0);
  const view = result.json.bufferViews[1];
  const decoded = await sharp(result.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 128); assert.equal(decoded.info.height, 128);
  assert.ok([...decoded.data].filter((_, i) => i % 4 === 3).every(a => a === 128), 'alpha must be preserved');
});

test('meshopt restores exact attribute bytes and index order, with valid fallback layout', async () => {
  const vertices = Buffer.from(new Float32Array(1200).fill(0.25).buffer);
  const indices = Buffer.from(new Uint16Array(Array.from({ length: 600 }, (_, i) => i % 100)).buffer);
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: vertices.length + indices.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.length, target: 34962 }, { buffer: 0, byteOffset: vertices.length, byteLength: indices.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 400 }, { bufferView: 1, componentType: 5123, type: 'SCALAR', count: 600 }] };
  const result = readGlb(writeGlb(doc, Buffer.concat([vertices, indices])));
  const optimized = await optimizeGlb(writeGlb(result.json, result.bin), { geometry: true });
  const jsonLength = optimized.readUInt32LE(12);
  const json = JSON.parse(optimized.subarray(20, 20 + jsonLength).toString());
  const bin = optimized.subarray(28 + jsonLength);
  await MeshoptDecoder.ready;
  for (const [i, view] of json.bufferViews.entries()) {
    const e = view.extensions.EXT_meshopt_compression;
    const decoded = new Uint8Array(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(decoded, e.count, e.byteStride, bin.subarray(e.byteOffset, e.byteOffset + e.byteLength), e.mode);
    assert.deepEqual(Buffer.from(decoded), [vertices, indices][i]);
    assert.ok(view.byteOffset + view.byteLength <= json.buffers[1].byteLength);
  }
  assert.equal(json.buffers[1].extensions.EXT_meshopt_compression.fallback, true);
});
