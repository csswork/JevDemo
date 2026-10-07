import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * 腾讯混元文生动作（HY-Motion）的 FBX → VRM 骨骼。
 *
 * HY-Motion 输出的是 SMPL-H 骨架（Pelvis / L_Hip / Spine1~3 / L_Collar / L_Shoulder… 五指各 3 节），
 * 单位厘米，Y 轴向上。静止姿势是 T-pose、面朝 +Z、左手在 +X —— 和 VRM 1.0 的规范空间一致，
 * 所以不需要额外转朝向，按 three-vrm 官方 Mixamo 示例的做法换算即可：
 *
 *   q_vrm = 父骨骼静止时的世界旋转 · q_动画(局部) · 本骨骼静止时的世界旋转⁻¹
 *
 * 这样得到的是"相对 T-pose 的世界空间转角"，正好就是 VRM 规范化骨骼（静止时全是单位旋转）要的量。
 * VRM 0.x 模型被 rotateVRM0 转了 180°，四元数和位移的 x / z 取反（和 three-vrm-animation 一致）。
 *
 * 胯部位移有个坑：FBX 里的静止骨架和动画**不在同一个高度基准上** —— 静止时胯部在 -19cm、
 * 脚在 -113cm，动画里胯部在 97cm、脚在 4cm。直接拿动画值减静止值，人会被抬高 1 米多，
 * 画面里只剩一双腿。所以高度在动画自己的坐标里量：整段动画里脚的最低点当地面，
 * 胯部离地多高就是多高；水平方向以第一帧为原点（原地动作，不让人漂走）。
 */
const SMPL_TO_VRM: Record<string, VRMHumanBoneName> = {
  Pelvis: 'hips',
  Spine1: 'spine',
  Spine2: 'chest',
  Spine3: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  L_Hip: 'leftUpperLeg',
  L_Knee: 'leftLowerLeg',
  L_Ankle: 'leftFoot',
  L_Foot: 'leftToes',
  R_Hip: 'rightUpperLeg',
  R_Knee: 'rightLowerLeg',
  R_Ankle: 'rightFoot',
  R_Foot: 'rightToes',
  L_Collar: 'leftShoulder',
  L_Shoulder: 'leftUpperArm',
  L_Elbow: 'leftLowerArm',
  L_Wrist: 'leftHand',
  R_Collar: 'rightShoulder',
  R_Shoulder: 'rightUpperArm',
  R_Elbow: 'rightLowerArm',
  R_Wrist: 'rightHand',
};
for (const [side, s] of [
  ['L', 'left'],
  ['R', 'right'],
] as const) {
  SMPL_TO_VRM[`${side}_Thumb1`] = `${s}ThumbMetacarpal`;
  SMPL_TO_VRM[`${side}_Thumb2`] = `${s}ThumbProximal`;
  SMPL_TO_VRM[`${side}_Thumb3`] = `${s}ThumbDistal`;
  for (const [smpl, vrm] of [
    ['Index', 'Index'],
    ['Middle', 'Middle'],
    ['Ring', 'Ring'],
    ['Pinky', 'Little'],
  ] as const) {
    SMPL_TO_VRM[`${side}_${smpl}1`] = `${s}${vrm}Proximal`;
    SMPL_TO_VRM[`${side}_${smpl}2`] = `${s}${vrm}Intermediate`;
    SMPL_TO_VRM[`${side}_${smpl}3`] = `${s}${vrm}Distal`;
  }
}

export interface HumanoidTracks {
  duration: number;
  rotation: Map<VRMHumanBoneName, THREE.QuaternionKeyframeTrack>;
  translation: Map<'hips', THREE.VectorKeyframeTrack>;
  /** FBX units → VRM meters, from the standing hip height. */
  scale: number;
}

/**
 * 把 FBXLoader 读出来的 SMPL-H 动作换算到某个 VRM 上。
 * fbx 是 FBXLoader 的结果（未经修改，骨骼停在静止姿势），可以对多个模型反复调用。
 */
export function retargetSmpl(fbx: THREE.Group, vrm: VRM): HumanoidTracks {
  const clip = fbx.animations[0];
  const rotation = new Map<VRMHumanBoneName, THREE.QuaternionKeyframeTrack>();
  const translation = new Map<'hips', THREE.VectorKeyframeTrack>();
  if (!clip) return { duration: 0, rotation, translation, scale: 1 };

  fbx.updateMatrixWorld(true);
  const vrm0 = (vrm.meta as { metaVersion?: string }).metaVersion === '0';
  const restInv = new THREE.Quaternion();
  const parentRest = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  // 胯部高度：静止姿势下胯部比脚的关节高多少（站直时的腿长），缩放到模型的胯部高度
  const FEET = ['L_Foot', 'R_Foot', 'L_Ankle', 'R_Ankle'];
  const lowestFoot = () =>
    Math.min(
      ...FEET.map((n) => fbx.getObjectByName(n)?.getWorldPosition(new THREE.Vector3()).y).filter(
        (y): y is number => y != null,
      ),
    );
  const pelvis = fbx.getObjectByName('Pelvis');
  const pelvisRest = pelvis?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
  const standHeight = pelvisRest.y - lowestFoot();
  const vrmHipsY = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 1;
  const scale = vrmHipsY / Math.max(1e-6, standHeight);
  const ground = animationGround(fbx, clip, lowestFoot);

  for (const track of clip.tracks) {
    const [nodeName, prop] = track.name.split('.');
    const bone = SMPL_TO_VRM[nodeName];
    const node = fbx.getObjectByName(nodeName);
    if (!bone || !node) continue;

    if (prop === 'quaternion') {
      node.getWorldQuaternion(restInv).invert();
      if (node.parent) node.parent.getWorldQuaternion(parentRest);
      else parentRest.identity();
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i).premultiply(parentRest).multiply(restInv);
        q.toArray(values, i);
        if (vrm0) {
          values[i] = -values[i];
          values[i + 2] = -values[i + 2];
        }
      }
      rotation.set(bone, new THREE.QuaternionKeyframeTrack(bone, track.times.slice(), values));
    } else if (prop === 'position' && bone === 'hips') {
      // 局部位移 → 世界。高度 = 离地多高 - 站直时的腿长；水平 = 相对第一帧
      const parentMatrix = node.parent?.matrixWorld ?? new THREE.Matrix4();
      const v = new THREE.Vector3();
      const first = new THREE.Vector3().fromArray(track.values, 0).applyMatrix4(parentMatrix);
      const values = track.values.slice();
      const rest = vrm.humanoid.normalizedRestPose.hips?.position ?? [0, vrmHipsY, 0];
      for (let i = 0; i < values.length; i += 3) {
        v.fromArray(values, i).applyMatrix4(parentMatrix);
        const dx = (v.x - first.x) * scale;
        const dy = (v.y - ground - standHeight) * scale;
        const dz = (v.z - first.z) * scale;
        values[i] = rest[0] + (vrm0 ? -dx : dx);
        values[i + 1] = rest[1] + dy;
        values[i + 2] = rest[2] + (vrm0 ? -dz : dz);
      }
      translation.set('hips', new THREE.VectorKeyframeTrack('hips', track.times.slice(), values));
    }
  }
  return { duration: clip.duration, rotation, translation, scale };
}

/**
 * 动画里的地面高度：逐帧（每 5 帧取一帧）把动画放到骨架上，取脚关节的最低点。
 * 放完把骨架还原成静止姿势 —— 同一个 FBX 还要给别的模型换算
 */
function animationGround(fbx: THREE.Group, clip: THREE.AnimationClip, lowestFoot: () => number): number {
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion]> = [];
  fbx.traverse((o) => {
    if ((o as THREE.Bone).isBone) saved.push([o, o.position.clone(), o.quaternion.clone()]);
  });
  const mixer = new THREE.AnimationMixer(fbx);
  const action = mixer.clipAction(clip);
  action.play();
  let ground = Infinity;
  const times = clip.tracks[0]?.times ?? [];
  for (let i = 0; i < times.length; i += 5) {
    mixer.setTime(times[i]);
    fbx.updateMatrixWorld(true);
    ground = Math.min(ground, lowestFoot());
  }
  action.stop();
  mixer.uncacheRoot(fbx);
  for (const [o, p, q] of saved) {
    o.position.copy(p);
    o.quaternion.copy(q);
  }
  fbx.updateMatrixWorld(true);
  return Number.isFinite(ground) ? ground : 0;
}
