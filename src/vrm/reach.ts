import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { buildContactVolume, type ContactVolume } from './contact';

/**
 * 手部 IK 层（目前只有右手）。
 *
 * 替代了之前"网格搜索关节角度"的做法。那套做法的问题是结构性的：
 *   - 标定对准的是手腕，掌心还要再往外 0.067，手总是冲过头
 *   - 角度只对这一个模型的比例成立，换模型就得重搜
 *   - 头一转，手还停在原来的世界坐标，直接插进脸里
 *   - 关节角度线性插值，手走的是一条不受控的路径，中途会穿过胸口
 *
 * 这里改成游戏里的标准做法：双骨 IK（解析解，和 Unity Animation Rigging 的
 * Two Bone IK Constraint 是同一套数学），每帧求解：
 *   1. 目标定义在**掌心**，挂在锚点骨骼上（头或胸）—— 头动、身体动，手跟着走
 *   2. 先决定手掌朝向，再由"掌心 = 目标"反推手腕该在哪
 *   3. 手腕沿一条绕开身体的贝塞尔弧线接近/撤回，不走直线
 *   4. 肘部由 pole 向量控制，杜绝"肘在脸前"之类的解
 *   5. IK 权重渐入渐出，和下层 FK（idle + 手势 clip）逐骨骼 slerp 混合，
 *      起止两端都精确等于 FK 姿势，不会跳
 *   6. 接触约束（contact-aware IK）：手指、前臂对身体碰撞体做检测。
 *      手指先自己减小弯曲让开（抓握 IK 的做法），让不开再把整只手沿最近的出口推出去。
 *      碰撞体见 contact.ts。
 *
 * 坐标约定：rotateVRM0 之后两种版本的模型在世界空间里都面朝 +Z、左手边为 +X，
 * 所以下面所有"规范空间"的偏移直接就是静止姿态下的世界偏移，不需要 axisFlip。
 * 唯一的例外是手指弯曲：那是骨骼局部旋转，VRM 0.x 要对 Z 取反。
 */

export type ReachAnchor = 'head' | 'upperChest';

export interface ReachSpec {
  /** 目标挂在哪根骨骼上，默认头 */
  anchor?: ReachAnchor;
  /** 掌心目标相对锚点骨骼的偏移（规范空间，米），会跟随锚点旋转 */
  palmOffset: [number, number, number];
  /** 手指指向（规范空间），会跟随锚点旋转 */
  fingerDir: [number, number, number];
  /** 掌心法线（规范空间），指向接触面 */
  palmNormal: [number, number, number];
  /** 肘部 pole 相对肩的偏移（世界空间，米） */
  pole: [number, number, number];
  /**
   * 接近/撤回时弧线中点的偏移，用来绕开身体。
   * 数字 = 向前（+Z）凸出多少；三元组 = 规范空间里的任意偏移（比如摸后颈要往外、往上绕）
   */
  arc: number | [number, number, number];
  /** [开始接近, 到位, 开始撤回, 撤回完成]（秒，相对手势开始） */
  times: [number, number, number, number];
  /** 手指弯曲角度（度）：[近节, 中节, 远节] */
  curl: [number, number, number];
  /** 每根手指的弯曲倍率 [食指, 中指, 无名指, 小指]，默认全 1。握拳时食指可以松一点 */
  curlScale?: [number, number, number, number];
  /**
   * 拇指（度）。默认 0 = 保持下层姿势（放松的拇指偏向掌心一侧约 25mm）。
   *   正值 = 内收，握拳时把拇指收到蜷起的手指前面。不收的话托下巴时拇指直接戳进脖子
   *   负值 = 放平到手掌平面里。手掌平贴胸口时不放平，拇指会先戳进去
   */
  thumb?: number;
  /** 保持阶段的轻微颤动（笑的时候手会跟着抖） */
  bob?: { amp: number; hz: number };
  /** 保持阶段沿某个方向来回蹭（摸后颈），规范空间，米 */
  rub?: { dir: [number, number, number]; amp: number; hz: number };
  /**
   * 离开接触面时先沿掌心法线抬起多少（米），再走撤回路径；接近时对称地最后才落下。
   * 机器人抓取里的 pre-grasp / retreat 位姿是同一个意思。默认 0。
   * 摸后颈需要：手从圆柱形的脖子上横着滑开时，弯着的指尖会越滑越深
   */
  standoff?: number;
}

export interface ActiveReach {
  spec: ReachSpec;
  time: number;
  /** 每次触发一个新对象，用来存这次触发的起点和滤波状态 */
  state: { w0?: THREE.Vector3; curl?: number[]; preshape?: number[] };
}

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;

const smoothstep = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
/**
 * 最小加加速度轨迹（Flash & Hogan, 1985）—— 人类伸手动作最经典的运动学模型。
 *
 * 最初用的是 easeInOutCubic，量出来单帧最大位移 5.8cm（约 3.5 m/s）：
 * 三次缓动在中点的峰值速度是平均速度的 3 倍，手是"甩"上去的。
 * minimum-jerk 的峰值只有平均的 1.875 倍，而且起止两端加速度也为零。
 */
const minimumJerk = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (10 - 15 * t + 6 * t * t);
};

/** 线段到点的最近距离，用于穿模检测 */
export function segmentPointDistance(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

interface Body {
  name: string;
  anchor: ReachAnchor;
  node: THREE.Object3D;
  restQuat: THREE.Quaternion;
  volume: ContactVolume;
}

export class ReachLayer {
  private vrm: VRM | null = null;
  private axisFlip = 1;
  private anchorRest = new Map<ReachAnchor, THREE.Quaternion>();
  private bodies: Body[] = [];
  /** 手掌在手腕局部空间里的几何：掌心位置、手指方向、掌心法线 */
  private palmLocal = new THREE.Vector3();
  private fingerLocal = new THREE.Vector3();
  private normalLocal = new THREE.Vector3();

  /** 手指、前臂离身体表面至少保留的距离（米）。骨骼在关节中心，外面还有一层皮肉 */
  contactMargin = 0.009;
  /** 整只手外推最多几轮。设成 0 可以单独观察手指自适应的效果（调试用） */
  maxPushIters = 4;
  /** 滤波后的手指弯曲最多比"刚好不穿"的值多弯多少（弯曲比例，1 = spec 的完整弯曲） */
  maxCurlLag = 0.12;

  /** 最近一帧的求解结果，供调试和穿模检测读取 */
  readonly debug = {
    weight: 0,
    palmTarget: new THREE.Vector3(),
    headCenter: new THREE.Vector3(),
    /** 接触约束把整只手往外推了多少（米） */
    pushed: 0,
    /** 触发整手外推的是哪个点（调试用） */
    pushedBy: '',
    /** 推完之后剩余的最大穿透（米，含安全距离） */
    penetration: 0,
    triangles: {} as Record<string, number>,
    worst: null as { depth: number; dir: [number, number, number]; at: string } | null,
  };

  bind(vrm: VRM, metaVersion: string | undefined) {
    this.vrm = vrm;
    this.axisFlip = metaVersion === '0' ? -1 : 1;

    // 静止姿态下量一次：锚点朝向，以及手掌的局部几何
    vrm.humanoid.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    const node = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n);
    for (const a of ['head', 'upperChest'] as ReachAnchor[]) {
      const n = node(a);
      if (n) this.anchorRest.set(a, n.getWorldQuaternion(new THREE.Quaternion()));
    }

    const mid = node('rightMiddleProximal');
    const index = node('rightIndexProximal');
    const little = node('rightLittleProximal');
    if (mid && index && little) {
      // 这几根指骨都是 rightHand 的直接子节点，position 就是手腕局部坐标
      this.palmLocal.copy(mid.position);
      this.fingerLocal.copy(mid.position).normalize();
      const across = index.position.clone().sub(little.position);
      // 右手：食指在前、小指在后，cross(横向, 指向) 指向掌心一侧
      this.normalLocal.crossVectors(across, this.fingerLocal).normalize();
    }

    this.buildBodies(vrm);
  }

  /**
   * 三个碰撞体：
   *   头部 —— 头骨 + 颈骨（下巴的蒙皮主要在颈骨上）+ 眼球 + 眼眶辅助骨骼。不含头发：
   *           头骨下挂的是头发弹簧骨，长发垂到腰，会把体积撑得巨大
   *   刘海 —— 额头前面那一块，**含**头发。刘海比额头皮肤往前 9~13mm，手扶额头时
   *           手掌应该压在刘海上，而不是穿进去贴着皮肤。只取额头前方的小盒子，
   *           侧发、后发不在里面：它们是会动的弹簧骨，手从下面伸进去是合理的
   *   躯干 —— 脊柱 + 胸 + 上胸，**含**下挂的弹簧骨：胸前的顶点主骨骼是 J_Sec_*_Bust1
   */
  private buildBodies(vrm: VRM) {
    this.bodies = [];
    const specs: Array<{
      name: string;
      anchor: ReachAnchor;
      bones: VRMHumanBoneName[];
      box: { min: [number, number, number]; max: [number, number, number] };
      secondary: 'all' | 'rigid';
      cell: number;
    }> = [
      {
        name: 'head',
        anchor: 'head',
        bones: ['head', 'neck', 'leftEye', 'rightEye'],
        box: { min: [-0.13, -0.16, -0.16], max: [0.13, 0.18, 0.16] },
        secondary: 'rigid',
        cell: 0.003,
      },
      {
        name: 'bangs',
        anchor: 'head',
        bones: ['head'],
        box: { min: [-0.09, 0.075, 0.03], max: [0.09, 0.19, 0.16] },
        secondary: 'all',
        cell: 0.003,
      },
      {
        name: 'upperChest',
        anchor: 'upperChest',
        bones: ['spine', 'chest', 'upperChest'],
        box: { min: [-0.22, -0.3, -0.2], max: [0.22, 0.16, 0.22] },
        secondary: 'all',
        cell: 0.004,
      },
    ];
    for (const s of specs) {
      const node = vrm.humanoid.getNormalizedBoneNode(s.anchor);
      const rest = this.anchorRest.get(s.anchor);
      if (!node || !rest) continue;
      const volume = buildContactVolume(vrm, s.anchor, s.bones, s.box, s.secondary, s.cell);
      if (!volume) continue;
      this.bodies.push({ name: s.name, anchor: s.anchor, node, restQuat: rest, volume });
      this.debug.triangles[s.name] = volume.triangles;
    }
  }

  /** 调试用：拿到某个碰撞体（head / bangs / upperChest） */
  volume(name: string) {
    return this.bodies.find((b) => b.name === name)?.volume ?? null;
  }

  /**
   * 在 FK 姿势已经写进骨骼之后调用（Character.update 里 acc.flush 之后）。
   * 没有活动的 reach 时什么都不做。
   */
  apply(reach: ActiveReach | null, dt = 1 / 60, snap = false) {
    const vrm = this.vrm;
    this.debug.weight = 0;
    this.debug.pushed = 0;
    this.debug.pushedBy = '';
    this.debug.penetration = 0;
    if (!vrm || !reach) return;

    const { spec, time, state } = reach;
    const [t0, t1, t2, t3] = spec.times;
    if (time <= t0 || time >= t3) return;

    const node = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n);
    const upper = node('rightUpperArm');
    const lower = node('rightLowerArm');
    const hand = node('rightHand');
    const head = node('head');
    const anchorName = spec.anchor ?? 'head';
    const anchor = node(anchorName);
    const anchorRest = this.anchorRest.get(anchorName);
    if (!upper || !lower || !hand || !head || !anchor || !anchorRest) return;

    vrm.scene.updateMatrixWorld(true);

    // ---- 阶段、IK 权重、朝向进度 ----
    // 权重只在两端 35% 的区间里渐变，所以权重还很小时手也还在 FK 位置附近。
    // orient 是手掌朝向的进度，跟着轨迹走而不是跟着权重 ——
    // 否则手会以终点的朝向从下面平移上来，而真人抬手时手腕是边走边转的。
    //
    // grip 是手指弯曲的进度，比 orient 更晚合拢、更早张开。这是伸手抓取（reach-to-grasp）
    // 的经典观察：手在路上是张开的，最后 40% 左右的行程才合拢到目标形状；撤回时先松手。
    // 原来手指跟着 orient 走，路程还剩三分之一时已经弯了 75%，托下巴时弯起来的手指
    // 一路刮着领结和胸口上去（实测 20~30mm），滤波追不上。
    let weight: number;
    let phase: 'in' | 'hold' | 'out';
    let u: number;
    let orient: number;
    let grip: number;
    const setHoldPose = () => {
      phase = 'hold';
      u = 1;
      weight = 1;
      orient = 1;
      grip = 1;
    };
    if (time < t1) {
      phase = 'in';
      u = (time - t0) / (t1 - t0);
      weight = smoothstep(u / 0.35);
      orient = minimumJerk(u);
      grip = minimumJerk((u - 0.4) / 0.6);
    } else if (time <= t2) {
      phase = 'hold';
      u = 1;
      weight = 1;
      orient = 1;
      grip = 1;
    } else {
      phase = 'out';
      u = (time - t2) / (t3 - t2);
      weight = smoothstep((1 - u) / 0.35);
      orient = 1 - minimumJerk(u);
      grip = 1 - minimumJerk(u / 0.6);
    }
    this.debug.weight = weight;

    // ---- FK 快照：每一轮求解都从这里重新开始 ----
    const fingerBones = this.fingerBones(vrm);
    const thumbBones = (['Metacarpal', 'Proximal', 'Distal'] as const)
      .map((sg) => node(`rightThumb${sg}` as VRMHumanBoneName))
      .filter((n): n is THREE.Object3D => !!n);
    const fk = {
      upper: upper.quaternion.clone(),
      lower: lower.quaternion.clone(),
      hand: hand.quaternion.clone(),
      fingers: fingerBones.map((b) => b.bone.quaternion.clone()),
      thumb: thumbBones.map((b) => b.quaternion.clone()),
    };
    const restore = () => {
      upper.quaternion.copy(fk.upper);
      lower.quaternion.copy(fk.lower);
      hand.quaternion.copy(fk.hand);
      fingerBones.forEach((b, i) => b.bone.quaternion.copy(fk.fingers[i]));
      thumbBones.forEach((b, i) => b.quaternion.copy(fk.thumb[i]));
      upper.updateMatrixWorld(true);
    };
    // 拇指内收的旋转轴：在这个 VRM 0.x 模型上实测，绕局部 -X 是往掌心屈、绕 -Y 是往
    // 食指那边收，握拳要两者都有。VRM 1.0 的 X 轴方向相反，所以 X 分量乘 axisFlip
    const thumbAxis = new THREE.Vector3(this.axisFlip, -1, 0).normalize();
    const thumbQ = new THREE.Quaternion();
    const applyThumb = () => {
      if (!spec.thumb) return;
      const rad = THREE.MathUtils.degToRad(spec.thumb * weight * grip);
      thumbBones.forEach((b, i) => {
        b.quaternion.copy(fk.thumb[i]).multiply(thumbQ.setFromAxisAngle(thumbAxis, rad * [1, 0.7, 0.4][i]));
      });
      hand.updateMatrixWorld(true);
    };
    const S = upper.getWorldPosition(new THREE.Vector3());
    const E0 = lower.getWorldPosition(new THREE.Vector3());
    const fkWrist = hand.getWorldPosition(new THREE.Vector3());
    const fkHandWorld = hand.getWorldQuaternion(new THREE.Quaternion());
    const a = E0.distanceTo(S);
    const b = fkWrist.distanceTo(E0);

    // ---- 目标：挂在锚点上 ----
    const anchorPos = anchor.getWorldPosition(new THREE.Vector3());
    const delta = anchor
      .getWorldQuaternion(new THREE.Quaternion())
      .multiply(anchorRest.clone().invert());
    const v3 = (x: [number, number, number]) => new THREE.Vector3(...x);
    const inAnchor = (x: [number, number, number]) => v3(x).applyQuaternion(delta);

    const palmTarget = anchorPos.clone().add(inAnchor(spec.palmOffset));
    // 保持段的颤动 / 来回蹭。撤回时振幅渐隐而不是直接停：直接停的话目标会在撤回第一帧
    // 跳回原点，跳多少取决于那一刻正弦走到哪（摸后颈实测约 5mm，还会连带手指撞上脖子）
    const envelope = phase === 'hold' ? 1 : phase === 'out' ? 1 - smoothstep(u / 0.4) : 0;
    if (envelope > 0) {
      const th = time - t1;
      if (spec.bob) palmTarget.y += envelope * spec.bob.amp * Math.sin(th * Math.PI * 2 * spec.bob.hz);
      if (spec.rub) {
        palmTarget.addScaledVector(
          inAnchor(spec.rub.dir).normalize(),
          envelope * spec.rub.amp * Math.sin(th * Math.PI * 2 * spec.rub.hz),
        );
      }
    }
    const headDelta = head
      .getWorldQuaternion(new THREE.Quaternion())
      .multiply((this.anchorRest.get('head') ?? new THREE.Quaternion()).clone().invert());
    this.debug.headCenter
      .copy(head.getWorldPosition(new THREE.Vector3()))
      .add(new THREE.Vector3(0, 0.06, 0.01).applyQuaternion(headDelta));

    // ---- 手掌朝向 ----
    const fDesired = inAnchor(spec.fingerDir).normalize();
    const nDesired = inAnchor(spec.palmNormal);
    nDesired.addScaledVector(fDesired, -nDesired.dot(fDesired)).normalize();
    const handWorldQuat = quatFromBasis(this.fingerLocal, this.normalLocal, fDesired, nDesired);

    const arc =
      typeof spec.arc === 'number' ? new THREE.Vector3(0, 0, spec.arc) : inAnchor(spec.arc);

    // 抬起 / 落下：沿掌心法线的反方向（离开接触面）偏移目标。
    // 预成形要按真正的接触位置算，所以先留一份没抬起的
    const contactTarget = palmTarget.clone();
    if (spec.standoff) {
      const lift =
        phase === 'in'
          ? 1 - smoothstep((u - 0.6) / 0.4)
          : phase === 'out'
            ? smoothstep(u / 0.3)
            : 0;
      palmTarget.addScaledVector(nDesired, -spec.standoff * lift);
    }

    /** 按给定的掌心目标解一遍手臂：IK → 手掌朝向 → 和 FK 混合（手指另算） */
    const solve = (palm: THREE.Vector3) => {
      restore();
      const wristTarget = palm.clone().sub(this.palmLocal.clone().applyQuaternion(handWorldQuat));

      let W: THREE.Vector3;
      if (phase === 'in') {
        if (!state.w0) state.w0 = fkWrist.clone();
        W = bezier(state.w0, wristTarget, arc, minimumJerk(u));
      } else if (phase === 'out') {
        // 撤回终点用当前帧的 FK 位置，idle 在动也能接得上
        W = bezier(wristTarget, fkWrist, arc, minimumJerk(u));
      } else {
        W = wristTarget;
      }

      // 双骨 IK
      const toT = W.clone().sub(S);
      const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
      const dir = toT.normalize();
      const toP = v3(spec.pole);
      const bend = toP.addScaledVector(dir, -toP.dot(dir)).normalize();
      // 右肘永远不往身体内侧拐。pole 只是个方向：手腕伸得比 pole 更靠外时，pole 的
      // 垂直分量会指向身体内侧（手贴脸颊撤回的半路上实测肘部 10 帧内从 x=-0.19 跳到
      // -0.07，插进了躯干）。这里一旦朝内就连续地往"朝外"那边拧，不会有跳变。
      // 所有右手动作设计上肘部都朝外（bend.x ≤ -0.25），正常情况下这段不起作用
      const inward = bend.x + 0.25;
      if (inward > 0) {
        const out = new THREE.Vector3(-1, 0, 0).addScaledVector(dir, dir.x).normalize();
        bend.addScaledVector(out, inward * 4).addScaledVector(dir, -bend.dot(dir)).normalize();
      }
      const cosA = (a * a + d * d - b * b) / (2 * a * d);
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      const elbowTarget = S.clone().addScaledVector(dir, a * cosA).addScaledVector(bend, a * sinA);
      const wristReach = S.clone().addScaledVector(dir, d);

      aimBone(upper, E0.clone().sub(S), elbowTarget.clone().sub(S));
      const E2 = lower.getWorldPosition(new THREE.Vector3());
      const W2 = hand.getWorldPosition(new THREE.Vector3());
      aimBone(lower, W2.clone().sub(E2), wristReach.clone().sub(E2));
      setWorldQuaternion(hand, fkHandWorld.clone().slerp(handWorldQuat, orient));

      // 和 FK 逐骨骼混合
      upper.quaternion.copy(fk.upper.clone().slerp(upper.quaternion, weight));
      lower.quaternion.copy(fk.lower.clone().slerp(lower.quaternion, weight));
      hand.quaternion.copy(fk.hand.clone().slerp(hand.quaternion, weight));
      upper.updateMatrixWorld(true);
      applyThumb();
    };

    // ---- 手指：每根单独弯曲 ----
    const chains = this.fingerChains(vrm);
    const curlQ = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    /** 给某根手指（0..3 = 食指..小指）设弯曲比例，s=1 是 spec 的完整弯曲，负值是略微反翘 */
    const applyCurl = (finger: number, scale: number) => {
      for (const fb of fingerBones) {
        if (fb.finger !== finger) continue;
        const per = spec.curlScale?.[fb.finger] ?? 1;
        const rad =
          THREE.MathUtils.degToRad(spec.curl[fb.seg] * fb.spread * per * weight * grip * scale) *
          this.axisFlip;
        fb.bone.quaternion.copy(fk.fingers[fb.index]).multiply(curlQ.setFromAxisAngle(zAxis, rad));
      }
      hand.updateMatrixWorld(true);
    };

    // ---- 碰撞检测：一个世界坐标点对所有碰撞体 ----
    const bodies = this.bodies.map((body) => {
      const d = body.node
        .getWorldQuaternion(new THREE.Quaternion())
        .multiply(body.restQuat.clone().invert());
      return {
        body,
        pos: body.node.getWorldPosition(new THREE.Vector3()),
        delta: d,
        inv: d.clone().invert(),
      };
    });
    const tmp = new THREE.Vector3();
    const hitAt = (world: THREE.Vector3) => {
      let best: { depth: number; dir: THREE.Vector3 } | null = null;
      for (const x of bodies) {
        tmp.copy(world).sub(x.pos).applyQuaternion(x.inv);
        const h = x.body.volume.query(tmp, this.contactMargin);
        if (h && (!best || h.depth > best.depth)) {
          best = { depth: h.depth, dir: h.dir.applyQuaternion(x.delta) };
        }
      }
      return best;
    };
    /**
     * 一条骨骼链上要检查的点：每个关节，再外推一个指尖 ——
     * VRM 没有指尖骨骼，远节指骨只到最后一个关节，指尖要再往外延一点。
     */
    const chainPoints = (chain: THREE.Object3D[]) => {
      const pts = chain.map((n) => n.getWorldPosition(new THREE.Vector3()));
      if (pts.length >= 2) pts.push(pts[pts.length - 1].clone().lerp(pts[pts.length - 2], -0.8));
      return pts;
    };
    const chainPenetration = (chain: THREE.Object3D[]) => {
      let worst = 0;
      for (const p of chainPoints(chain)) worst = Math.max(worst, hitAt(p)?.depth ?? 0);
      return worst;
    };
    /** 前臂上取几个点：手指让不开的时候，前臂也不能穿 */
    const armPoints = () => {
      const E = lower.getWorldPosition(new THREE.Vector3());
      const W = hand.getWorldPosition(new THREE.Vector3());
      return [0.35, 0.65, 1].map((t) => E.clone().lerp(W, t));
    };
    /** 整只手里最深的那个点：深度 + 推出方向 + 是哪个点（调试用） */
    const FINGER_NAMES = ['拇指', '食指', '中指', '无名指', '小指'];
    const worstHit = () => {
      let best: { depth: number; dir: THREE.Vector3; at: string } | null = null;
      const pts: Array<[string, THREE.Vector3]> = [
        ...chains.flatMap((c) =>
          chainPoints(c.bones).map((p, i) => [`${FINGER_NAMES[c.finger + 1]}${i}`, p] as [string, THREE.Vector3]),
        ),
        ...armPoints().map((p, i) => [`前臂${i}`, p] as [string, THREE.Vector3]),
      ];
      for (const [at, p] of pts) {
        const h = hitAt(p);
        if (h && (!best || h.depth > best.depth)) best = { ...h, at };
      }
      return best;
    };

    /**
     * 手指自适应（抓握 IK 的做法）：每根手指单独二分出"不穿模的最大弯曲"，
     * 指尖刚好贴在表面。弯曲越大指尖越靠近掌心 —— 也就是越靠近接触面 ——
     * 所以穿透量随弯曲单调，二分是成立的。
     *
     * 二分只给出"允许的弯曲"，实际施加的值要经过时间滤波。不滤波的话，
     * 手指刚碰到脸的那一帧允许值会骤降，实测指尖一帧跳 18mm（正常弯曲每帧 2~3mm）。
     * 滤波上下不对称：松开（避开穿模）快，60ms；弯回去慢，250ms。
     * snap（拖时间轴时）直接用允许值，保证每一帧都是确定的结果。
     */
    const curlState = state.curl ?? (state.curl = []);
    /**
     * @param filtered 是否施加时间滤波。
     *   决定"要不要整只手外推"时必须用 false（理想值）：滤波后的手指每帧只能慢慢松开，
     *   这一帧还没来得及松开就会被误判成"让不开"，于是整只手被推出去；手被推远后手指
     *   又有了空间，下一帧再弯回来 —— 最后稳定在"手被推开 4cm、手指弯着"的错误状态。
     *   实测掩嘴笑因此被外推了 36~42mm，而关掉外推时保持段根本没有穿模。
     *   只有最终写到画面上的那一次才用滤波。
     */
    const adaptFingers = (commit: boolean, filtered: boolean) => {
      const ideal: number[] = [];
      chains.forEach((c) => {
        if (c.finger < 0) return; // 拇指不参与弯曲
        // 上限是预成形算出来的最终弯曲：接近途中手指就朝这个形状走，不会弯过头
        const cap = state.preshape?.[c.finger] ?? 1;
        let allowed = cap;
        applyCurl(c.finger, cap);
        if (chainPenetration(c.bones) > 1e-4) {
          let lo = -0.4;
          let hi = cap;
          for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) / 2;
            applyCurl(c.finger, mid);
            if (chainPenetration(c.bones) <= 1e-4) lo = mid;
            else hi = mid;
          }
          allowed = lo;
        }
        ideal[c.finger] = allowed;
        const prev = curlState[c.finger];
        let applied = allowed;
        if (filtered && !snap && prev !== undefined) {
          const tau = allowed < prev ? 0.06 : 0.25;
          applied = prev + (allowed - prev) * (1 - Math.exp(-dt / tau));
          // 滤波只负责平滑，不能拿穿模换平滑：最多比允许值多弯 maxCurlLag。
          // 手擦着身体快速经过时允许值一帧掉很多，纯滤波会落后好几帧（托下巴实测 40mm）
          applied = Math.min(applied, allowed + this.maxCurlLag);
        }
        if (commit) curlState[c.finger] = applied;
        applyCurl(c.finger, applied);
      });
      return ideal;
    };

    // ---- 手部预成形（anticipatory hand preshaping）----
    // 每次触发只算一次：在最终的接触姿势上，每根手指该弯多少。接近途中手指按 grip
    // 逐步变成这个形状，到位时已经是对的形状，逐帧约束基本不会被触发。
    //
    // 没有这一步的话，手指要等碰到脸才开始缩：允许的弯曲在到位前几帧骤降，滤波追不上，
    // 实测到位那一刻手指可见地陷进脸 9.3mm；而把滤波调快又会回到手指弹跳。
    // 这也是动作科学里对人类伸手的描述：手指在接触之前就已经按目标调整好了形状。
    if (!state.preshape) {
      const saved = { phase, u, weight, orient, grip };
      setHoldPose();
      solve(contactTarget);
      state.preshape = adaptFingers(false, false);
      ({ phase, u, weight, orient, grip } = saved);
    }

    // ---- 求解 + 接触约束 ----
    // 先让手指自己让开；只有手指伸直了还穿（通常是指根、拇指或前臂），
    // 才把整只手沿最近的出口推出去。只用"整只手外推"的话，掩嘴笑会只因为指尖
    // 戳到鼻子，就把手掌也推离嘴唇 26mm，悬空在脸前面。
    solve(palmTarget);
    adaptFingers(false, false);
    let pushed = 0;
    for (let iter = 0; iter < this.maxPushIters; iter++) {
      const h = worstHit();
      if (!h || h.depth <= 1e-4) break;
      if (iter === 0) this.debug.pushedBy = h.at;
      palmTarget.addScaledVector(h.dir, h.depth);
      pushed += h.depth;
      solve(palmTarget);
      adaptFingers(false, false);
    }
    // 手臂位置定下来之后，手指才按滤波后的值落到画面上，并写回滤波状态
    adaptFingers(true, true);
    this.debug.pushed = pushed;
    const last = worstHit();
    this.debug.penetration = last?.depth ?? 0;
    this.debug.worst = last
      ? { depth: last.depth, dir: last.dir.toArray() as [number, number, number], at: last.at }
      : null;
    this.debug.palmTarget.copy(palmTarget);
  }

  private fingerBones(vrm: VRM) {
    const out: Array<{
      bone: THREE.Object3D;
      finger: number;
      seg: number;
      spread: number;
      index: number;
    }> = [];
    FINGERS.forEach((f, fi) => {
      SEGMENTS.forEach((sg, si) => {
        const bone = vrm.humanoid.getNormalizedBoneNode(`right${f}${sg}` as VRMHumanBoneName);
        // 小指比食指弯得多一点，更像放松的手
        if (bone) out.push({ bone, finger: fi, seg: si, spread: 1 + fi * 0.12, index: out.length });
      });
    });
    return out;
  }

  /** 每根手指的骨骼链，用于穿透检测。finger = -1 是拇指（不参与弯曲自适应） */
  private fingerChains(vrm: VRM) {
    const chains: Array<{ finger: number; bones: THREE.Object3D[] }> = [];
    ['Thumb', ...FINGERS].forEach((f, i) => {
      const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : SEGMENTS;
      const bones = segs
        .map((sg) => vrm.humanoid.getNormalizedBoneNode(`right${f}${sg}` as VRMHumanBoneName))
        .filter((n): n is THREE.Object3D => !!n);
      if (bones.length) chains.push({ finger: i - 1, bones });
    });
    return chains;
  }
}

/** 找一个旋转，把局部的 (f, n) 基对齐到世界的 (f*, n*) 基 */
function quatFromBasis(
  fLocal: THREE.Vector3,
  nLocal: THREE.Vector3,
  fWorld: THREE.Vector3,
  nWorld: THREE.Vector3,
) {
  const n0 = nLocal.clone().addScaledVector(fLocal, -nLocal.dot(fLocal)).normalize();
  const local = new THREE.Matrix4().makeBasis(fLocal, n0, fLocal.clone().cross(n0));
  const world = new THREE.Matrix4().makeBasis(fWorld, nWorld, fWorld.clone().cross(nWorld));
  // R · local = world  →  R = world · localᵀ
  return new THREE.Quaternion().setFromRotationMatrix(world.multiply(local.transpose()));
}

/** 二次贝塞尔：中点偏移 arc，让手绕开身体 */
function bezier(from: THREE.Vector3, to: THREE.Vector3, arc: THREE.Vector3, t: number) {
  const ctrl = from.clone().lerp(to, 0.5).add(arc);
  const a = from.clone().lerp(ctrl, t);
  const b = ctrl.clone().lerp(to, t);
  return a.lerp(b, t);
}

/** 以最小旋转把骨骼当前指向 from 转到 to（世界空间），写回局部旋转 */
function aimBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  setWorldQuaternion(bone, delta.multiply(world));
}

function setWorldQuaternion(bone: THREE.Object3D, world: THREE.Quaternion) {
  const parentWorld = bone.parent
    ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
    : new THREE.Quaternion();
  bone.quaternion.copy(parentWorld.invert().multiply(world));
  bone.updateMatrixWorld(true);
}
