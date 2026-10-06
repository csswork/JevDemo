import * as THREE from 'three';
import type { Edits } from '../shared';

export function bounds(duration: number, edits: Edits) {
  const start = THREE.MathUtils.clamp(edits.start, 0, Math.max(0, duration - .01));
  const end = THREE.MathUtils.clamp(edits.end || duration, start + .01, duration);
  return { start, end, length: (end - start) / edits.speed };
}
/** Bake trim and speed into tracks, retaining exact boundary poses. Root correction and offsets follow on the pose. */
export function trimClip(clip: THREE.AnimationClip, edits: Edits) {
  const { start, end, length } = bounds(clip.duration, edits);
  const tracks = clip.tracks.map(track => {
    const times = [start, ...Array.from(track.times).filter(t => t > start && t < end), end];
    const interpolant = (track as THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant }).createInterpolant();
    const values = times.flatMap(t => Array.from(interpolant.evaluate(t)));
    const result = track.clone();
    result.times = new Float32Array(times.map(t => (t - start) / edits.speed));
    result.values = new Float32Array(values);
    return result;
  });
  return new THREE.AnimationClip('motion', length, tracks);
}
export const BONE_NAMES: Record<string, string> = {
  Pelvis: 'hips', Spine1: 'spine', Spine2: 'chest', Spine3: 'upperChest', Neck: 'neck', Head: 'head',
  L_Collar: 'leftShoulder', R_Collar: 'rightShoulder', L_Shoulder: 'leftUpperArm', R_Shoulder: 'rightUpperArm',
  L_Elbow: 'leftLowerArm', R_Elbow: 'rightLowerArm', L_Wrist: 'leftHand', R_Wrist: 'rightHand',
  L_Hip: 'leftUpperLeg', R_Hip: 'rightUpperLeg', L_Knee: 'leftLowerLeg', R_Knee: 'rightLowerLeg',
  L_Ankle: 'leftFoot', R_Ankle: 'rightFoot', L_Foot: 'leftToes', R_Foot: 'rightToes',
};
