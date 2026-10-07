import * as THREE from 'three';

/**
 * 拖动微调：拖一个关节点时，旋转它上游的一段骨骼链让关节跟随鼠标，骨长不变。
 * chain 由近到远；limb 用解析两骨 IK（保持肘/膝原有弯曲方向），其余用 CCD。
 * keep 表示末端保持拖动前的世界朝向（手掌、脚掌不跟着转）。
 * 'body' 表示移动骨盆，双腿 IK 让脚踝留在原地。
 */
export type DragRule = { chain: string[]; limb?: boolean; keep?: boolean } | 'body';

export const DRAG_RULES: Record<string, DragRule> = {
  Pelvis: 'body', Spine1: 'body', L_Hip: 'body', R_Hip: 'body',
  Spine2: { chain: ['Spine1'] }, Spine3: { chain: ['Spine2', 'Spine1'] },
  Neck: { chain: ['Spine3', 'Spine2', 'Spine1'] }, Head: { chain: ['Neck', 'Spine3', 'Spine2'] },
};
for (const s of ['L', 'R']) {
  Object.assign(DRAG_RULES, {
    [`${s}_Collar`]: { chain: ['Spine3'] }, [`${s}_Shoulder`]: { chain: [`${s}_Collar`] }, [`${s}_Elbow`]: { chain: [`${s}_Shoulder`] },
    [`${s}_Wrist`]: { chain: [`${s}_Elbow`, `${s}_Shoulder`], limb: true, keep: true },
    [`${s}_Knee`]: { chain: [`${s}_Hip`] }, [`${s}_Ankle`]: { chain: [`${s}_Knee`, `${s}_Hip`], limb: true, keep: true }, [`${s}_Foot`]: { chain: [`${s}_Ankle`] },
  });
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    const f = `${s}_${finger}`;
    Object.assign(DRAG_RULES, { [`${f}1`]: { chain: [`${s}_Wrist`] }, [`${f}2`]: { chain: [`${f}1`] }, [`${f}3`]: { chain: [`${f}2`, `${f}1`] } });
  }
}

const worldPos = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());

/** Rotate a node in world space about its own pivot, updating descendants. */
export function rotateWorld(node: THREE.Object3D, delta: THREE.Quaternion) {
  const parent = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  node.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent)).normalize();
  node.updateWorldMatrix(false, true);
}
export function setWorldQuaternion(node: THREE.Object3D, world: THREE.Quaternion) {
  const parent = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  node.quaternion.copy(parent.invert().multiply(world)).normalize();
  node.updateWorldMatrix(false, true);
}
/** Swing a bone so that a world point it carries moves toward a target direction, capped at maxAngle radians. */
export function aimBone(node: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, maxAngle = Math.PI) {
  const pivot = worldPos(node);
  const a = from.clone().sub(pivot); const b = to.clone().sub(pivot);
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return;
  const delta = new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
  const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
  if (angle > maxAngle) delta.slerp(new THREE.Quaternion(), 1 - maxAngle / angle);
  rotateWorld(node, delta);
}

/** Analytic two-bone IK. Keeps the current bend plane; poleHint is used only when the limb lies along the target. */
export function solveTwoBone(root: THREE.Object3D, mid: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, poleHint: THREE.Vector3) {
  const rootP = worldPos(root); const midP = worldPos(mid); const endP = worldPos(end);
  const a = midP.distanceTo(rootP); const b = endP.distanceTo(midP);
  const toTarget = target.clone().sub(rootP);
  if (a < 1e-9 || b < 1e-9 || toTarget.lengthSq() < 1e-12) return;
  const dir = toTarget.clone().normalize();
  const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(a - b) + 1e-6 * (a + b), (a + b) * (1 - 1e-6));
  const perpendicular = (v: THREE.Vector3) => v.clone().sub(dir.clone().multiplyScalar(v.dot(dir)));
  let pole = perpendicular(midP.clone().sub(rootP));
  if (pole.length() < a * .05) pole = perpendicular(poleHint);
  if (pole.lengthSq() < 1e-12) pole = perpendicular(new THREE.Vector3(0, 0, 1)).lengthSq() > 1e-6 ? perpendicular(new THREE.Vector3(0, 0, 1)) : perpendicular(new THREE.Vector3(1, 0, 0));
  pole.normalize();
  const cos = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const elbow = rootP.clone().addScaledVector(dir, a * cos).addScaledVector(pole, a * Math.sqrt(1 - cos * cos));
  aimBone(root, midP, elbow);
  aimBone(mid, worldPos(end), rootP.clone().addScaledVector(dir, d));
}

/** Cyclic coordinate descent; the per-step cap spreads bending across the chain instead of folding the nearest joint. */
export function solveCcd(chain: THREE.Object3D[], effector: THREE.Object3D, target: THREE.Vector3, iterations = 24) {
  const cap = chain.length > 1 ? .12 : Math.PI;
  for (let i = 0; i < (chain.length > 1 ? iterations : 1); i++) {
    for (const node of chain) aimBone(node, worldPos(effector), target, cap);
    if (worldPos(effector).distanceToSquared(target) < 1e-10) break;
  }
}
