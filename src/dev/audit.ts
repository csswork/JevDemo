import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Runtime } from '../runtime';
import type { Emotion, GestureId } from '../act/schema';
import { GESTURE_CLIPS } from '../vrm/gestures';

/**
 * 手势审计（仅 dev）。控制台里 `__audit('cover_mouth_laugh', { happy: 0.9 })`。
 *
 * 逐帧（1/60 秒）把一个手势从头跑到尾，给出一组可以横向比较的数字：
 *
 *   整手外推      接触约束把整只手推离目标多远。大了说明手悬空，不像在碰
 *   自评穿透      约束自己的碰撞体认为还剩多少穿透（含 9mm 安全距离）
 *   真值被挡      **独立于约束实现的**真值：从渲染相机往每个手指点打射线，
 *                中间有皮肤挡着就是手指沉到了表面后面 —— 也就是画面上看得到的穿模
 *   手腕 / 指尖   逐帧最大位移，衡量动作连不连贯。指尖在手掌坐标系里量，
 *                只反映手指弯曲本身，不含手腕的平移和旋转
 *
 * 为什么真值要单独做：只看自评等于自己给自己打分。这套审计第一次跑就抓到了
 * "自评 0mm、真值其实在穿"的情况。
 *
 * 真值的两个坑（都踩过）：
 *   - 必须排除手臂自己的皮肤。每根骨骼本来就在自己那节肢体的皮肤里面
 *   - 不能用射线奇偶判断内外：这个模型的网格不封闭（后脑勺只有头发、衣服下的身体被裁掉），
 *     从头部中心往后打的射线会直接穿出去。"相机和点之间有没有皮肤"不要求网格封闭
 */

type Tri = Float64Array;

const ARM_BONES: VRMHumanBoneName[] = ['rightUpperArm', 'rightLowerArm', 'rightHand'];
for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
  for (const s of ['Metacarpal', 'Proximal', 'Intermediate', 'Distal']) {
    ARM_BONES.push(`right${f}${s}` as VRMHumanBoneName);
  }
}

/** Möller–Trumbore：射线参数 t，没交点返回 -1 */
function rayTri(o: THREE.Vector3, d: THREE.Vector3, t: Tri) {
  const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
  const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
  const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const sx = o.x - t[0], sy = o.y - t[1], sz = o.z - t[2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

export function installAudit(rt: Runtime) {
  const ch = () => rt.character!;
  const vrm = () => ch().vrm!;
  const node = (n: VRMHumanBoneName) => vrm().humanoid.getNormalizedBoneNode(n)!;

  /** 当前姿态下的皮肤三角形（Face / Body 网格，排除右臂自己的皮肤）；hair = 只取头发网格 */
  const skinTriangles = (meshes = /^(Face|Body)/) => {
    const v = vrm();
    v.scene.updateMatrixWorld(true);
    const armRaw = new Set(ARM_BONES.map((n) => v.humanoid.getRawBoneNode(n)).filter(Boolean));
    const out: Tri[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    v.scene.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !meshes.test(mesh.name)) return;
      mesh.skeleton.update();
      const g = mesh.geometry;
      const idx = g.getIndex();
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      const armIdx = new Set<number>();
      mesh.skeleton.bones.forEach((bn, i) => armRaw.has(bn) && armIdx.add(i));
      const isArm = (i: number) => {
        let w = 0;
        for (let k = 0; k < 4; k++) if (armIdx.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
        return w > 0.3;
      };
      const n = idx ? idx.count : g.getAttribute('position').count;
      for (let t = 0; t + 2 < n; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
        if (isArm(i0) || isArm(i1) || isArm(i2)) continue;
        mesh.localToWorld(mesh.getVertexPosition(i0, a));
        mesh.localToWorld(mesh.getVertexPosition(i1, b));
        mesh.localToWorld(mesh.getVertexPosition(i2, c));
        out.push(new Float64Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]));
      }
    });
    return out;
  };

  /** 手上要检查的点：每根手指的关节 + 外推的指尖 */
  const handPoints = () => {
    const pts: Array<[string, THREE.Vector3]> = [];
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      const ps = segs
        .map((s) => vrm().humanoid.getNormalizedBoneNode(`right${f}${s}` as VRMHumanBoneName))
        .filter((x): x is THREE.Object3D => !!x)
        .map((x) => x.getWorldPosition(new THREE.Vector3()));
      ps.forEach((p, i) => pts.push([`${f}${i}`, p]));
      if (ps.length >= 2) pts.push([`${f}尖`, ps[ps.length - 1].clone().lerp(ps[ps.length - 2], -0.8)]);
    }
    return pts;
  };

  /**
   * 每个点在相机视线上被皮肤（或头发）挡住多深（米），0 = 可见。
   * back = 从角色背后看（相机镜像到身后）：手在后颈时从正面看本来就该被挡住，
   * 这时要从背后看手有没有陷进皮肤
   */
  const occlusion = (points: Array<[string, THREE.Vector3]>, hair = false, back = false) => {
    const tris = skinTriangles(hair ? /^Hair/ : /^(Face|Body)/);
    const main = rt.stage!.camera.position;
    const cam = back ? new THREE.Vector3(main.x, main.y, -main.z) : main;
    return points.map(([name, p]) => {
      const d = p.clone().sub(cam);
      const len = d.length();
      d.normalize();
      let first = Infinity;
      for (const t of tris) {
        const s = rayTri(cam, d, t);
        if (s > 0 && s < first) first = s;
      }
      return [name, Math.max(0, len - first)] as [string, number];
    });
  };

  const audit = (
    id: GestureId,
    pair: Partial<Record<Emotion, number>> = { neutral: 1 },
    opts: { back?: boolean } = {},
  ) => {
    const c = ch();
    const micro = c.expression.microEnabled;
    c.expression.microEnabled = false;
    c.gesture.frozen = false;
    c.gesture.clear();
    c.expression.setBlend(pair, 0.2);
    c.gesture.play(id, 1, 1);
    const info = c.gesture.info();
    if (!info) return null;
    const frames = Math.ceil(info.duration * 60);

    let push = 0, pushBy = '', pen = 0, wMax = 0, tMax = 0, tAt = 0;
    let occMax = 0, occAt = 0, occWho = '', occFrames = 0, samples = 0;
    let hairMax = 0, hairWho = '', hairFrames = 0;
    let prevW: THREE.Vector3 | null = null;
    let prevT: THREE.Vector3[] | null = null;

    for (let f = 0; f < frames; f++) {
      c.update(1 / 60);
      const t = f / 60;
      const hand = node('rightHand');
      if (c.reach.debug.pushed > push) {
        push = c.reach.debug.pushed;
        pushBy = `${c.reach.debug.pushedBy} @${t.toFixed(2)}s`;
      }
      pen = Math.max(pen, c.reach.debug.penetration);

      const W = hand.getWorldPosition(new THREE.Vector3());
      if (prevW) wMax = Math.max(wMax, W.distanceTo(prevW));
      prevW = W;

      const tips = (['Index', 'Middle', 'Ring', 'Little'] as const).map((x) => {
        const d = node(`right${x}Distal` as VRMHumanBoneName).getWorldPosition(new THREE.Vector3());
        const m = node(`right${x}Intermediate` as VRMHumanBoneName).getWorldPosition(new THREE.Vector3());
        return hand.worldToLocal(d.lerp(m, -0.8));
      });
      if (prevT) {
        tips.forEach((p, i) => {
          const j = p.distanceTo(prevT![i]);
          if (j > tMax) {
            tMax = j;
            tAt = t;
          }
        });
      }
      prevT = tips;

      // 真值每 5 帧抽一次，只在 IK 起作用时（手在身体附近）
      if (f % 5 === 0 && c.reach.debug.weight > 0.3) {
        samples++;
        let worst = 0, who = '';
        for (const [name, d] of occlusion(handPoints(), false, opts.back)) {
          if (d > worst) {
            worst = d;
            who = name;
          }
        }
        if (worst > 0.0005) {
          occFrames++;
          if (worst > occMax) {
            occMax = worst;
            occAt = t;
            occWho = who;
          }
        }
        let hw = 0;
        for (const [name, d] of occlusion(handPoints(), true)) {
          if (d > hw) {
            hw = d;
            if (d > hairMax) {
              hairMax = d;
              hairWho = `${name} @${t.toFixed(2)}s`;
            }
          }
        }
        if (hw > 0.0005) hairFrames++;
      }
    }
    c.gesture.clear();
    c.expression.microEnabled = micro;
    const mm = (x: number) => +(x * 1000).toFixed(1);
    return {
      动作: id,
      整手外推_最大mm: push ? `${mm(push)} ${pushBy}` : 0,
      自评穿透_最大mm: mm(pen),
      真值_被挡最深mm: occMax ? `${mm(occMax)} @${occAt.toFixed(2)}s ${occWho}` : 0,
      真值_被挡帧: `${occFrames}/${samples}`,
      // 头发单列：手指伸到侧发下面被挡住是正常的，手掌陷在刘海后面才是穿模
      头发_被挡最深mm: hairMax ? `${mm(hairMax)} ${hairWho}` : 0,
      头发_被挡帧: `${hairFrames}/${samples}`,
      手腕单帧最大cm: +(wMax * 100).toFixed(2),
      指尖单帧最大mm: `${mm(tMax)} @${tAt.toFixed(2)}s`,
    };
  };

  /**
   * 静止姿态下量表面：从 from 沿 dir 打射线，返回第一个交点。坐标都相对 anchor 骨骼
   * （世界朝向，不旋转 —— 和 ReachSpec.palmOffset 同一个坐标系），单位米。
   * 用来给 ReachSpec 定初值：脸颊、下巴、额头、刘海、后颈、胸口各在哪。
   */
  const probe = (
    from: [number, number, number],
    dir: [number, number, number],
    opts: { anchor?: VRMHumanBoneName; hair?: boolean } = {},
  ) => {
    const v = vrm();
    v.humanoid.resetNormalizedPose();
    v.humanoid.update();
    v.scene.updateMatrixWorld(true);
    const origin = node(opts.anchor ?? 'head').getWorldPosition(new THREE.Vector3());
    const tris = skinTriangles(opts.hair ? /^Hair/ : /^(Face|Body)/);
    const o = new THREE.Vector3(...from).add(origin);
    const d = new THREE.Vector3(...dir).normalize();
    let first = Infinity;
    for (const t of tris) {
      const s = rayTri(o, d, t);
      if (s > 0 && s < first) first = s;
    }
    if (!Number.isFinite(first)) return null;
    return o.addScaledVector(d, first).sub(origin).toArray().map((x) => +x.toFixed(3));
  };

  /**
   * 停在某个手势的第 t 秒，渲染一帧，用来截图验收。
   * 逐帧同步推进而不是等 rAF：预览窗格隐藏时浏览器会把 rAF 节流到几乎不动。
   */
  const hold = (id: GestureId, t: number, pair?: Partial<Record<Emotion, number>>) => {
    const c = ch();
    rt.releaseGesture();
    if (pair) c.expression.setBlend(pair, 0.1);
    rt.playPreview(id, 1, false);
    for (let i = 0; i < Math.round(t * 60); i++) c.update(1 / 60);
    rt.seekPreview(t);
    for (let i = 0; i < 6; i++) c.update(1 / 60);
    rt.stage!.render();
    const d = c.reach.debug;
    const mm = (x: number) => +(x * 1000).toFixed(1);
    return {
      weight: +d.weight.toFixed(2),
      pushed: mm(d.pushed),
      pushedBy: d.pushedBy,
      penetration: mm(d.penetration),
      worst: d.worst && { at: d.worst.at, depth: mm(d.worst.depth), dir: d.worst.dir.map((x) => +x.toFixed(2)) },
    };
  };

  /**
   * 截图用的特写：换上一台替身相机对准某个点（世界坐标），直到 __closeup(null) 换回来。
   * 不挪主相机：视线层看的是主相机的位置，真值检测也按主相机打射线。
   * side = 绕 Y 转多少度（负值 = 从角色右侧看）
   */
  const closeup = (target: [number, number, number] | null, fov = 9, side = 0) => {
    const stage = rt.stage!;
    if (!target) {
      stage.view.camera = null;
      return 'main camera';
    }
    const main = stage.camera;
    const cam = main.clone();
    const t = new THREE.Vector3(...target);
    const dist = main.position.distanceTo(t);
    const a = THREE.MathUtils.degToRad(side);
    cam.position.set(t.x + Math.sin(a) * dist, main.position.y, t.z + Math.cos(a) * dist);
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.lookAt(t);
    stage.view.camera = cam;
    stage.render();
    return 'closeup';
  };

  /**
   * hold + 特写 + 两个快速指标：
   *   eyeDist —— 手上离右眼最近的点（正面投影，只算在眼睛前面的点），防止手指盖住眼睛
   *   occ     —— 这一帧被皮肤挡住的手指点
   * focus 是特写中心相对头骨的偏移
   */
  const look = (
    id: GestureId,
    t: number,
    pair?: Partial<Record<Emotion, number>>,
    focus: [number, number, number] = [-0.04, 0.03, 0.06],
    fov = 10,
  ) => {
    const h = hold(id, t, pair);
    const head = node('head').getWorldPosition(new THREE.Vector3());
    const eye = node('rightEye').getWorldPosition(new THREE.Vector3());
    const pts = handPoints();
    let eyeMin = 1, eyeWho = '';
    for (const [n, p] of pts) {
      const d = Math.hypot(p.x - eye.x, p.y - eye.y);
      if (d < eyeMin && p.z > eye.z) {
        eyeMin = d;
        eyeWho = n;
      }
    }
    const occ = occlusion(pts)
      .filter(([, d]) => d > 0.001)
      .map(([n, d]) => `${n}:${Math.round(d * 1000)}`);
    closeup([head.x + focus[0], head.y + focus[1], head.z + focus[2]], fov);
    return { ...h, eyeDist: `${Math.round(eyeMin * 1000)}mm ${eyeWho}`, occ: occ.join(' ') };
  };

  const w = window as unknown as Record<string, unknown>;
  w.__look = look;
  // 活的 spec 对象：控制台里直接改字段，下一次 __hold / __audit 就生效（刷新页面还原）
  w.__spec = (id: GestureId) => GESTURE_CLIPS[id].reach;
  w.__closeup = closeup;
  w.__probe = probe;
  w.__hold = hold;
  w.__audit = audit;
  w.__occlusion = occlusion;
  w.__handPoints = handPoints;
}
