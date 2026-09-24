import * as THREE from 'three';
import { VRMExpression, VRMExpressionMorphTargetBind, type VRM } from '@pixiv/three-vrm';

/**
 * 分部位的表情形状（眉 / 眼 / 嘴）。
 *
 * VRM 的情绪预设是**整脸烘焙**的：happy 一个槽同时改眉、眼、嘴。这有三个问题：
 *   1. 混合情绪只能整脸相加。苦笑 = sad + happy 两张整脸叠在一起，嘴又哭又笑
 *   2. 嘴被情绪占了，口型就没地方放（README 里"叠满像打哈欠"那一条）
 *   3. 眼睛和嘴的节奏没法分开：真人换表情时眉眼先动，嘴后到
 *
 * VRoid 导出的模型脸上其实有分部位的形状（Fcl_BRW_* / Fcl_EYE_* / Fcl_MTH_*），
 * 只是 VRM 预设没用它们。这里把它们注册成额外的 VRM 表情（名字带 `part:` 前缀），
 * 由 ExpressionLayer 按部位合成。注册成表情而不是直接写 morphTargetInfluences：
 * 表情管理器每帧会先清零再叠加它管辖的 morph，直接写的值顺序一乱就被清掉。
 */

export type FacePart = 'brow' | 'eye' | 'mouth';

export const SHAPES = {
  brow_angry: 'brow',
  brow_sad: 'brow',
  brow_happy: 'brow',
  brow_relaxed: 'brow',
  brow_surprised: 'brow',
  /** 上眼睑压下来，瞪 / 专注 */
  eye_angry: 'eye',
  /** 笑眼 ^^，1.0 是完全闭合 */
  eye_smile: 'eye',
  eye_smile_l: 'eye',
  eye_smile_r: 'eye',
  /** 眼角下垂的半闭 */
  eye_sad: 'eye',
  /** 睁大、瞳孔缩小 */
  eye_wide: 'eye',
  /** 用力闭紧（>< 的眼型） */
  eye_squeeze: 'eye',
  /** 闭嘴微笑，嘴角上扬 —— 说话时也能保持 */
  mouth_smile: 'mouth',
  /** 张嘴大笑 */
  mouth_grin: 'mouth',
  /** 撅嘴（生气） */
  mouth_pout: 'mouth',
  /** 抿嘴、嘴角微微下压 */
  mouth_frown: 'mouth',
  /** 委屈的小开口 */
  mouth_sad: 'mouth',
  /** O 型 */
  mouth_o: 'mouth',
} as const satisfies Record<string, FacePart>;

export type Shape = keyof typeof SHAPES;

/** VRoid 的形状命名 → 语义形状。模型导出时保留了名字就按名字找 */
const VROID_NAMES: Record<Shape, string[]> = {
  brow_angry: ['Fcl_BRW_Angry'],
  brow_sad: ['Fcl_BRW_Sorrow'],
  brow_happy: ['Fcl_BRW_Joy'],
  brow_relaxed: ['Fcl_BRW_Fun'],
  brow_surprised: ['Fcl_BRW_Surprised'],
  eye_angry: ['Fcl_EYE_Angry'],
  eye_smile: ['Fcl_EYE_Joy'],
  eye_smile_l: ['Fcl_EYE_Joy_L'],
  eye_smile_r: ['Fcl_EYE_Joy_R'],
  eye_sad: ['Fcl_EYE_Sorrow'],
  eye_wide: ['Fcl_EYE_Surprised'],
  eye_squeeze: ['Fcl_EYE_Extra', 'Fcl_EYE_Spread'],
  mouth_smile: ['Fcl_MTH_Fun'],
  mouth_grin: ['Fcl_MTH_Joy'],
  mouth_pout: ['Fcl_MTH_Angry'],
  mouth_frown: ['Fcl_MTH_Neutral', 'Fcl_MTH_Small'],
  mouth_sad: ['Fcl_MTH_Sorrow'],
  mouth_o: ['Fcl_MTH_Surprised'],
};

/**
 * 导出时丢了形状名的模型（名字变成 "0".."40"）只能按下标标定。
 *
 * Sendagaya_Shino.vrm 的这张表是在浏览器里逐个渲染 41 个 morph 认出来的
 * （每个形状单独拉满，眉眼、嘴各截一张特写对比），再和整脸预设交叉验证：
 * 整脸 angry(0) 的嘴 = 23，整脸 relaxed(1) 的嘴 = 25，整脸 sad(3) 的眼 = 18、嘴 = 27。
 *
 * 用"表情预设绑定了哪些下标"做指纹，而不是按文件名：换一个同样丢了名字的 VRoid
 * 模型，只要预设绑定对得上就能复用这张表；对不上就不启用分部位，退回整脸预设。
 */
const INDEX_TABLES: Array<{
  name: string;
  morphCount: number;
  /** 预设 → 它绑定的 morph 下标 */
  fingerprint: Record<string, number>;
  shapes: Partial<Record<Shape, number>>;
}> = [
  {
    name: 'VRoid（早期导出，41 个形状，无名字）',
    morphCount: 41,
    fingerprint: { angry: 0, relaxed: 1, happy: 2, sad: 3, blink: 12, aa: 29 },
    shapes: {
      brow_angry: 5,
      brow_relaxed: 6,
      brow_happy: 7,
      brow_sad: 8,
      brow_surprised: 9,
      eye_angry: 11,
      eye_smile: 15,
      eye_smile_r: 16,
      eye_smile_l: 17,
      eye_sad: 18,
      eye_wide: 19,
      eye_squeeze: 20,
      mouth_pout: 23,
      mouth_frown: 24,
      mouth_smile: 25,
      mouth_grin: 26,
      mouth_sad: 27,
      mouth_o: 28,
    },
  },
];

export interface FaceRig {
  /** 语义形状 → 注册后的 VRM 表情名 */
  keys: Partial<Record<Shape, string>>;
  source: string;
}

/** 表情里所有 morph 绑定的"网格 + 下标"。VRMExpression 的 binds 是只读公开的 */
function morphBinds(expr: VRMExpression | null) {
  const out: Array<{ primitives: THREE.Mesh[]; index: number }> = [];
  for (const b of expr?.binds ?? []) {
    if (b instanceof VRMExpressionMorphTargetBind) out.push({ primitives: b.primitives, index: b.index });
  }
  return out;
}

/**
 * 找到脸部网格和形状下标，把每个形状注册成一个 VRM 表情。
 * 找不到就返回 null —— ExpressionLayer 会退回整脸预设，行为和以前一样。
 */
export function bindFaceRig(vrm: VRM): FaceRig | null {
  const mgr = vrm.expressionManager;
  if (!mgr) return null;

  // 脸部的网格就是情绪预设绑定的那一组（多材质网格会被拆成好几个子网格，共用 morph）
  const happyBinds = morphBinds(mgr.getExpression('happy'));
  const primitives = happyBinds[0]?.primitives;
  if (!primitives?.length) return null;
  const face = primitives[0];
  const dict = face.morphTargetDictionary ?? {};
  const count = face.morphTargetInfluences?.length ?? 0;

  const indices: Partial<Record<Shape, number>> = {};
  let source = '';

  // 1. 有名字就按名字
  for (const shape of Object.keys(VROID_NAMES) as Shape[]) {
    for (const n of VROID_NAMES[shape]) {
      if (n in dict) {
        indices[shape] = dict[n];
        break;
      }
    }
  }
  if (Object.keys(indices).length >= 6) source = 'VRoid 形状名';

  // 2. 没名字就按指纹查标定表
  if (!source) {
    for (const table of INDEX_TABLES) {
      if (table.morphCount !== count) continue;
      const ok = Object.entries(table.fingerprint).every(([preset, idx]) =>
        morphBinds(mgr.getExpression(preset)).some((b) => b.index === idx),
      );
      if (!ok) continue;
      Object.assign(indices, table.shapes);
      source = table.name;
      break;
    }
  }
  if (!source) return null;

  const keys: Partial<Record<Shape, string>> = {};
  for (const [shape, index] of Object.entries(indices) as Array<[Shape, number]>) {
    if (index == null || index >= count) continue;
    const name = `part:${shape}`;
    if (!mgr.getExpression(name)) {
      const expr = new VRMExpression(name);
      expr.addBind(new VRMExpressionMorphTargetBind({ primitives, index, weight: 1 }));
      // 眨眼、口型的冲突由 ExpressionLayer 自己处理，不让管理器再压一遍
      expr.overrideBlink = 'none';
      expr.overrideMouth = 'none';
      expr.overrideLookAt = 'none';
      vrm.scene.add(expr);
      mgr.registerExpression(expr);
    }
    keys[shape] = name;
  }
  return { keys, source };
}
