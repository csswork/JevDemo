import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyBoneEdits, offsetQuaternion, rotationOffset } from '../src/boneEditing.ts';
import { BONE_NAMES } from '../src/editClip.ts';
import { defaultEdits } from '../shared.ts';
import { checkEdits } from './store.ts';

test('dragged rotation preserves the animated base pose and round trips through numeric offsets', () => {
  const base = offsetQuaternion([20, -30, 15]);
  const changed = base.clone().multiply(offsetQuaternion([-42, 18, 75]));
  const values = rotationOffset(base, changed);
  const node = new THREE.Bone(); node.quaternion.copy(base);
  applyBoneEdits({ ...defaultEdits(), offsets: { R_Index2: values } }, () => node, 1);
  assert.ok(node.quaternion.angleTo(changed) < 1e-6);
  assert.deepEqual(values, [-42, 18, 75]);
});
test('finger mapping covers all 30 joints and position edits use meters across VRM and centimeter FBX', () => {
  assert.equal(Object.keys(BONE_NAMES).filter(n => /Thumb|Index|Middle|Ring|Pinky/.test(n)).length, 30);
  assert.equal(BONE_NAMES.L_Thumb1, 'leftThumbMetacarpal');
  assert.equal(BONE_NAMES.R_Pinky3, 'rightLittleDistal');
  const edits = checkEdits({ ...defaultEdits(), positions: { R_Index2: [.01, -.02, .03] } });
  const vrm = new THREE.Bone(); const fbx = new THREE.Bone();
  applyBoneEdits(edits, () => vrm, 1); applyBoneEdits(edits, () => fbx, 100);
  assert.deepEqual(vrm.position.toArray(), [.01, -.02, .03]);
  assert.deepEqual(fbx.position.toArray(), [1, -2, 3]);
  assert.throws(() => checkEdits({ ...edits, positions: { R_Index2: [NaN, 0, 0] } }));
  assert.throws(() => checkEdits({ ...edits, positions: { R_Index2: [3, 0, 0] } }));
  assert.equal(checkEdits(defaultEdits()).positions, undefined);
});
