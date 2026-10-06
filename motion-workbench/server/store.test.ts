import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { Store, checkDraft, checkEdits } from './store.ts';
import { defaultEdits } from '../shared.ts';
import { trimClip } from '../src/editClip.ts';
import { bakeClip } from '../src/bakeClip.ts';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const draft = { name: '挥手', prompt: '站在原地挥手', duration: 5, rewrite: true, ready: false };
test('iterations retain immutable source and previous edits through restart and trash/restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-test-'));
  try {
    const store = new Store(dir); const motion = store.create(draft);
    const original = store.addVersion(motion.id, 'imported'); original.asset = `${original.id}.fbx`;
    fs.writeFileSync(store.assetPath(original.asset), 'test source'); store.save();
    store.mature(motion.id, original.id, true);
    assert.equal(motion.readyVersionId, original.id);
    const edits = { ...defaultEdits(), start: 1, end: 4, speed: .5, offsets: { L_Shoulder: [0, 0, 12] as [number, number, number] } };
    const revised = store.revise(motion.id, original.id, { edits, label: '更自然的挥手', notes: '去掉开头一步' });
    assert.equal(motion.ready, false); assert.equal(motion.readyVersionId, undefined);
    assert.equal(revised.asset, original.asset); assert.equal(revised.parentId, original.id);
    assert.equal(original.edits.start, 0); assert.equal(revised.edits.start, 1);
    edits.offsets.L_Shoulder[2] = 20; assert.equal(revised.edits.offsets.L_Shoulder[2], 12);
    store.trash(motion.id); assert.throws(() => store.motion(motion.id));
    const reopened = new Store(dir); reopened.restore(motion.id);
    assert.equal(reopened.motion(motion.id).versions.length, 2);
    assert.equal(fs.readFileSync(reopened.assetPath(original.asset), 'utf8'), 'test source');
    const generating = reopened.addVersion(motion.id, 'generated');
    assert.throws(() => reopened.trash(motion.id), /等待任务/);
    generating.status = 'DONE'; reopened.save(); reopened.trash(motion.id);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('invalid prompts, non-finite edits, root escape and malformed offsets are rejected', () => {
  assert.throws(() => checkDraft({ ...draft, prompt: '🙂'.repeat(129) }));
  assert.equal(checkDraft({ ...draft, prompt: '🙂'.repeat(128) }).prompt.length, 256);
  assert.throws(() => checkDraft({ ...draft, duration: 13 }));
  assert.throws(() => checkEdits({ ...defaultEdits(), start: NaN }));
  assert.throws(() => checkEdits({ ...defaultEdits(), start: 3, end: 2 }));
  assert.throws(() => checkEdits({ ...defaultEdits(), offsets: { L_Shoulder: [0, 0, 999] } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-test-'));
  try { assert.throws(() => new Store(dir).assetPath('../../.env.local')); }
  finally { fs.rmSync(dir, { recursive: true }); }
});
test('trim includes interpolated boundary poses and speed is baked into duration', () => {
  const source = new THREE.AnimationClip('source', 4, [new THREE.VectorKeyframeTrack('Pelvis.position', [0, 2, 4], [0, 0, 0, 2, 4, 6, 4, 8, 12])]);
  const trimmed = trimClip(source, { ...defaultEdits(), start: 1, end: 3, speed: 2 });
  assert.equal(trimmed.duration, 1);
  assert.deepEqual(Array.from(trimmed.tracks[0].times), [0, .5, 1]);
  assert.deepEqual(Array.from(trimmed.tracks[0].values), [1, 2, 3, 2, 4, 6, 3, 6, 9]);
  assert.equal(source.duration, 4); assert.equal(source.tracks[0].times[0], 0);
});
test('FBX fixture exports a reloadable GLB containing exact edited boundary poses and root correction', async () => {
  const bytes = fs.readFileSync(new URL('../fixtures/smoke.fbx', import.meta.url));
  const source = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const root = new THREE.Group(); source.scale.setScalar(.01); root.add(source);
  assert.equal(source.animations[0].duration, 4);
  const clip = trimClip(source.animations[0], { ...defaultEdits(), start: 1, end: 3, speed: .5 });
  const arm = source.getObjectByName('R_Elbow')!;
  const interpolant = (clip.tracks[0] as THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant }).createInterpolant();
  const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, .2, 0));
  const baked = bakeClip(root, source, clip.duration, t => {
    arm.quaternion.fromArray(interpolant.evaluate(t)).multiply(offset);
    root.position.set(-t * .1, .05, 0);
  });
  const actual = baked.tracks.find(t => t.name === `${arm.uuid}.quaternion`)!;
  const expected = new THREE.Quaternion().fromArray(interpolant.evaluate(0)).multiply(offset);
  assert.ok(new THREE.Quaternion().fromArray(actual.values).normalize().angleTo(expected.clone().normalize()) < 1e-6);
  assert.equal(baked.duration, 4);
  const oldReader = globalThis.FileReader;
  class Reader {
    result: ArrayBuffer | null = null;
    onloadend?: () => void;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(data => { this.result = data; this.onloadend?.(); }); }
  }
  globalThis.FileReader = Reader as unknown as typeof FileReader;
  try {
    const result = await new GLTFExporter().parseAsync(root, { binary: true, animations: [baked] }) as ArrayBuffer;
    assert.equal(new DataView(result).getUint32(0, true), 0x46546c67);
    const reloaded = await new GLTFLoader().parseAsync(result, '');
    assert.equal(reloaded.animations.length, 1); assert.equal(reloaded.animations[0].duration, 4);
    assert.equal(reloaded.animations[0].tracks.length, 45);
    assert.ok(reloaded.scene.getObjectByName('R_Elbow'));
    const translation = baked.tracks.at(-1)!;
    assert.ok(Math.abs(translation.values.at(-3)! + .4) < 1e-6);
  } finally { globalThis.FileReader = oldReader; }
});
