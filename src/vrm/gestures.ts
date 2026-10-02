import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Emotion, ProceduralMotionId } from '../act/schema';
import { PoseAccumulator, deg } from './pose';

/**
 * 程序生成的表演动作（和 motion.ts 的动捕 .vrma 并列，用同一套动作 id）。
 *
 * 为什么不像第一版那样直接写关节角度：手要碰到脸的动作（掩嘴笑、托腮、手放胸口……）
 * 换一个模型，肩宽、臂长、头的大小都不一样，写死的角度不是够不着就是插进脸里。
 * 这里手的位置用 IK 求：每帧找到嘴在哪（第一次播时朝脸打一条射线，记在头部的局部坐标里，
 * 之后跟着头走），把手腕放过去、掌心对着嘴，肩和肘由两段骨骼的 IK 解出来，
 * 肘部只绕自己的铰链轴弯（不会往奇怪的方向拧），前臂分担一半的翻腕。
 *
 * 身体部分是关键帧 + 缓动：先吸一口气（预备动作），再往前倾、低头、歪头，
 * 笑声的"哈哈哈"是一串逐渐变慢、逐渐变弱的耸肩，最后手放下、身体回正 —— 都叠在待机上，
 * 呼吸和重心照常。
 *
 * 角度按 VRM 1.0 规范空间写（和 idle 层一样）：躯干 / 头 X 正 = 往前低，Z 正 = 往角色右侧歪，
 * Y 正 = 往角色左侧转；VRM 0.x 把 X、Z 取反。
 */

export interface GestureDef {
  label: string;
  duration: number;
  /** 开发面板预览时顺便演的表情（对话里的表情照常由 Jev 定） */
  preview?: Partial<Record<Emotion, number>>;
}

export const GESTURES: Record<ProceduralMotionId, GestureDef> = {
  laugh_cover: { label: '掩嘴笑', duration: 3.4, preview: { happy: 0.85 } },
};

/** 手形覆盖（给 hands.ts）：手指整体多弯几度、并拢多少、拇指收多少 */
export interface HandShape {
  weight: number;
  curl: number;
  close: number;
  thumb: number;
}

type Side = 'left' | 'right';

const smoother = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * x * (x * (x * 6 - 15) + 10);
};
/** a 秒到 b 秒之间从 0 升到 1 */
const rise = (t: number, a: number, b: number) => smoother((t - a) / (b - a));
const bump = (u: number) => Math.sin(Math.PI * Math.max(0, Math.min(1, u))) ** 2;

interface Playing {
  id: ProceduralMotionId;
  t: number;
  speed: number;
  /** 被打断时从当前姿势淡出 */
  leaving: number | null;
}

export class GestureLayer {
  private vrm: VRM | null = null;
  private flip = 1;
  private playing: Playing | null = null;
  /** 这一帧到点的节奏信号（Character 转给表情层：笑声的起伏只叠在已经带笑的脸上，不设定情绪） */
  private cues: Array<'laugh'> = [];
  /** 嘴（脸表面）在头部局部坐标里的位置，按模型缓存 */
  private mouthLocal: THREE.Vector3 | null = null;

  // 本帧算出来的量
  private reach = 0;
  private armW = 0;
  private body = { lean: 0, inhale: 0, pulse: 0, other: 0 };

  private _v = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3());
  private _q = [0, 1, 2, 3, 4, 5].map(() => new THREE.Quaternion());
  private _m = [0, 1].map(() => new THREE.Matrix4());

  bind(vrm: VRM) {
    this.vrm = vrm;
    this.flip = (vrm.meta as { metaVersion?: string }).metaVersion === '0' ? -1 : 1;
    this.mouthLocal = null;
    this.playing = null;
  }

  play(id: ProceduralMotionId, opts: { speed?: number } = {}) {
    if (!this.vrm) return false;
    if (!this.mouthLocal) this.mouthLocal = this.findMouth();
    this.playing = { id, t: 0, speed: opts.speed ?? 1, leaving: null };
    return true;
  }

  /** 停下：从当前进度很快地收回去 */
  stop() {
    if (this.playing && this.playing.leaving == null) this.playing.leaving = 0;
  }

  setSpeed(speed: number) {
    if (this.playing) this.playing.speed = Math.max(0, speed);
  }

  seek(t: number) {
    if (this.playing) this.playing.t = Math.max(0, Math.min(GESTURES[this.playing.id].duration, t));
  }

  get current(): { id: ProceduralMotionId; t: number; duration: number } | null {
    const p = this.playing;
    return p && p.leaving == null ? { id: p.id, t: p.t, duration: GESTURES[p.id].duration } : null;
  }

  takeCues() {
    const c = this.cues;
    this.cues = [];
    return c;
  }

  /** 掩嘴的那只手的手形 */
  handShape(side: Side): HandShape | null {
    if (!this.playing || side !== 'right') return null;
    // 手指并拢、基本伸直（比放松时还直一点），拇指收在食指旁边。
    // 试过让手指弯起来：掌心朝着脸，手指一弯指尖就折进嘴唇和脸颊里（穿模）
    return { weight: this.reach, curl: -5, close: 1, thumb: 8 };
  }

  update(dt: number) {
    const p = this.playing;
    if (!p) return;
    const before = p.t;
    p.t += dt * p.speed;
    // 两声笑：开始耸肩的时候、中间再一次
    for (const at of [0.55, 1.3]) if (before < at && p.t >= at && p.leaving == null) this.cues.push('laugh');
    const dur = GESTURES[p.id].duration;
    let k = 1;
    if (p.leaving != null) {
      p.leaving += dt;
      k = 1 - smoother(p.leaving / 0.5);
    }
    if (p.t >= dur || k <= 0) {
      this.playing = null;
      this.reach = this.armW = 0;
      this.body = { lean: 0, inhale: 0, pulse: 0, other: 0 };
      return;
    }
    const t = Math.min(p.t, dur);
    // ---- 掩嘴笑 ----
    // 手：0.12s 起手，0.78s 到嘴边；停到 2.45s，2.45~3.25s 放下
    this.reach = rise(t, 0.12, 0.78) * (1 - rise(t, 2.45, 3.25)) * k;
    // IK 的接管和交还按时间慢慢来（各 0.25s）。起手和放下时 IK 的肘部方向跟着 FK 走（见 solve），
    // 两边的姿势本来就几乎一样，混起来不会"抽一下"。第一版按进度的前四分之一就接管，
    // 实测起手那一下手臂转得有 976°/s
    this.armW = rise(t, 0, 0.25) * (1 - rise(t, 3.12, 3.38)) * k;
    // 身体：先吸一口气，再往前倾、低头、歪头；手放下时回正
    const lean = rise(t, 0.2, 0.8) * (1 - rise(t, 2.5, 3.35));
    const inhale = bump(t / 0.45);
    // 笑声：0.55s 开始的一串耸肩，从 4.6 次 / 秒慢慢放慢到 3.7，越来越弱
    const tau = Math.max(0, t - 0.55);
    const env = rise(t, 0.55, 0.75) * (1 - rise(t, 1.5, 2.4));
    const phase = Math.PI * 2 * (4.6 * tau - 0.25 * tau * tau);
    const pulse = Math.max(0, Math.sin(phase)) ** 1.5 * env;
    // 另一只手跟着抬起一点，停在肚子前面
    const other = rise(t, 0.25, 0.85) * (1 - rise(t, 2.4, 3.3));
    this.body = { lean: lean * k, inhale: inhale * k, pulse: pulse * k, other: other * k };
  }

  /** 身体的部分（叠在待机上的偏移） */
  addOffsets(acc: PoseAccumulator) {
    if (!this.playing) return;
    const { lean: L, inhale: I, pulse: P, other: O } = this.body;
    const f = this.flip;
    const add = (bone: VRMHumanBoneName, x: number, y: number, z: number) =>
      acc.add(bone, deg(x) * f, deg(y), deg(z) * f);
    add('spine', 2 * L - 1 * I, -2 * L, 0);
    add('chest', 3 * L - 2 * I + 1.6 * P, -2 * L, 0);
    add('neck', 2 * L + 0.6 * P, 0, 1.5 * L);
    add('head', 5 * L - 2 * I + 0.8 * P, 0, 4.5 * L);
    // 耸肩：吸气时、每一声笑的时候
    const raise = 2 * I + 1 * L + 1.8 * P;
    add('leftShoulder', 0, 0, raise);
    add('rightShoulder', 0, 0, -raise);
    acc.translateHips(0, -0.0025 * P, 0);
    // 左手：小臂抬起停在肚子前面，跟着笑轻轻颤
    const elbow = 30 * O + 2 * P;
    add('leftUpperArm', 0, -6 * O, -4 * O);
    add('leftLowerArm', 0, -elbow, 0);
  }

  /**
   * 掩嘴的手（IK）。必须在 PoseAccumulator.flush 之后调用：
   * 拿到这一帧其余各层叠完的姿势（FK），再把右臂从它混向 IK 的解
   */
  solve(vrm: VRM) {
    if (!this.playing || this.armW <= 0 || !this.mouthLocal) return;
    const H = vrm.humanoid;
    const upper = H.getNormalizedBoneNode('rightUpperArm');
    const lower = H.getNormalizedBoneNode('rightLowerArm');
    const hand = H.getNormalizedBoneNode('rightHand');
    const head = H.getNormalizedBoneNode('head');
    if (!upper || !lower || !hand || !head || !upper.parent) return;
    hand.updateWorldMatrix(true, false);
    head.updateWorldMatrix(true, false);

    const [S, E0, W0, M, fwd, up, right, tmp] = this._v;
    upper.getWorldPosition(S);
    lower.getWorldPosition(E0);
    hand.getWorldPosition(W0);
    const L1 = S.distanceTo(E0);
    const L2 = E0.distanceTo(W0);
    const reachLen = this.palmLength(vrm);

    // 头的朝向（跟着低头、歪头一起走）
    const [qHead, qRest, qUpperFk, qLowerFk, qHandFk, qTmp] = this._q;
    head.getWorldQuaternion(qHead);
    const m = this.flip; // VRM 0.x 的规范空间面朝 -Z、角色右手边是 +X
    fwd.set(0, 0, m).applyQuaternion(qHead);
    up.set(0, 1, 0).applyQuaternion(qHead);
    right.set(-m, 0, 0).applyQuaternion(qHead);
    head.localToWorld(M.copy(this.mouthLocal));

    // 掌心朝着嘴，手指往上、往脸的另一侧斜，并拢的手指盖在嘴前面。
    // 试过把手往下、往侧边挪、手指斜得更平（想让鼻子露出来）：嘴和下巴那一带的脸是往前凸的，
    // 手指伸到脸中间就插进去了。这一版（第一版）的位置是看过之后定下来的，改之前先跑穿模检测
    const fingers = new THREE.Vector3().copy(up).multiplyScalar(0.78).addScaledVector(right, -0.55).addScaledVector(fwd, 0.12).normalize();
    const palm = new THREE.Vector3().copy(fwd).negate();
    palm.addScaledVector(fingers, -palm.dot(fingers)).normalize();
    // 指根那一排落在嘴角右下方一点、离嘴唇 3cm，手指斜着盖过嘴
    const knuckles = tmp.copy(M).addScaledVector(fwd, 0.03).addScaledVector(up, -0.018).addScaledVector(right, 0.012);
    const goal = new THREE.Vector3().copy(knuckles).addScaledVector(fingers, -reachLen);

    // 路径：从这一帧 FK 的手腕位置出发，往前鼓一个弧再到嘴边 —— 不贴着胸口往上蹭（0.13 时放下来那一段手掌还会碰到胸口）
    const s = this.reach;
    const ctrl = new THREE.Vector3().copy(W0).lerp(goal, 0.5).addScaledVector(fwd, 0.17);
    const T = new THREE.Vector3()
      .copy(W0)
      .multiplyScalar((1 - s) * (1 - s))
      .addScaledVector(ctrl, 2 * (1 - s) * s)
      .addScaledVector(goal, s * s);

    // ---- 两段骨骼 IK：肘往下、略往外、略往前 ----
    const toT = new THREE.Vector3().subVectors(T, S);
    const d = Math.min(L1 + L2 - 1e-4, Math.max(Math.abs(L1 - L2) + 1e-4, toT.length()));
    toT.normalize();
    const pole = new THREE.Vector3().copy(up).negate().addScaledVector(right, 0.35).addScaledVector(fwd, 0.15);
    pole.addScaledVector(toT, -pole.dot(toT)).normalize();
    // 起手时肘部的方向从 FK 的肘出发，随着抬手慢慢转到目标方向：手还在体侧时 IK 的解就是 FK 的姿势
    const fkPole = new THREE.Vector3().subVectors(E0, S);
    fkPole.addScaledVector(toT, -fkPole.dot(toT));
    if (fkPole.lengthSq() > 1e-8) {
      fkPole.normalize();
      pole.lerp(fkPole, 1 - smoother(s * 1.6)).normalize();
    }
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const E1 = new THREE.Vector3().copy(S).addScaledVector(toT, L1 * cosA).addScaledVector(pole, L1 * sinA);

    // 静止姿势里（规范空间）右臂朝角色右手边、肘往前折、掌心朝下
    upper.parent.getWorldQuaternion(qTmp);
    // 静止姿势的世界朝向：规范空间各骨骼局部旋转都是单位，所以就是规范骨架根节点的世界朝向
    const root = H.normalizedHumanBonesRoot;
    root.getWorldQuaternion(qRest);
    const restArm = new THREE.Vector3(-m, 0, 0).applyQuaternion(qRest);
    const restFold = new THREE.Vector3(0, 0, m).applyQuaternion(qRest);
    const restPalm = new THREE.Vector3(0, -1, 0).applyQuaternion(qRest);

    // 上臂：顺着 S→E1，肘往"前臂要折过去的方向"折（只绕铰链轴弯）
    const a1 = new THREE.Vector3().subVectors(E1, S).normalize();
    const fore = new THREE.Vector3().subVectors(T, E1).normalize();
    const b1 = new THREE.Vector3().copy(fore).addScaledVector(a1, -fore.dot(a1));
    if (b1.lengthSq() < 1e-6) b1.copy(fwd).addScaledVector(a1, -fwd.dot(a1));
    b1.normalize();
    const qUpperIk = this.basisRotation(restArm, restFold, a1, b1, qRest, new THREE.Quaternion());
    // 前臂：从上臂的方向绕铰链轴转到 E1→T
    const hinge = new THREE.Vector3().crossVectors(a1, b1).normalize();
    const phi = Math.acos(Math.max(-1, Math.min(1, a1.dot(fore))));
    const qLowerIk = new THREE.Quaternion().setFromAxisAngle(hinge, phi).multiply(qUpperIk);
    // 手：手指和掌心对准目标（从 FK 的朝向随着抬手的进度慢慢转过去）
    const qHandGoal = this.basisRotation(restArm, restPalm, fingers, palm, qRest, new THREE.Quaternion());

    // ---- 换成局部旋转，从 FK 混过去 ----
    upper.getWorldQuaternion(qUpperFk);
    lower.getWorldQuaternion(qLowerFk);
    hand.getWorldQuaternion(qHandFk);
    const w = this.armW;
    // 世界朝向先混好，再一层层换成局部：父节点用混好之后的
    const qU = new THREE.Quaternion().copy(qUpperFk).slerp(qUpperIk, w);
    const qL = new THREE.Quaternion().copy(qLowerFk).slerp(qLowerIk, w);
    const qHnd = new THREE.Quaternion().copy(qHandFk).slerp(qHandGoal, Math.min(w, smoother(s * 1.15)));
    const parentQ = qTmp; // 上臂的父节点（肩）的世界朝向
    upper.quaternion.copy(parentQ).invert().multiply(qU);
    const lowerLocal = new THREE.Quaternion().copy(qU).invert().multiply(qL);
    const handLocal = new THREE.Quaternion().copy(qL).invert().multiply(qHnd);

    // 翻腕的一半交给前臂（真人旋前旋后是前臂在转，只转手腕会拧成麻花）
    const axis = new THREE.Vector3(-m, 0, 0); // 前臂长轴（局部）
    const twist = this.twistAbout(handLocal, axis, new THREE.Quaternion());
    const half = new THREE.Quaternion().slerp(twist, 0.5);
    lowerLocal.multiply(half);
    handLocal.premultiply(half.invert());
    lower.quaternion.copy(lowerLocal);
    hand.quaternion.copy(handLocal);
  }

  /** 把一个骨骼的静止朝向（两根正交的方向 a0、b0）转到目标方向 a1、b1，返回世界旋转 */
  private basisRotation(
    a0: THREE.Vector3,
    b0: THREE.Vector3,
    a1: THREE.Vector3,
    b1: THREE.Vector3,
    qRest: THREE.Quaternion,
    out: THREE.Quaternion,
  ) {
    const [m0, m1] = this._m;
    const c0 = new THREE.Vector3().crossVectors(a0, b0);
    const c1 = new THREE.Vector3().crossVectors(a1, b1);
    m0.makeBasis(a0, b0, c0);
    m1.makeBasis(a1, b1, c1);
    m1.multiply(m0.transpose());
    return out.setFromRotationMatrix(m1).multiply(qRest);
  }

  /** 四元数绕某根（局部）轴的扭转分量（swing-twist 分解） */
  private twistAbout(q: THREE.Quaternion, axis: THREE.Vector3, out: THREE.Quaternion) {
    const p = axis.x * q.x + axis.y * q.y + axis.z * q.z;
    out.set(axis.x * p, axis.y * p, axis.z * p, q.w);
    if (out.lengthSq() < 1e-9) return out.identity();
    return out.normalize();
  }

  /** 手腕到中指指根的距离 */
  private palmLength(vrm: VRM) {
    const H = vrm.humanoid;
    const hand = H.getNormalizedBoneNode('rightHand');
    const mcp = H.getNormalizedBoneNode('rightMiddleProximal');
    if (!hand || !mcp) return 0.07;
    return mcp.position.length();
  }

  /**
   * 嘴在哪：从脸前面朝脸打一条射线（眼睛往下约 0.7 个"眼睛到头骨"的距离），打到的脸表面就是嘴。
   * 结果存成头部局部坐标，之后跟着头走。打不到（没有眼睛骨骼、模型很怪）时按比例估一个
   */
  private findMouth(): THREE.Vector3 {
    const vrm = this.vrm!;
    const H = vrm.humanoid;
    const head = H.getNormalizedBoneNode('head')!;
    vrm.scene.updateMatrixWorld(true);
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const qHead = head.getWorldQuaternion(new THREE.Quaternion());
    const m = this.flip;
    const fwd = new THREE.Vector3(0, 0, m).applyQuaternion(qHead);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(qHead);
    const le = H.getRawBoneNode('leftEye');
    const re = H.getRawBoneNode('rightEye');
    const eyes = new THREE.Vector3();
    let eyeH = 0.065;
    if (le && re) {
      eyes.addVectors(le.getWorldPosition(new THREE.Vector3()), re.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
      eyeH = Math.max(0.03, eyes.clone().sub(headPos).dot(up));
    } else eyes.copy(headPos).addScaledVector(up, eyeH);
    const guess = eyes.clone().addScaledVector(up, -0.7 * eyeH);
    const ray = new THREE.Raycaster(guess.clone().addScaledVector(fwd, 0.3), fwd.clone().negate(), 0, 0.45);
    const hits = ray.intersectObject(vrm.scene, true).filter((h) => (h.object as THREE.Mesh).isMesh);
    const hit = hits[0]?.point ?? guess.addScaledVector(fwd, 0.05);
    return head.worldToLocal(hit.clone());
  }
}
