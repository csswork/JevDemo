import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { exportMotion } from '../src/exportMotion.ts';
import { defaultEdits } from '../shared.ts';

test('export current unsaved edits from an isolated rig with fingers, translation and trim; retain source', async () => {
  const bytes = fs.readFileSync(new URL('../fixtures/smoke.fbx', import.meta.url));
  const source = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const finger = new THREE.Bone(); finger.name = 'R_Index2'; finger.position.set(3, 0, 0); source.getObjectByName('R_Wrist')!.add(finger);
  const before = finger.position.clone(); const sourceScale = source.scale.clone();
  const edits = { ...defaultEdits(), start: 1, end: 3, speed: 2, offsets: { R_Index2: [0, 30, 0] as [number, number, number] }, positions: { R_Index2: [.01, -.02, .03] as [number, number, number] } };
  const oldReader = globalThis.FileReader;
  class Reader {
    result: ArrayBuffer | null = null; onloadend?: () => void;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(data => { this.result = data; this.onloadend?.(); }); }
  }
  globalThis.FileReader = Reader as unknown as typeof FileReader;
  try {
    const result = await exportMotion(source, edits);
    const model = await new GLTFLoader().parseAsync(result, '');
    const clip = model.animations[0]; assert.equal(clip.duration, 1);
    const position = clip.tracks.find(t => t.name === 'R_Index2.position')!;
    assert.deepEqual(Array.from(position.values).slice(0, 3), [4, -2, 3]);
    const rotation = clip.tracks.find(t => t.name === 'R_Index2.quaternion')!;
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 6, 0));
    assert.ok(expected.angleTo(new THREE.Quaternion().fromArray(rotation.values).normalize()) < 1e-6);
    assert.ok(source.scale.equals(sourceScale)); assert.ok(finger.position.equals(before)); assert.ok(finger.quaternion.equals(new THREE.Quaternion()));
    assert.equal(source.animations[0].duration, 4); assert.deepEqual(edits.positions.R_Index2, [.01, -.02, .03]);
    assert.equal(model.scene.getObjectByName('Motion')!.children.length, 1);
  } finally { globalThis.FileReader = oldReader; }
});
