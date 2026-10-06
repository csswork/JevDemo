import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { trimClip } from './editClip.ts';
import { applyBoneEdits } from './boneEditing.ts';
import { bakeClip } from './bakeClip.ts';
import type { Edits } from '../shared.ts';

/** Export an isolated source rig, independent of the selected preview avatar and camera. */
export async function exportMotion(snapshot: THREE.Group, input: Edits): Promise<ArrayBuffer> {
  const edits = structuredClone(input);
  const source = clone(snapshot) as THREE.Group;
  if (!snapshot.animations[0]) throw new Error('动作中没有可导出的轨道');
  const clip = trimClip(snapshot.animations[0], edits);
  const root = new THREE.Group(); root.name = 'Motion'; source.scale.multiplyScalar(.01); root.add(source);
  const rest: Array<{ node: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion }> = [];
  source.traverse(node => rest.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone() }));
  const bindings = clip.tracks.map(track => ({
    binding: new THREE.PropertyBinding(source, track.name) as THREE.PropertyBinding & { setValue(values: ArrayLike<number>, offset: number): void },
    interpolant: (track as THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant }).createInterpolant(),
  }));
  const pelvis = source.getObjectByName('Pelvis');
  const feet = ['L_Foot', 'R_Foot', 'L_Ankle', 'R_Ankle'].flatMap(name => { const node = source.getObjectByName(name); return node ? [node] : []; });
  const initialRoot = new THREE.Vector3(); let ground = 0;
  const pose = (t: number, correct: boolean) => {
    for (const r of rest) { r.node.position.copy(r.position); r.node.quaternion.copy(r.quaternion); }
    root.position.set(0, 0, 0);
    for (const { binding, interpolant } of bindings) binding.setValue(interpolant.evaluate(t), 0);
    applyBoneEdits(edits, name => source.getObjectByName(name), 100);
    root.updateMatrixWorld(true);
    if (correct) {
      if (edits.inPlace && pelvis) { const pos = pelvis.getWorldPosition(new THREE.Vector3()); root.position.x = initialRoot.x - pos.x; root.position.z = initialRoot.z - pos.z; }
      if (edits.ground) root.position.y = -ground;
      root.updateMatrixWorld(true);
    }
  };
  try {
    pose(0, false); initialRoot.copy(pelvis?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3());
    if (feet.length) {
      let min = Infinity;
      for (let i = 0; i <= 60; i++) { pose(clip.duration * i / 60, false); min = Math.min(min, ...feet.map(n => n.getWorldPosition(new THREE.Vector3()).y)); }
      ground = Number.isFinite(min) ? min : 0;
    }
    const baked = bakeClip(root, source, clip.duration, t => pose(t, true));
    pose(0, true);
    return await new GLTFExporter().parseAsync(root, { binary: true, animations: [baked], onlyVisible: false }) as ArrayBuffer;
  } finally { for (const { binding } of bindings) binding.unbind(); }
}
