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
export function quaternionAngles(q: THREE.Quaternion): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z].map(v => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10 || 0) as [number, number, number];
}
export function rotationOffset(base: THREE.Quaternion, changed: THREE.Quaternion) { return quaternionAngles(base.clone().invert().multiply(changed)); }
export const roundPosition = (v: THREE.Vector3) => v.toArray().map(x => Math.max(-2, Math.min(2, Math.round(x * 10000) / 10000)) || 0) as [number, number, number];
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
    return roundPosition(point.add(grab).applyMatrix4(parentInverse).sub(base).divideScalar(positionScale));
  };
}

/**
 * Edits are stored in the source FBX's local bone axes, which is what GLB export bakes.
 * VRM normalized bones are the FBX rest pose rotated into world space (q_vrm = P · q · R⁻¹, see retargetSmpl),
 * so a local offset O becomes R · O · R⁻¹ there, and a local translation turns by the parent's rest matrix.
 * VRM 0.x is additionally flipped 180° about Y.
 */
export class AvatarEditSpace {
  private rest = new Map<string, THREE.Quaternion>();
  private parent = new Map<string, THREE.Matrix3>();
  constructor(fbx: THREE.Object3D, vrm0: boolean, scale: number) {
    fbx.updateMatrixWorld(true);
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), vrm0 ? Math.PI : 0);
    for (const name of Object.keys(BONE_NAMES)) {
      const node = fbx.getObjectByName(name); if (!node) continue;
      this.rest.set(name, flip.clone().multiply(node.getWorldQuaternion(new THREE.Quaternion())));
      const matrix = new THREE.Matrix4().makeRotationFromQuaternion(flip).multiply(node.parent?.matrixWorld ?? new THREE.Matrix4());
      // Stored meters → FBX centimeters → avatar meters.
      this.parent.set(name, new THREE.Matrix3().setFromMatrix4(matrix).multiplyScalar(100 * scale));
    }
  }
  rotationToAvatar(bone: string, angles: number[]) {
    const r = this.rest.get(bone); const q = offsetQuaternion(angles);
    return r ? r.clone().multiply(q).multiply(r.clone().invert()) : q;
  }
  rotationFromAvatar(bone: string, q: THREE.Quaternion) {
    const r = this.rest.get(bone);
    return quaternionAngles(r ? r.clone().invert().multiply(q).multiply(r) : q);
  }
  positionToAvatar(bone: string, offset: number[]) {
    const v = new THREE.Vector3(...offset); const m = this.parent.get(bone);
    return m ? v.applyMatrix3(m) : v;
  }
  positionFromAvatar(bone: string, v: THREE.Vector3) {
    const m = this.parent.get(bone);
    return roundPosition(m ? v.clone().applyMatrix3(m.clone().invert()) : v);
  }
  /** Avatar-space edits with full precision; only for posing the preview, never saved. */
  toAvatar(edits: Edits): Edits {
    const offsets: Edits['offsets'] = {}; const positions: NonNullable<Edits['positions']> = {};
    for (const [bone, angles] of Object.entries(edits.offsets)) {
      const e = new THREE.Euler().setFromQuaternion(this.rotationToAvatar(bone, angles), 'XYZ');
      offsets[bone] = [e.x, e.y, e.z].map(THREE.MathUtils.radToDeg) as [number, number, number];
    }
    for (const [bone, offset] of Object.entries(edits.positions ?? {})) positions[bone] = this.positionToAvatar(bone, offset).toArray();
    return { ...edits, offsets, positions };
  }
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
