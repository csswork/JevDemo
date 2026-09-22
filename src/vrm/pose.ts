import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * 分层姿态累加器。
 *
 * 每帧流程固定为：humanoid.resetNormalizedPose() → 各层往这里 add 偏移 → flush()。
 * 各层之间因此完全解耦：idle 不需要知道手势在做什么，手势也不需要知道 posture 是什么。
 * 这是"轨道分层"在渲染侧的落地，也是避免动作互相打架的关键。
 */
export class PoseAccumulator {
  private euler = new Map<VRMHumanBoneName, THREE.Vector3>();
  private hipsOffset = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _e = new THREE.Euler();

  reset() {
    for (const v of this.euler.values()) v.set(0, 0, 0);
    this.hipsOffset.set(0, 0, 0);
  }

  /** 累加一条骨骼的欧拉偏移（弧度，XYZ 序），weight 用于 clip 淡入淡出。 */
  add(bone: VRMHumanBoneName, x: number, y: number, z: number, weight = 1) {
    if (weight === 0) return;
    let v = this.euler.get(bone);
    if (!v) {
      v = new THREE.Vector3();
      this.euler.set(bone, v);
    }
    v.x += x * weight;
    v.y += y * weight;
    v.z += z * weight;
  }

  /** 整体位移（呼吸起伏、重心偏移），作用在 hips 上。 */
  translateHips(x: number, y: number, z: number, weight = 1) {
    this.hipsOffset.x += x * weight;
    this.hipsOffset.y += y * weight;
    this.hipsOffset.z += z * weight;
  }

  flush(vrm: VRM) {
    for (const [bone, e] of this.euler) {
      if (e.x === 0 && e.y === 0 && e.z === 0) continue;
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      this._e.set(e.x, e.y, e.z, 'XYZ');
      this._q.setFromEuler(this._e);
      node.quaternion.multiply(this._q);
    }
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips && (this.hipsOffset.x || this.hipsOffset.y || this.hipsOffset.z)) {
      hips.position.add(this.hipsOffset);
    }
  }
}

export const deg = (d: number) => (d * Math.PI) / 180;

/** smoothstep 缓动，用于 clip 的进出淡化。 */
export function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** 指数趋近，帧率无关。用于所有"平滑跟随"的场景（视线、表情权重）。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
