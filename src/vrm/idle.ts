import type { PostureId } from '../act/schema';
import { PoseAccumulator, damp, deg } from './pose';

/**
 * Idle 层 —— 决定"这个角色是活的"的那一层。
 *
 * 经验上，这层比接 LLM 重要得多：没有呼吸和重心转移的角色，无论表情多准，
 * 看起来都像一张会说话的贴图。而且它完全不依赖 Jev，可以独立验收。
 *
 * 三个尺度叠在一起，周期互质，避免肉眼看出循环：
 *   ~4s  呼吸       ~9s  重心转移      ~13s 头部微漂移
 */

interface PostureBias {
  spine: [number, number, number];
  chest: [number, number, number];
  head: [number, number, number];
  shoulderDrop: number;
  /**
   * 上臂从 T-pose 放下到体侧的角度。
   * VRM 规范要求静止姿态为 T-pose，所以这里必须给足约 70°，
   * 否则角色会一直摊着手。手势 clip 都是相对这个"垂手"基准写的。
   */
  armClose: number;
  /** 上臂前摆角度。真人手臂自然下垂时略微朝前，完全贴在冠状面上会很僵。 */
  armForward: number;
  /** 肘部自然弯曲 */
  elbowBend: number;
  breathScale: number;
}

const POSTURE_BIAS: Record<PostureId, PostureBias> = {
  idle_neutral: {
    spine: [0, 0, 0],
    chest: [0, 0, 0],
    head: [0, 0, 0],
    shoulderDrop: 0,
    armClose: 72,
    armForward: 7,
    elbowBend: 11,
    breathScale: 1,
  },
  idle_cheerful: {
    spine: [-2, 0, 0],
    chest: [-2.5, 0, 0],
    head: [-3, 0, 0],
    shoulderDrop: -2,
    armClose: 69,
    armForward: 9,
    elbowBend: 14,
    breathScale: 1.15,
  },
  idle_low: {
    spine: [5, 0, 0],
    chest: [3, 0, 0],
    head: [7, 0, 0],
    shoulderDrop: 5,
    armClose: 76,
    armForward: 5,
    elbowBend: 8,
    breathScale: 0.8,
  },
  idle_alert: {
    spine: [1.5, 0, 0],
    chest: [-1, 0, 0],
    head: [-1, 0, 0],
    shoulderDrop: -3,
    armClose: 70,
    armForward: 8,
    elbowBend: 13,
    breathScale: 1.05,
  },
};

/** 多频正弦叠加的伪噪声，取值约 [-1, 1]。比真 Perlin 便宜，肉眼无差别。 */
function noise(t: number, seed: number): number {
  return (
    Math.sin(t * 0.73 + seed) * 0.6 +
    Math.sin(t * 1.37 + seed * 2.1) * 0.28 +
    Math.sin(t * 2.91 + seed * 3.7) * 0.12
  );
}

export class IdleLayer {
  private t = 0;
  private posture: PostureId = 'idle_neutral';
  private bias = POSTURE_BIAS.idle_neutral;
  /** 当前实际生效的 bias，向目标 bias 平滑过渡，避免换 posture 时角色"抽一下" */
  private blend: PostureBias = structuredClone(POSTURE_BIAS.idle_neutral);
  private arousal = 0.2;
  private axisFlip = 1;
  /**
   * 肢体动作总量 0..1。半身景别下身体大幅晃动只会分散注意力，
   * 默认压到 0.25：留呼吸和头部微漂移，去掉重心转移那一档。
   */
  private bodyMotion = 0.25;

  setVrmVersion(metaVersion: string | undefined) {
    this.axisFlip = metaVersion === '0' ? -1 : 1;
  }

  setPosture(p: PostureId) {
    this.posture = p;
    this.bias = POSTURE_BIAS[p] ?? POSTURE_BIAS.idle_neutral;
  }

  /** 跳过过渡，直接落到当前 posture。载入时暖机用，避免从 T-pose 缓动过去。 */
  snap() {
    this.blend = structuredClone(this.bias);
  }

  setArousal(a: number) {
    this.arousal = Math.max(0, Math.min(1, a));
  }

  setBodyMotion(scale: number) {
    this.bodyMotion = Math.max(0, Math.min(1, scale));
  }

  get bodyMotionScale() {
    return this.bodyMotion;
  }

  get currentPosture() {
    return this.posture;
  }

  update(dt: number, acc: PoseAccumulator) {
    // arousal 高时整体节奏加快，低时变慢 —— 情绪调制的是"怎么动"，不只是"动什么"
    const rate = 0.85 + this.arousal * 0.45;
    this.t += dt * rate;
    const t = this.t;

    // posture 过渡
    const l = 2.5;
    const b = this.blend;
    for (const k of ['spine', 'chest', 'head'] as const) {
      for (let i = 0; i < 3; i++) {
        b[k][i] = damp(b[k][i], this.bias[k][i], l, dt);
      }
    }
    b.shoulderDrop = damp(b.shoulderDrop, this.bias.shoulderDrop, l, dt);
    b.armClose = damp(b.armClose, this.bias.armClose, l, dt);
    b.armForward = damp(b.armForward, this.bias.armForward, l, dt);
    b.elbowBend = damp(b.elbowBend, this.bias.elbowBend, l, dt);
    b.breathScale = damp(b.breathScale, this.bias.breathScale, l, dt);

    const flip = this.axisFlip;

    // --- 基础姿态 ---
    acc.add('spine', deg(b.spine[0]) * flip, deg(b.spine[1]), deg(b.spine[2]) * flip);
    acc.add('chest', deg(b.chest[0]) * flip, deg(b.chest[1]), deg(b.chest[2]) * flip);
    acc.add('head', deg(b.head[0]) * flip, deg(b.head[1]), deg(b.head[2]) * flip);
    acc.add('leftShoulder', 0, 0, deg(-b.shoulderDrop) * flip);
    acc.add('rightShoulder', 0, 0, deg(b.shoulderDrop) * flip);
    acc.add('leftUpperArm', 0, deg(-b.armForward), deg(-b.armClose) * flip);
    acc.add('rightUpperArm', 0, deg(b.armForward), deg(b.armClose) * flip);
    acc.add('leftLowerArm', 0, deg(-b.elbowBend), 0);
    acc.add('rightLowerArm', 0, deg(b.elbowBend), 0);

    const bm = this.bodyMotion;

    // --- 呼吸 (~4s) ---
    // 呼吸不随 bodyMotion 归零：停掉呼吸的角色立刻变成静态贴图。
    const breath = Math.sin((t * Math.PI * 2) / 4.1) * b.breathScale * (0.65 + 0.35 * bm);
    acc.add('chest', deg(-1.1) * breath * flip, 0, 0);
    acc.add('spine', deg(-0.5) * breath * flip, 0, 0);
    acc.add('leftShoulder', 0, 0, deg(-0.8) * breath * flip);
    acc.add('rightShoulder', 0, 0, deg(0.8) * breath * flip);
    acc.translateHips(0, 0.0035 * breath, 0);

    // --- 重心转移 (~9s) ---
    const shift = noise(t * 0.7, 11.3) * bm;
    acc.translateHips(0.011 * shift * flip, -0.004 * Math.abs(shift), 0);
    acc.add('hips', 0, deg(1.4) * shift, deg(-1.8) * shift * flip);
    acc.add('spine', 0, deg(-0.8) * shift, deg(1.2) * shift * flip);
    acc.add('leftUpperArm', 0, 0, deg(1.6) * shift * flip);
    acc.add('rightUpperArm', 0, 0, deg(1.6) * shift * flip);

    // --- 头部微漂移 (~13s) ---
    // 这一档只随 bodyMotion 衰减一半：半身景别下头部的微动就是"活着"本身，
    // 关掉之后哪怕表情做得再细，整个人也会显得发呆。
    const hm = 0.5 + 0.5 * bm;
    acc.add(
      'head',
      deg(1.3) * noise(t * 0.41, 3.1) * hm * flip,
      deg(2.2) * noise(t * 0.33, 7.7) * hm,
      deg(1.1) * noise(t * 0.29, 5.2) * hm * flip,
    );
    acc.add(
      'neck',
      deg(0.6) * noise(t * 0.37, 2.2) * hm * flip,
      deg(1.0) * noise(t * 0.31, 9.1) * hm,
      0,
    );
  }
}
