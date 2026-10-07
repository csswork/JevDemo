import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AvatarEditSpace, beginPositionDrag, applyBoneEdits, offsetQuaternion, rotationOffset } from '../src/boneEditing.ts';
import { DRAG_RULES, setWorldQuaternion, solveCcd, solveTwoBone } from '../src/ikDrag.ts';
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

test('direct joint dragging follows the screen plane without a jump, preserving offsets under parent rotation and scale', () => {
  const parent = new THREE.Group(); parent.rotation.z = Math.PI / 2; parent.scale.setScalar(.01);
  const node = new THREE.Bone(); node.position.set(3, 4, 5); parent.add(node); parent.updateMatrixWorld(true);
  const world = node.getWorldPosition(new THREE.Vector3());
  const ray = new THREE.Ray(world.clone().add(new THREE.Vector3(.005, 0, 1)), new THREE.Vector3(0, 0, -1));
  const drag = beginPositionDrag(node, ray, new THREE.Vector3(0, 0, -1), [.01, .02, 0], 100)!;
  assert.deepEqual(drag(ray), [.01, .02, 0]);
  const movedRay = new THREE.Ray(ray.origin.clone().add(new THREE.Vector3(0, .1, 0)), ray.direction);
  assert.deepEqual(drag(movedRay), [.11, .02, 0]);
  assert.deepEqual(node.position.toArray(), [3, 4, 5]);
  assert.equal(drag(new THREE.Ray(ray.origin, new THREE.Vector3(1, 0, 0))), null);
});

const chainOf = (lengths: number[], bend = 0) => {
  const root = new THREE.Bone(); let parent = root; const nodes = [root];
  for (const length of lengths) { const b = new THREE.Bone(); b.position.set(length, 0, 0); parent.rotation.z = bend; parent.add(b); nodes.push(b); parent = b; }
  root.updateMatrixWorld(true); return nodes;
};
const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

test('limb drag bends the elbow toward its existing side, keeps bone lengths and the hand orientation', () => {
  const [shoulder, elbow, wrist] = chainOf([.3, .25], .2); // bent toward +Y
  const keep = wrist.getWorldQuaternion(new THREE.Quaternion());
  const target = new THREE.Vector3(.35, -.1, .1);
  solveTwoBone(shoulder, elbow, wrist, target, new THREE.Vector3(0, 0, -1));
  setWorldQuaternion(wrist, keep);
  assert.ok(at(wrist).distanceTo(target) < 1e-6);
  assert.ok(Math.abs(at(elbow).distanceTo(at(shoulder)) - .3) < 1e-6 && Math.abs(at(wrist).distanceTo(at(elbow)) - .25) < 1e-6);
  const dir = target.clone().normalize(); const side = at(elbow).sub(dir.clone().multiplyScalar(at(elbow).dot(dir)));
  assert.ok(side.y > 0, 'elbow stays on the side it was bent toward');
  assert.ok(wrist.getWorldQuaternion(new THREE.Quaternion()).angleTo(keep) < 1e-6);
  solveTwoBone(shoulder, elbow, wrist, new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, 0, -1));
  assert.ok(Math.abs(at(wrist).x - .55) < 1e-4, 'unreachable targets straighten the limb instead of stretching it');
});

test('chain drag reaches the target without stretching, and every joint has a drag rule', () => {
  const [a, b, c, end] = chainOf([.1, .1, .1]);
  const target = new THREE.Vector3(.18, .2, 0);
  solveCcd([c, b, a], end, target, 200);
  assert.ok(at(end).distanceTo(target) < 1e-3);
  for (const [x, y] of [[a, b], [b, c], [c, end]]) assert.ok(Math.abs(at(x).distanceTo(at(y)) - .1) < 1e-6);
  for (const id of Object.keys(BONE_NAMES)) assert.ok(DRAG_RULES[id], id);
});

test('edits stay in source FBX axes: the VRM preview offset equals what export bakes after retargeting', () => {
  for (const vrm0 of [false, true]) {
    const fbx = new THREE.Group(); const parent = new THREE.Bone(); parent.name = 'L_Shoulder'; parent.quaternion.copy(offsetQuaternion([10, 40, -70]));
    const bone = new THREE.Bone(); bone.name = 'L_Elbow'; bone.position.set(30, 0, 0); bone.quaternion.copy(offsetQuaternion([-25, 15, 60]));
    fbx.add(parent); parent.add(bone); fbx.updateMatrixWorld(true);
    const R = bone.getWorldQuaternion(new THREE.Quaternion()); const P = parent.getWorldQuaternion(new THREE.Quaternion());
    const F = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), vrm0 ? Math.PI : 0);
    const retarget = (q: THREE.Quaternion) => F.clone().multiply(P).multiply(q).multiply(R.clone().invert()).multiply(F.clone().invert());
    const space = new AvatarEditSpace(fbx, vrm0, .01);
    const animated = offsetQuaternion([5, -12, 33]); const offset = [20, -35, 50];
    const exported = retarget(animated.clone().multiply(offsetQuaternion(offset)));
    const previewed = retarget(animated).multiply(space.rotationToAvatar('L_Elbow', offset));
    assert.ok(exported.angleTo(previewed) < 1e-6);
    assert.deepEqual(space.rotationFromAvatar('L_Elbow', space.rotationToAvatar('L_Elbow', offset)), offset);
    assert.deepEqual(space.positionFromAvatar('L_Elbow', space.positionToAvatar('L_Elbow', [.01, -.02, .03])), [.01, -.02, .03]);
  }
});
