import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { GazeTarget } from '../act/schema';
import { PoseAccumulator, damp } from './pose';

/**
 * 视线层。
 *
 * 两件事：
 * 1. 驱动 VRM 自带的 lookAt（只管眼球）。
 * 2. 额外给 head/neck 加一个**部分跟随** —— 真人转视线时头会跟一点，
 *    只动眼球会得到经典的"恐怖谷斜眼"。
 *
 * 另外加了微扫视（saccade）：即使一直看着用户，眼睛也在做几像素的随机游走。
 * 这个细节的性价比极高，去掉之后角色会立刻显得"发呆"。
 */

const OFFSETS: Record<GazeTarget, THREE.Vector3> = {
  camera: new THREE.Vector3(0, 0, 0),
  away_left: new THREE.Vector3(0.55, 0.06, -0.35),
  away_right: new THREE.Vector3(-0.55, 0.06, -0.35),
  down: new THREE.Vector3(0.05, -0.5, -0.1),
  up: new THREE.Vector3(-0.05, 0.42, -0.15),
};

export class GazeLayer {
  readonly target = new THREE.Object3D();
  private desired = new THREE.Vector3();
  private current = new THREE.Vector3();
  private saccade = new THREE.Vector3();
  private saccadeGoal = new THREE.Vector3();
  private nextSaccade = 0;
  private holdUntil = Infinity;
  private t = 0;
  private mode: GazeTarget = 'camera';
  private axisFlip = 1;
  private headYaw = 0;
  private headPitch = 0;
  // 每帧复用，避免在渲染循环里 new Vector3
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();

  private cameraPos: THREE.Vector3;

  constructor(cameraPos: THREE.Vector3) {
    this.cameraPos = cameraPos.clone();
    this.target.position.copy(this.cameraPos);
    this.current.copy(this.cameraPos);
    this.desired.copy(this.cameraPos);
  }

  setVrmVersion(metaVersion: string | undefined) {
    this.axisFlip = metaVersion === '0' ? -1 : 1;
  }

  look(target: GazeTarget, hold?: number) {
    this.mode = target;
    this.desired.copy(this.cameraPos).add(OFFSETS[target] ?? OFFSETS.camera);
    this.holdUntil = hold != null ? this.t + hold : Infinity;
  }

  get currentTarget() {
    return this.mode;
  }

  update(dt: number, vrm: VRM, acc: PoseAccumulator) {
    this.t += dt;

    if (this.t >= this.holdUntil && this.mode !== 'camera') {
      this.look('camera');
    }

    // 微扫视：每 0.4~1.6s 换一个极小的偏移目标
    this.nextSaccade -= dt;
    if (this.nextSaccade <= 0) {
      this.nextSaccade = 0.4 + Math.random() * 1.2;
      this.saccadeGoal.set(
        (Math.random() - 0.5) * 0.07,
        (Math.random() - 0.5) * 0.045,
        0,
      );
    }
    this.saccade.lerp(this.saccadeGoal, 1 - Math.exp(-9 * dt));

    // 大幅度转移用较慢的阻尼，小幅度用较快的，观感上更像"决定看哪里"而不是"被拖过去"
    const dist = this.current.distanceTo(this.desired);
    const lambda = dist > 0.2 ? 7 : 12;
    this.current.lerp(this.desired, 1 - Math.exp(-lambda * dt));
    this.target.position.copy(this.current).add(this.saccade);

    if (vrm.lookAt) {
      vrm.lookAt.target = this.target;
    }

    // --- 头部部分跟随 ---
    // 起算点用 lookAt 的原点（头骨 + offsetFromHeadBone，约等于眼高），不是头骨本身。
    // 头骨在颅底，用它算出来的俯仰会偏上几度，正好是"微微抬着下巴看人"的别扭感。
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) {
      if (vrm.lookAt) vrm.lookAt.getLookAtWorldPosition(this.origin);
      else head.getWorldPosition(this.origin);

      // rotateVRM0 之后，VRM 0.x 和 1.0 的模型在**世界空间**里都是面朝 +Z 的，
      // 所以 atan2(dir.x, dir.z) 直接就是相对正前方的偏航，不需要任何额外偏移。
      // （此处曾经减过一个 Math.PI，导致头永远偏着约 20° —— 骨骼局部轴的 180° 差异
      //   由 axisFlip 在下面处理，不该混进方向计算里。）
      this.dir.copy(this.target.position).sub(this.origin);
      const yaw = Math.atan2(this.dir.x, this.dir.z);
      const pitch = Math.atan2(-this.dir.y, Math.hypot(this.dir.x, this.dir.z));

      // 限幅避免拧断脖子；只跟随一部分，剩下的交给眼球，这样才像人
      const yawTarget = THREE.MathUtils.clamp(yaw, -0.8, 0.8) * 0.4;
      const pitchTarget = THREE.MathUtils.clamp(pitch, -0.45, 0.45) * 0.35;
      this.headYaw = damp(this.headYaw, yawTarget, 6, dt);
      this.headPitch = damp(this.headPitch, pitchTarget, 6, dt);

      acc.add('head', this.headPitch * this.axisFlip, this.headYaw, 0);
      acc.add('neck', this.headPitch * 0.4 * this.axisFlip, this.headYaw * 0.4, 0);
    }
  }
}
