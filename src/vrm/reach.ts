import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * 手到脸的 IK 层（目前只有右手）。
 *
 * 替代了之前"网格搜索关节角度"的做法。那套做法的问题是结构性的：
 *   - 标定对准的是手腕，掌心还要再往外 0.067，手总是冲过头
 *   - 角度只对这一个模型的比例成立，换模型就得重搜
 *   - 头一转，手还停在原来的世界坐标，直接插进脸里
 *   - 关节角度线性插值，手走的是一条不受控的路径，中途会穿过胸口
 *
 * 这里改成游戏里的标准做法：双骨 IK（解析解，和 Unity Animation Rigging 的
 * Two Bone IK Constraint 是同一套数学），每帧求解：
 *   1. 目标定义在**掌心**，挂在头部骨骼上 —— 头点头、歪头，手跟着走
 *   2. 先决定手掌朝向，再由"掌心 = 目标"反推手腕该在哪
 *   3. 手腕沿一条向前绕开胸口的贝塞尔弧线接近/撤回，不走直线
 *   4. 肘部由 pole 向量控制朝外朝下，杜绝"肘在脸前"的解
 *   5. IK 权重渐入渐出，和下层 FK（idle + 手势 clip）逐骨骼 slerp 混合，
 *      起止两端都精确等于 FK 姿势，不会跳
 *   6. 手指接触约束：IK 只管掌心，手指是按固定角度弯的，完全不知道脸在哪 ——
 *      第一版掩嘴笑的中指、无名指直接戳进了鼻子。现在求解后检查每根手指的
 *      关节和指尖，陷进脸就把整只手沿脸的法线往外推、再重解（contact-aware IK）
 *
 * 坐标约定：rotateVRM0 之后两种版本的模型在世界空间里都面朝 +Z、左手边为 +X，
 * 所以下面所有"规范空间"的偏移直接就是静止姿态下的世界偏移，不需要 axisFlip。
 * 唯一的例外是手指弯曲：那是骨骼局部旋转，VRM 0.x 要对 Z 取反。
 */

export interface ReachSpec {
  /** 掌心目标相对头部骨骼的偏移（规范空间，米），会跟随头部旋转 */
  palmOffset: [number, number, number];
  /** 手指指向（规范空间），会跟随头部旋转 */
  fingerDir: [number, number, number];
  /** 掌心法线（规范空间），指向脸 */
  palmNormal: [number, number, number];
  /** 肘部 pole 相对肩的偏移（世界空间，米） */
  pole: [number, number, number];
  /** 接近/撤回时弧线的前凸量（米），用来绕开胸口 */
  arc: number;
  /** [开始接近, 到位, 开始撤回, 撤回完成]（秒，相对手势开始） */
  times: [number, number, number, number];
  /** 手指弯曲角度（度）：[近节, 中节, 远节] */
  curl: [number, number, number];
  /** 保持阶段的轻微颤动（笑的时候手会跟着抖） */
  bob?: { amp: number; hz: number };
}

export interface ActiveReach {
  spec: ReachSpec;
  time: number;
  /** 每次触发一个新对象，用来存这次触发的起点 */
  state: { w0?: THREE.Vector3 };
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
 * minimum-jerk 的峰值只有平均的 1.875 倍，而且起止两端加速度也为零，
 * 视觉上就是"不慌不忙地抬手"。
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

/**
 * 脸部深度图：头部局部坐标系下，每个 (x, y) 处脸表面最凸出的 z。
 *
 * 为什么不用球/椭球碰撞体：穿模恰恰发生在鼻子上，而鼻子是椭球包不住的凸起。
 * 为什么不每帧对网格做射线检测：模型有 77 个蒙皮网格，每帧做太重。
 * 深度图在加载时栅格化一次，运行时只是查表，而且能精确捕捉鼻子。
 */
class FaceDepthMap {
  // 覆盖范围：相对头部骨骼，x ±0.11，y -0.14 ~ +0.14（米），3mm 一格
  readonly x0 = -0.11;
  readonly y0 = -0.14;
  readonly cell = 0.003;
  readonly nx = Math.ceil(0.22 / 0.003);
  readonly ny = Math.ceil(0.28 / 0.003);
  readonly depth = new Float32Array(this.nx * this.ny).fill(-Infinity);
  triangles = 0;

  /** 把一个三角形（头部局部坐标）光栅化进深度图，只保留每格最大的 z */
  raster(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    const minX = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - this.x0) / this.cell));
    const maxX = Math.min(this.nx - 1, Math.ceil((Math.max(a.x, b.x, c.x) - this.x0) / this.cell));
    const minY = Math.max(0, Math.floor((Math.min(a.y, b.y, c.y) - this.y0) / this.cell));
    const maxY = Math.min(this.ny - 1, Math.ceil((Math.max(a.y, b.y, c.y) - this.y0) / this.cell));
    if (minX > maxX || minY > maxY) return;
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) return;
    this.triangles++;
    for (let iy = minY; iy <= maxY; iy++) {
      const py = this.y0 + (iy + 0.5) * this.cell;
      for (let ix = minX; ix <= maxX; ix++) {
        const px = this.x0 + (ix + 0.5) * this.cell;
        const w1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / den;
        const w2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / den;
        const w3 = 1 - w1 - w2;
        // 稍微放宽边界，避免相邻三角形之间漏格
        if (w1 < -0.02 || w2 < -0.02 || w3 < -0.02) continue;
        const z = w1 * a.z + w2 * b.z + w3 * c.z;
        const k = iy * this.nx + ix;
        if (z > this.depth[k]) this.depth[k] = z;
      }
    }
  }

  /** 该处脸表面的 z；不在脸的覆盖范围内返回 null（那里没有东西可穿） */
  surface(x: number, y: number): number | null {
    const ix = Math.floor((x - this.x0) / this.cell);
    const iy = Math.floor((y - this.y0) / this.cell);
    if (ix < 0 || iy < 0 || ix >= this.nx || iy >= this.ny) return null;
    const d = this.depth[iy * this.nx + ix];
    return Number.isFinite(d) ? d : null;
  }
}

export class ReachLayer {
  private vrm: VRM | null = null;
  private axisFlip = 1;
  private headRestQuat = new THREE.Quaternion();
  /** 手掌在手腕局部空间里的几何：掌心位置、手指方向、掌心法线 */
  private palmLocal = new THREE.Vector3();
  private fingerLocal = new THREE.Vector3();
  private normalLocal = new THREE.Vector3();

  private face = new FaceDepthMap();
  /** 手指离脸表面至少保留的距离（米）。指骨在关节中心，外面还有一层皮肉 */
  contactMargin = 0.009;

  /** 最近一帧的求解结果，供调试和穿模检测读取 */
  readonly debug = {
    weight: 0,
    palmTarget: new THREE.Vector3(),
    headCenter: new THREE.Vector3(),
    /** 接触约束把手往外推了多少（米） */
    pushed: 0,
    /** 推完之后剩余的最大穿透（米），应当为 0 */
    penetration: 0,
    faceTriangles: 0,
  };

  bind(vrm: VRM, metaVersion: string | undefined) {
    this.vrm = vrm;
    this.axisFlip = metaVersion === '0' ? -1 : 1;

    // 静止姿态下量一次：头部朝向，以及手掌的局部几何
    vrm.humanoid.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    const node = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n);
    node('head')?.getWorldQuaternion(this.headRestQuat);

    const mid = node('rightMiddleProximal');
    const index = node('rightIndexProximal');
    const little = node('rightLittleProximal');
    if (mid && index && little) {
      // 这几根指骨都是 rightHand 的直接子节点，position 就是手腕局部坐标
      this.palmLocal.copy(mid.position);
      this.fingerLocal.copy(mid.position).normalize();
      const across = index.position.clone().sub(little.position);
      // 右手：食指在前、小指在后，cross(横向, 指向) 指向掌心一侧（推导见提交说明）
      this.normalLocal.crossVectors(across, this.fingerLocal).normalize();
    }

    this.buildFaceDepth(vrm);
  }

  /**
   * 在静止姿态下，把"主要绑定在头骨上的三角形"栅格化成深度图。
   * 用绑定关系而不是网格名字来挑三角形 —— 换个模型网格名不一样也能用。
   */
  private buildFaceDepth(vrm: VRM) {
    this.face = new FaceDepthMap();
    const rawHead = vrm.humanoid.getRawBoneNode('head');
    const normHead = vrm.humanoid.getNormalizedBoneNode('head');
    if (!rawHead || !normHead) return;
    const headPos = normHead.getWorldPosition(new THREE.Vector3());
    // 注意：这里**不能**用头骨的静止世界旋转去转坐标。VRM 0.x 整体被 rotateVRM0
    // 转了 180°，那个旋转会把 x、z 一起翻过来 —— 第一版就是这么写的，结果栅格化出来
    // 的是后脑勺的头发，查询时和脸对不上，穿透量虚高到 40mm。
    // 静止姿态下"规范空间 = 世界空间"，只需要减去头骨位置；运行时再用相对静止
    // 姿态的旋转（headDelta）把点转回来，两边才在同一个坐标系里。

    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const local = (mesh: THREE.SkinnedMesh, i: number, out: THREE.Vector3) => {
      mesh.getVertexPosition(i, out);
      return mesh.localToWorld(out).sub(headPos);
    };

    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
      const headIdx = mesh.skeleton.bones.indexOf(rawHead as THREE.Bone);
      if (headIdx < 0) return;
      const g = mesh.geometry;
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      if (!si || !sw) return;

      const onHead = (v: number) => {
        let w = 0;
        for (let k = 0; k < 4; k++) if (si.getComponent(v, k) === headIdx) w += sw.getComponent(v, k);
        return w > 0.5;
      };
      const index = g.getIndex();
      const count = index ? index.count : g.getAttribute('position').count;
      for (let t = 0; t + 2 < count; t += 3) {
        const i0 = index ? index.getX(t) : t;
        const i1 = index ? index.getX(t + 1) : t + 1;
        const i2 = index ? index.getX(t + 2) : t + 2;
        if (!onHead(i0) || !onHead(i1) || !onHead(i2)) continue;
        this.face.raster(local(mesh, i0, va), local(mesh, i1, vb), local(mesh, i2, vc));
      }
    });
    this.debug.faceTriangles = this.face.triangles;
  }

  /**
   * 在 FK 姿势已经写进骨骼之后调用（Character.update 里 acc.flush 之后）。
   * 没有活动的 reach 时什么都不做。
   */
  apply(reach: ActiveReach | null) {
    const vrm = this.vrm;
    this.debug.weight = 0;
    this.debug.pushed = 0;
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
    if (!upper || !lower || !hand || !head) return;

    vrm.scene.updateMatrixWorld(true);

    // ---- 阶段、IK 权重、朝向进度 ----
    // 权重只在两端 35% 的区间里渐变，所以权重还很小时手也还在 FK 位置附近。
    // orient 是手掌朝向/手指弯曲的进度，跟着轨迹走而不是跟着权重 ——
    // 否则手会以"捂嘴"的朝向从下面平移上来，而真人抬手时手腕是边走边转的。
    let weight: number;
    let phase: 'in' | 'hold' | 'out';
    let u: number;
    let orient: number;
    if (time < t1) {
      phase = 'in';
      u = (time - t0) / (t1 - t0);
      weight = smoothstep(u / 0.35);
      orient = minimumJerk(u);
    } else if (time <= t2) {
      phase = 'hold';
      u = 1;
      weight = 1;
      orient = 1;
    } else {
      phase = 'out';
      u = (time - t2) / (t3 - t2);
      weight = smoothstep((1 - u) / 0.35);
      orient = 1 - minimumJerk(u);
    }
    this.debug.weight = weight;

    // ---- FK 快照：每一轮求解都从这里重新开始 ----
    const fingerBones = this.fingerBones(vrm);
    const fk = {
      upper: upper.quaternion.clone(),
      lower: lower.quaternion.clone(),
      hand: hand.quaternion.clone(),
      fingers: fingerBones.map((b) => b.bone.quaternion.clone()),
    };
    const restore = () => {
      upper.quaternion.copy(fk.upper);
      lower.quaternion.copy(fk.lower);
      hand.quaternion.copy(fk.hand);
      fingerBones.forEach((b, i) => b.bone.quaternion.copy(fk.fingers[i]));
      upper.updateMatrixWorld(true);
    };
    const S = upper.getWorldPosition(new THREE.Vector3());
    const E0 = lower.getWorldPosition(new THREE.Vector3());
    const fkWrist = hand.getWorldPosition(new THREE.Vector3());
    const fkHandWorld = hand.getWorldQuaternion(new THREE.Quaternion());
    const a = E0.distanceTo(S);
    const b = fkWrist.distanceTo(E0);

    // ---- 目标：挂在头上 ----
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const headQuat = head.getWorldQuaternion(new THREE.Quaternion());
    const headDelta = headQuat.clone().multiply(this.headRestQuat.clone().invert());
    const toHead = headDelta.clone().invert();
    const v3 = (x: [number, number, number]) => new THREE.Vector3(...x);

    const palmTarget = headPos.clone().add(v3(spec.palmOffset).applyQuaternion(headDelta));
    if (spec.bob && phase === 'hold') {
      palmTarget.y += spec.bob.amp * Math.sin((time - t1) * Math.PI * 2 * spec.bob.hz);
    }
    this.debug.headCenter
      .copy(headPos)
      .add(new THREE.Vector3(0, 0.06, 0.01).applyQuaternion(headDelta));
    const faceForward = new THREE.Vector3(0, 0, 1).applyQuaternion(headDelta);

    // ---- 手掌朝向 ----
    const fDesired = v3(spec.fingerDir).applyQuaternion(headDelta).normalize();
    const nDesired = v3(spec.palmNormal).applyQuaternion(headDelta);
    nDesired.addScaledVector(fDesired, -nDesired.dot(fDesired)).normalize();
    const handWorldQuat = quatFromBasis(this.fingerLocal, this.normalLocal, fDesired, nDesired);

    /** 按给定的掌心目标跑一遍完整管线：IK → 和 FK 混合 → 手指弯曲 */
    const solve = (palm: THREE.Vector3) => {
      restore();
      const wristTarget = palm.clone().sub(this.palmLocal.clone().applyQuaternion(handWorldQuat));

      let W: THREE.Vector3;
      if (phase === 'in') {
        if (!state.w0) state.w0 = fkWrist.clone();
        W = bezier(state.w0, wristTarget, spec.arc, minimumJerk(u));
      } else if (phase === 'out') {
        // 撤回终点用当前帧的 FK 位置，idle 在动也能接得上
        W = bezier(wristTarget, fkWrist, spec.arc, minimumJerk(u));
      } else {
        W = wristTarget;
      }

      // 双骨 IK
      const toT = W.clone().sub(S);
      const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
      const dir = toT.normalize();
      const toP = v3(spec.pole);
      const bend = toP.addScaledVector(dir, -toP.dot(dir)).normalize();
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

      // 手指微曲：伸直的手指是"机械臂感"的主要来源之一
      const curlQ = new THREE.Quaternion();
      const zAxis = new THREE.Vector3(0, 0, 1);
      for (const fb of fingerBones) {
        const rad =
          THREE.MathUtils.degToRad(spec.curl[fb.seg] * fb.spread * weight * orient) * this.axisFlip;
        fb.bone.quaternion.multiply(curlQ.setFromAxisAngle(zAxis, rad));
      }
      upper.updateMatrixWorld(true);
    };

    /**
     * 最深的手指穿透量（米）。检查每根手指的三个关节，再外推一个指尖 ——
     * VRM 没有指尖骨骼，远节指骨只到最后一个关节，指尖要再往外延一点。
     */
    const penetration = () => {
      let worst = 0;
      const p = new THREE.Vector3();
      const check = (world: THREE.Vector3) => {
        p.copy(world).sub(headPos).applyQuaternion(toHead);
        const z = this.face.surface(p.x, p.y);
        if (z === null) return;
        // 只管脸前方附近的点。远在脸后面的点是在头侧或头后，不属于这张深度图
        if (p.z < z - 0.05) return;
        worst = Math.max(worst, z + this.contactMargin - p.z);
      };
      for (const chain of this.fingerChains(vrm)) {
        const pts = chain.map((n) => n.getWorldPosition(new THREE.Vector3()));
        pts.forEach(check);
        if (pts.length >= 2) {
          const n = pts.length;
          check(pts[n - 1].clone().lerp(pts[n - 2], -0.8));
        }
      }
      return worst;
    };

    // ---- 求解 + 接触约束 ----
    // 陷进脸就沿脸的法线把掌心目标往外推，再整套重解。三轮足够收敛：
    // 手是刚体地往外平移，穿透量基本线性下降。
    solve(palmTarget);
    let pushed = 0;
    for (let iter = 0; iter < 3; iter++) {
      const pen = penetration();
      if (pen <= 1e-4) break;
      palmTarget.addScaledVector(faceForward, pen);
      pushed += pen;
      solve(palmTarget);
    }
    this.debug.pushed = pushed;
    this.debug.penetration = penetration();
    this.debug.palmTarget.copy(palmTarget);
  }

  private fingerBones(vrm: VRM) {
    const out: Array<{ bone: THREE.Object3D; seg: number; spread: number }> = [];
    FINGERS.forEach((f, fi) => {
      SEGMENTS.forEach((sg, si) => {
        const bone = vrm.humanoid.getNormalizedBoneNode(`right${f}${sg}` as VRMHumanBoneName);
        // 小指比食指弯得多一点，更像放松的手
        if (bone) out.push({ bone, seg: si, spread: 1 + fi * 0.12 });
      });
    });
    return out;
  }

  /** 每根手指（含拇指）从根到末节的骨骼链，用于穿透检测 */
  private fingerChains(vrm: VRM) {
    const chains: THREE.Object3D[][] = [];
    for (const f of ['Thumb', ...FINGERS]) {
      const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : SEGMENTS;
      const chain = segs
        .map((sg) => vrm.humanoid.getNormalizedBoneNode(`right${f}${sg}` as VRMHumanBoneName))
        .filter((n): n is THREE.Object3D => !!n);
      if (chain.length) chains.push(chain);
    }
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

/** 二次贝塞尔：中点向前（+Z）凸出 arc，让手绕开胸口 */
function bezier(from: THREE.Vector3, to: THREE.Vector3, arc: number, t: number) {
  const ctrl = from.clone().lerp(to, 0.5);
  ctrl.z += arc;
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
