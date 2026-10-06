import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { avatarLoader } from '../src/avatarLoader.ts';
import { VRMUtils } from '@pixiv/three-vrm';
import { retargetSmpl } from '../src/retargetSmpl.ts';

test('local VRoid female mannequin loads as humanoid and FBX motion deforms the skinned body', async () => {
  const model = fs.readFileSync(new URL('../../public/models/candidates/VRoid_V110_Female.vrm', import.meta.url));
  // This test measures skin deformation; texture decoding is verified in the browser.
  const loader = avatarLoader().register(() => ({ name: 'headless-textures', loadTexture: async () => new THREE.Texture() }));
  const gltf = await loader.parseAsync(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), '');
  const avatar = gltf.userData.vrm;
  assert.equal(avatar.meta.metaVersion, '0');
  VRMUtils.rotateVRM0(avatar);
  for (const bone of ['hips', 'head', 'leftFoot', 'rightFoot', 'rightLowerArm', 'leftHand']) assert.ok(avatar.humanoid.getNormalizedBoneNode(bone));
  avatar.scene.updateMatrixWorld(true);
  const fixture = fs.readFileSync(new URL('../fixtures/smoke.fbx', import.meta.url));
  const source = new FBXLoader().parse(fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength), '');
  const tracks = retargetSmpl(source, avatar);
  const track = tracks.rotation.get('rightLowerArm')!; assert.ok(track);
  let body: THREE.SkinnedMesh | undefined;
  avatar.scene.getObjectByName('Body')?.traverse((object: THREE.Object3D) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) body ??= object as THREE.SkinnedMesh;
  });
  const mesh = body!;
  assert.ok(mesh?.isSkinnedMesh);
  const attr = mesh.geometry.getAttribute('position');
  const before = Array.from({ length: attr.count }, (_, i) => mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(attr, i)));
  avatar.humanoid.getNormalizedBoneNode('rightLowerArm').quaternion.fromArray(track.values, 4);
  avatar.humanoid.update(); avatar.scene.updateMatrixWorld(true);
  let displacement = 0;
  for (let i = 0; i < attr.count; i++) displacement = Math.max(displacement, before[i].distanceTo(mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(attr, i))));
  assert.ok(displacement > .1, `Expected visible skinned motion, got ${displacement}m`);
});
