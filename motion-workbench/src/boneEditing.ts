import * as THREE from 'three';
import { BONE_NAMES } from './editClip.ts';
import type { Edits } from '../shared';

export const BONE_GROUPS: Record<string, Record<string, string>> = {
  身体: { Pelvis: '骨盆', Spine1: '腰部', Spine2: '背部', Spine3: '胸部', Neck: '颈部', Head: '头部', L_Collar: '左肩', R_Collar: '右肩', L_Shoulder: '左上臂', R_Shoulder: '右上臂', L_Elbow: '左前臂', R_Elbow: '右前臂', L_Wrist: '左手腕', R_Wrist: '右手腕', L_Hip: '左大腿', R_Hip: '右大腿', L_Knee: '左小腿', R_Knee: '右小腿', L_Ankle: '左脚踝', R_Ankle: '右脚踝', L_Foot: '左脚尖', R_Foot: '右脚尖' },
};
for (const [side, label] of [['L', '左手'], ['R', '右手']]) {
  const group: Record<string, string> = {};
  for (const [finger, name] of [['Thumb', '拇指'], ['Index', '食指'], ['Middle', '中指'], ['Ring', '无名指'], ['Pinky', '小指']]) {
    for (let i = 1; i <= 3; i++) group[`${side}_${finger}${i}`] = `${label}${name} · 第 ${i} 节`;
  }
  BONE_GROUPS[label] = group;
}
export const BONE_LABELS = Object.assign({}, ...Object.values(BONE_GROUPS)) as Record<string, string>;
export function offsetQuaternion(angles: number[]) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ'));
}
export function rotationOffset(base: THREE.Quaternion, changed: THREE.Quaternion): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(base.clone().invert().multiply(changed), 'XYZ');
  return [e.x, e.y, e.z].map(v => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10) as [number, number, number];
}
export function applyBoneEdits(edits: Edits, resolve: (name: string) => THREE.Object3D | null | undefined, positionScale: number) {
  for (const [bone, angles] of Object.entries(edits.offsets)) resolve(bone)?.quaternion.multiply(offsetQuaternion(angles));
  for (const [bone, offset] of Object.entries(edits.positions ?? {})) resolve(bone)?.position.add(new THREE.Vector3(...offset).multiplyScalar(positionScale));
}
export function avatarBoneName(name: string) { return BONE_NAMES[name] ?? name; }

/** A camera-facing drag plane keeps grab offset and parent transform fixed for the whole gesture. */
export function beginPositionDrag(node: THREE.Object3D, ray: THREE.Ray, cameraDirection: THREE.Vector3, offset: number[], positionScale: number) {
  node.updateWorldMatrix(true, false);
  const world = node.getWorldPosition(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDirection, world);
  const first = ray.intersectPlane(plane, new THREE.Vector3());
  if (!first) return null;
  const grab = world.clone().sub(first);
  const parentInverse = node.parent?.matrixWorld.clone().invert() ?? new THREE.Matrix4();
  const base = node.position.clone().sub(new THREE.Vector3(...offset).multiplyScalar(positionScale));
  return (nextRay: THREE.Ray): [number, number, number] | null => {
    const point = nextRay.intersectPlane(plane, new THREE.Vector3());
    if (!point) return null;
    return point.add(grab).applyMatrix4(parentInverse).sub(base).divideScalar(positionScale).toArray().map(v => Math.max(-2, Math.min(2, Math.round(v * 10000) / 10000))) as [number, number, number];
  };
}

/** three-vrm forwards normalized rotations and hip translation, but not other joint translations. */
export function applyAvatarPositions(avatar: import('@pixiv/three-vrm').VRM, edits: Edits) {
  for (const [name, offset] of Object.entries(edits.positions ?? {})) {
    const bone = avatarBoneName(name) as import('@pixiv/three-vrm').VRMHumanBoneName;
    if (bone === 'hips') continue; // Humanoid.update already transfers this translation.
    const normalized = avatar.humanoid.getNormalizedBoneNode(bone);
    const raw = avatar.humanoid.getRawBoneNode(bone);
    if (!normalized?.parent || !raw?.parent) continue;
    normalized.parent.updateWorldMatrix(true, false); raw.parent.updateWorldMatrix(true, false);
    const matrix = raw.parent.matrixWorld.clone().invert().multiply(normalized.parent.matrixWorld);
    const delta = new THREE.Vector3(...offset).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix));
    raw.position.add(delta);
  }
}
