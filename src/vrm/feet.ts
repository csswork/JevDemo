import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

/**
 * 脚底锁定 —— 待机时脚踩在地上不动。
 *
 * 动捕待机（idle_loop）的重心转移是把胯部左右平移约 2.7cm，腿只是跟着胯部一起走，
 * 两只脚在地上横着滑 2.4~2.7cm、前后滑约 0.8cm；程序待机的呼吸会把整个人上下抬
 * 0.6cm，脚跟着离地。真人重心转移时脚是不动的，晃的是胯和膝盖。
 *
 * 做法：每只脚记一个锚点（位置 + 朝向，存在 vrm.scene 的局部坐标里，角色整体挪动时跟着走），
 * 各层叠完之后用两段骨骼 IK 把脚放回锚点 —— 先弯膝盖让胯到脚的距离对上，再转大腿把脚对准。
 * 膝盖朝向跟着这一帧 FK 的膝盖走，只做最小的旋转，不改动作本来的腿型。
 *
 * 什么时候锁：只在待机时。播转圈、深蹲、打招呼这类本来就要动脚的动作时，按动作的权重让出来；
 * 让出来期间（以及动捕待机淡入淡出的时候）锚点跟着 FK 走，动作放完重新落脚 —— 脚落在
 * 哪里就锁在哪里，不会从动作结束的位置滑回某个固定站位。
 *
 * 必须在 PoseAccumulator.flush 之后调用（拿到这一帧其余各层叠完的姿势）。
 */

const SIDES = [
  { upper: 'leftUpperLeg', lower: 'leftLowerLeg', foot: 'leftFoot' },
  { upper: 'rightUpperLeg', lower: 'rightLowerLeg', foot: 'rightFoot' },
] as const;

/** 锁定权重低于这个值时，锚点跟着 FK 走（重新落脚） */
const TRACK_BELOW = 0.02;

interface Anchor {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export class FootLock {
  /** 调试开关：控制台里 __jev.character.feet.enabled = false 对比 */
  enabled = true;
  private anchors: [Anchor, Anchor] | null = null;
  private _v = Array.from({ length: 9 }, () => new THREE.Vector3());
  private _q = Array.from({ length: 8 }, () => new THREE.Quaternion());

  /** 换模型时清掉锚点，下一帧从新模型的脚重新落 */
  reset() {
    this.anchors = null;
  }

  /**
   * @param weight 锁定的强度（0..1）。为 0 时什么都不做，锚点跟着 FK
   * @param settling 姿势正在大幅切换（动捕待机淡入淡出），这时锚点也跟着 FK 走
   */
  solve(vrm: VRM, weight: number, settling = false) {
    const H = vrm.humanoid;
    const scene = vrm.scene;
    const nodes = SIDES.map((s) => ({
      upper: H.getNormalizedBoneNode(s.upper),
      lower: H.getNormalizedBoneNode(s.lower),
      foot: H.getNormalizedBoneNode(s.foot),
    }));
    if (nodes.some((n) => !n.upper?.parent || !n.lower || !n.foot)) return;

    scene.updateMatrixWorld(true);
    const [sceneQ, sceneQInv] = this._q;
    scene.getWorldQuaternion(sceneQ);
    sceneQInv.copy(sceneQ).invert();

    const track = !this.enabled || weight < TRACK_BELOW || settling || !this.anchors;
    if (track) {
      // 锚点 = 这一帧 FK 的脚（scene 局部坐标）
      this.anchors ??= [
        { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
        { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
      ];
      nodes.forEach((n, i) => {
        const a = this.anchors![i];
        scene.worldToLocal(n.foot!.getWorldPosition(a.pos));
        n.foot!.getWorldQuaternion(a.quat).premultiply(sceneQInv);
      });
      return;
    }

    // 角色朝前的方向（世界）：左右胯连线 × 上。VRM 0 / 1 的轴向不用分开处理
    const [hipL, hipR, fwd] = this._v;
    nodes[0].upper!.getWorldPosition(hipL);
    nodes[1].upper!.getWorldPosition(hipR);
    fwd.subVectors(hipL, hipR).cross(new THREE.Vector3(0, 1, 0)).normalize();

    nodes.forEach((n, i) => this.solveLeg(n.upper!, n.lower!, n.foot!, this.anchors![i], sceneQ, fwd, weight, scene));
  }

  private solveLeg(
    upper: THREE.Object3D,
    lower: THREE.Object3D,
    foot: THREE.Object3D,
    anchor: Anchor,
    sceneQ: THREE.Quaternion,
    fwd: THREE.Vector3,
    w: number,
    scene: THREE.Object3D,
  ) {
    const [, , , S, E, W, T, n, tmp] = this._v;
    const [, , qUpperFk, qLowerFk, qFootFk, qKnee, qHip, qParent] = this._q;
    upper.getWorldPosition(S);
    lower.getWorldPosition(E);
    foot.getWorldPosition(W);
    scene.localToWorld(T.copy(anchor.pos));

    const L1 = S.distanceTo(E);
    const L2 = E.distanceTo(W);
    if (L1 < 1e-4 || L2 < 1e-4) return;
    const d = Math.min(L1 + L2 - 1e-4, Math.max(Math.abs(L1 - L2) + 1e-4, S.distanceTo(T)));

    // ---- 膝盖：绕铰链轴弯到胯→脚的距离等于 d ----
    const thigh = tmp.subVectors(E, S).normalize();
    const shin = new THREE.Vector3().subVectors(W, E).normalize();
    // 腿接近伸直时（VRM 的静止姿势就是直腿）FK 的叉积又小又不稳，膝盖会左右乱摆：
    // 弯得越少越偏向"膝盖朝前"推出来的轴，弯过 10° 就完全用 FK 的
    const bent = n.crossVectors(thigh, shin).length();
    const ahead = new THREE.Vector3().crossVectors(fwd, thigh).normalize();
    if (bent > 1e-6) n.divideScalar(bent);
    n.lerp(ahead, 1 - THREE.MathUtils.smoothstep(bent, 0, Math.sin(THREE.MathUtils.degToRad(10)))).normalize();
    // 屈曲角 = π - 膝盖内角；绕 n 正向转是加大屈曲（脚往后收）
    const interior0 = Math.acos(THREE.MathUtils.clamp(-thigh.dot(shin), -1, 1));
    const interior1 = Math.acos(THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    qKnee.setFromAxisAngle(n, interior0 - interior1);
    const W1 = shin.applyQuaternion(qKnee).multiplyScalar(L2).add(E);

    // ---- 大腿：最小旋转，把脚从 W1 转到锚点方向 ----
    const from = W1.sub(S).normalize();
    const to = new THREE.Vector3().subVectors(T, S).normalize();
    qHip.setFromUnitVectors(from, to);

    // ---- 世界朝向从 FK 混向 IK，再一层层换成局部 ----
    upper.getWorldQuaternion(qUpperFk);
    lower.getWorldQuaternion(qLowerFk);
    foot.getWorldQuaternion(qFootFk);
    const qU = qUpperFk.clone().slerp(qUpperFk.clone().premultiply(qHip), w);
    const qL = qLowerFk.clone().slerp(qLowerFk.clone().premultiply(qKnee).premultiply(qHip), w);
    const qF = qFootFk.clone().slerp(anchor.quat.clone().premultiply(sceneQ), w);

    upper.parent!.getWorldQuaternion(qParent);
    upper.quaternion.copy(qParent.invert().multiply(qU));
    lower.quaternion.copy(qU.invert().multiply(qL));
    foot.quaternion.copy(qL.invert().multiply(qF));
  }
}
