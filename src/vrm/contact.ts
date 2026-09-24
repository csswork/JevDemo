import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * 接触体积：给手部 IK 用的身体碰撞体。
 *
 * 做法是 visual hull（视觉外壳）：沿 X、Y、Z 三个方向各做一张分层深度图，每格记录
 * 射线进入和离开身体的深度 [lo, hi]。一个点只有在三个方向上都落在区间内，才算在身体里；
 * 推出时取六个出口里最近的那个。
 *
 * 为什么不是单张正面深度图（掩嘴笑第一版的做法）：它只知道"从正前方看有没有陷进去"。
 * 手贴脸颊碰的是脸的侧面，摸后颈碰的是脖子后面，这两种它都管不了。
 * 为什么不是球/胶囊：包不住鼻子、下巴这种凸起，而穿模恰恰发生在这些地方。
 * 为什么不是每帧对网格做射线检测：模型有 77 个蒙皮网格，每帧做太重。
 *
 * visual hull 会把从三个轴向都看不见的凹陷（眼窝、唇缝）填平，所以是偏保守的：
 * 手指宁可离表面远一点，也不会穿进去。
 *
 * 坐标：锚点骨骼的"规范局部空间" —— 静止姿态下就是世界空间减去锚点位置
 * （rotateVRM0 之后两种 VRM 版本都面朝 +Z），运行时再用锚点相对静止姿态的旋转把点转回来。
 */

type Axis = 0 | 1 | 2;

class DepthView {
  readonly axis: Axis;
  readonly u: Axis;
  readonly v: Axis;
  readonly min: THREE.Vector3;
  readonly cell: number;
  readonly nu: number;
  readonly nv: number;
  readonly lo: Float32Array;
  readonly hi: Float32Array;

  constructor(axis: Axis, u: Axis, v: Axis, min: THREE.Vector3, max: THREE.Vector3, cell: number) {
    this.axis = axis;
    this.u = u;
    this.v = v;
    this.min = min;
    this.cell = cell;
    this.nu = Math.ceil((max.getComponent(u) - min.getComponent(u)) / cell);
    this.nv = Math.ceil((max.getComponent(v) - min.getComponent(v)) / cell);
    this.lo = new Float32Array(this.nu * this.nv).fill(Infinity);
    this.hi = new Float32Array(this.nu * this.nv).fill(-Infinity);
  }

  private index(pu: number, pv: number) {
    const iu = Math.floor((pu - this.min.getComponent(this.u)) / this.cell);
    const iv = Math.floor((pv - this.min.getComponent(this.v)) / this.cell);
    if (iu < 0 || iv < 0 || iu >= this.nu || iv >= this.nv) return -1;
    return iv * this.nu + iu;
  }

  raster(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    const { u, v, cell } = this;
    const au = a.getComponent(u), av = a.getComponent(v), ad = a.getComponent(this.axis);
    const bu = b.getComponent(u), bv = b.getComponent(v), bd = b.getComponent(this.axis);
    const cu = c.getComponent(u), cv = c.getComponent(v), cd = c.getComponent(this.axis);
    const u0 = this.min.getComponent(u);
    const v0 = this.min.getComponent(v);
    const minU = Math.max(0, Math.floor((Math.min(au, bu, cu) - u0) / cell));
    const maxU = Math.min(this.nu - 1, Math.ceil((Math.max(au, bu, cu) - u0) / cell));
    const minV = Math.max(0, Math.floor((Math.min(av, bv, cv) - v0) / cell));
    const maxV = Math.min(this.nv - 1, Math.ceil((Math.max(av, bv, cv) - v0) / cell));
    if (minU > maxU || minV > maxV) return;
    const den = (bv - cv) * (au - cu) + (cu - bu) * (av - cv);
    if (Math.abs(den) < 1e-12) return;
    for (let iv = minV; iv <= maxV; iv++) {
      const pv = v0 + (iv + 0.5) * cell;
      for (let iu = minU; iu <= maxU; iu++) {
        const pu = u0 + (iu + 0.5) * cell;
        const w1 = ((bv - cv) * (pu - cu) + (cu - bu) * (pv - cv)) / den;
        const w2 = ((cv - av) * (pu - cu) + (au - cu) * (pv - cv)) / den;
        const w3 = 1 - w1 - w2;
        // 稍微放宽边界，避免相邻三角形之间漏格
        if (w1 < -0.02 || w2 < -0.02 || w3 < -0.02) continue;
        const d = w1 * ad + w2 * bd + w3 * cd;
        const k = iv * this.nu + iu;
        if (d < this.lo[k]) this.lo[k] = d;
        if (d > this.hi[k]) this.hi[k] = d;
      }
    }
  }

  /**
   * 填洞：从网格边界洪水填充，和外面连通的空格是"身体外"，其余空格是被身体
   * 包住的洞（比如眼睛 —— 实测正面图上两只眼睛是 65 格的空洞），用邻居扩散填上。
   *
   * 最初只用"八邻域里有 5 个非空就填"，只能补针眼大的洞：一个大洞的边缘，
   * 和身体外轮廓在局部看起来完全一样（都是 3 个非空邻居），光看邻居分不出来。
   */
  fillEnclosedHoles() {
    const { nu, nv } = this;
    const empty = (k: number) => !Number.isFinite(this.hi[k]);
    const outside = new Uint8Array(nu * nv);
    const stack: number[] = [];
    const seed = (iu: number, iv: number) => {
      const k = iv * nu + iu;
      if (empty(k) && !outside[k]) {
        outside[k] = 1;
        stack.push(k);
      }
    };
    for (let i = 0; i < nu; i++) {
      seed(i, 0);
      seed(i, nv - 1);
    }
    for (let j = 0; j < nv; j++) {
      seed(0, j);
      seed(nu - 1, j);
    }
    while (stack.length) {
      const k = stack.pop()!;
      const iu = k % nu;
      const iv = (k - iu) / nu;
      if (iu > 0) seed(iu - 1, iv);
      if (iu < nu - 1) seed(iu + 1, iv);
      if (iv > 0) seed(iu, iv - 1);
      if (iv < nv - 1) seed(iu, iv + 1);
    }

    // 洞里的格子一圈一圈往里扩散：取已填邻居的 lo 最小值、hi 最大值
    for (let pass = 0; pass < 200; pass++) {
      let changed = 0;
      const lo = this.lo.slice();
      const hi = this.hi.slice();
      for (let iv = 0; iv < nv; iv++) {
        for (let iu = 0; iu < nu; iu++) {
          const k = iv * nu + iu;
          if (!empty(k) || outside[k]) continue;
          let l = Infinity;
          let h = -Infinity;
          for (let dv = -1; dv <= 1; dv++) {
            for (let du = -1; du <= 1; du++) {
              const uu = iu + du;
              const vv = iv + dv;
              if (uu < 0 || vv < 0 || uu >= nu || vv >= nv) continue;
              const kk = vv * nu + uu;
              if (Number.isFinite(hi[kk])) {
                if (lo[kk] < l) l = lo[kk];
                if (hi[kk] > h) h = hi[kk];
              }
            }
          }
          if (Number.isFinite(h)) {
            this.lo[k] = l;
            this.hi[k] = h;
            changed++;
          }
        }
      }
      if (!changed) break;
    }
  }

  /** 该点在这个方向上的区间；空格返回 null（这条射线上没有身体） */
  range(p: THREE.Vector3): [number, number] | null {
    const k = this.index(p.getComponent(this.u), p.getComponent(this.v));
    if (k < 0 || !Number.isFinite(this.hi[k])) return null;
    return [this.lo[k], this.hi[k]];
  }
}

export interface ContactHit {
  /** 要推出去的距离（米，已含安全距离） */
  depth: number;
  /** 推出方向（锚点规范局部空间，单位向量） */
  dir: THREE.Vector3;
}

export class ContactVolume {
  private views: DepthView[];
  triangles = 0;

  constructor(min: THREE.Vector3, max: THREE.Vector3, cell = 0.003) {
    this.views = [
      new DepthView(0, 1, 2, min, max, cell), // 沿 X 看：侧面
      new DepthView(1, 0, 2, min, max, cell), // 沿 Y 看：俯视
      new DepthView(2, 0, 1, min, max, cell), // 沿 Z 看：正面
    ];
  }

  addTriangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    this.triangles++;
    for (const v of this.views) v.raster(a, b, c);
  }

  finalize() {
    for (const v of this.views) v.fillEnclosedHoles();
  }

  /** 正面视图在 (x, y) 处的表面 z（调试用：和掩嘴笑第一版的深度图可比） */
  frontSurface(x: number, y: number) {
    const r = this.views[2].range(new THREE.Vector3(x, y, 0));
    return r ? r[1] : null;
  }

  /** 点在体积内时返回最近的出口；在外面返回 null */
  query(p: THREE.Vector3, margin: number): ContactHit | null {
    let best: ContactHit | null = null;
    for (const view of this.views) {
      const r = view.range(p);
      if (!r) return null;
      const d = p.getComponent(view.axis);
      const lo = r[0] - margin;
      const hi = r[1] + margin;
      if (d < lo || d > hi) return null;
      const toLo = d - lo;
      const toHi = hi - d;
      const out = toLo < toHi ? toLo : toHi;
      if (!best || out < best.depth) {
        const dir = new THREE.Vector3();
        dir.setComponent(view.axis, toLo < toHi ? -1 : 1);
        best = { depth: out, dir };
      }
    }
    return best;
  }
}

/**
 * 按"蒙皮绑在哪些骨骼上"挑三角形，在静止姿态下建体积。
 * 用绑定关系而不是网格名字 —— 换个模型网格名不一样也能用。
 *
 * @param bones     核心骨骼（humanoid 名）
 * @param secondary 核心骨骼下挂的非 humanoid 骨骼算不算进来：
 *   'all'   —— 全算，包括弹簧骨。躯干要这样：胸前的顶点主骨骼是 J_Sec_*_Bust1（弹簧骨），
 *              不算进来胸前就是个洞
 *   'rigid' —— 只算不是弹簧骨的辅助骨骼。头部要这样：眼眶一圈的皮肤绑在
 *              J_Adj_*_FaceEyeSet 上，漏掉它正面视图在眼睛周围就是个洞（实测手指陷进
 *              脸颊 4cm 都检测不到）；而头骨下挂的弹簧骨是头发，长发垂到腰，不能算
 */
export function buildContactVolume(
  vrm: VRM,
  anchor: VRMHumanBoneName,
  bones: VRMHumanBoneName[],
  box: { min: [number, number, number]; max: [number, number, number] },
  secondary: 'all' | 'rigid',
  cell = 0.003,
): ContactVolume | null {
  const anchorNode = vrm.humanoid.getNormalizedBoneNode(anchor);
  if (!anchorNode) return null;
  const origin = anchorNode.getWorldPosition(new THREE.Vector3());

  const core = new Set<THREE.Object3D>();
  for (const b of bones) {
    const raw = vrm.humanoid.getRawBoneNode(b);
    if (raw) core.add(raw);
  }
  const humanoidRaw = new Set<THREE.Object3D>();
  for (const name of Object.keys(vrm.humanoid.rawHumanBones)) {
    const raw = vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName);
    if (raw) humanoidRaw.add(raw);
  }
  const springs = new Set<THREE.Object3D>();
  for (const j of vrm.springBoneManager?.joints ?? []) springs.add(j.bone);
  const included = new Set(core);
  // 向下走，遇到 humanoid 骨骼（脖子、肩膀、手臂）就停；rigid 模式遇到弹簧骨也停
  const walk = (n: THREE.Object3D) => {
    for (const c of n.children) {
      if (humanoidRaw.has(c)) continue;
      if (secondary === 'rigid' && springs.has(c)) continue;
      included.add(c);
      walk(c);
    }
  };
  core.forEach(walk);

  const vol = new ContactVolume(
    new THREE.Vector3(...box.min),
    new THREE.Vector3(...box.max),
    cell,
  );
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();

  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const idx = new Set<number>();
    mesh.skeleton.bones.forEach((b, i) => {
      if (included.has(b)) idx.add(i);
    });
    if (!idx.size) return;
    const g = mesh.geometry;
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    if (!si || !sw) return;

    const owned = (v: number) => {
      let w = 0;
      for (let k = 0; k < 4; k++) if (idx.has(si.getComponent(v, k))) w += sw.getComponent(v, k);
      return w > 0.5;
    };
    const local = (i: number, out: THREE.Vector3) => {
      mesh.getVertexPosition(i, out);
      return mesh.localToWorld(out).sub(origin);
    };
    const index = g.getIndex();
    const count = index ? index.count : g.getAttribute('position').count;
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = index ? index.getX(t) : t;
      const i1 = index ? index.getX(t + 1) : t + 1;
      const i2 = index ? index.getX(t + 2) : t + 2;
      if (!owned(i0) || !owned(i1) || !owned(i2)) continue;
      vol.addTriangle(local(i0, va), local(i1, vb), local(i2, vc));
    }
  });
  vol.finalize();
  return vol;
}
