import * as THREE from 'three';

/** Export exactly the evaluated preview poses, including the wrapper's root corrections. */
export function bakeClip(root: THREE.Object3D, source: THREE.Object3D, duration: number, pose: (time: number) => void) {
  const nodes: THREE.Object3D[] = [];
  source.traverse(node => { if ((node as THREE.Bone).isBone) nodes.push(node); });
  if (!nodes.length) throw new Error('FBX 中没有可导出的骨骼');
  const times: number[] = [];
  const positions = nodes.map(() => [] as number[]);
  const rotations = nodes.map(() => [] as number[]);
  const rootPositions: number[] = [];
  const count = Math.max(1, Math.ceil(duration * 30));
  for (let i = 0; i <= count; i++) {
    const t = i / count * duration; times.push(t); pose(t);
    nodes.forEach((n, j) => { positions[j].push(...n.position.toArray()); rotations[j].push(...n.quaternion.toArray()); });
    rootPositions.push(...root.position.toArray());
  }
  const tracks = nodes.flatMap((n, i) => [
    new THREE.VectorKeyframeTrack(`${n.uuid}.position`, times, positions[i]),
    new THREE.QuaternionKeyframeTrack(`${n.uuid}.quaternion`, times, rotations[i]),
  ]);
  tracks.push(new THREE.VectorKeyframeTrack(`${root.uuid}.position`, times, rootPositions));
  return new THREE.AnimationClip('motion', duration, tracks);
}
