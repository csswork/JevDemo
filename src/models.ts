/**
 * 可选的角色模型（都是女性、授权允许这样用的样例模型）。
 *
 * 除了詩乃，其余都在 public/models/candidates/（gitignored，对比用下载下来的）。
 * 新克隆的仓库里没有它们，下拉框里会显示成不可选，见 probeModels。
 *
 * 表情一栏是实测结果（`__faces` 对比图）：
 *   分部位  脸部形状能一个个单独驱动，眉 / 眼 / 嘴分开合成（vrm/faceRig.ts）
 *   整脸    只有整脸预设，混合情绪和"让位给口型"都做不了，温和的情绪几乎看不出来。
 *           要重新标定形状才能升级（和当初给詩乃做的一样）
 */
export interface ModelMeta {
  id: string;
  name: string;
  /** 相对 public/models/ */
  file: string;
  desc: string;
  license: string;
  face: '分部位' | '整脸';
  /**
   * 待机时上臂额外外展多少度（在待机动作自带的 6° 之上）。裙子越蓬，垂手时手越容易陷进裙摆：
   * 逐个模型看手部特写定的 —— 詩乃 / Kira 这类窄裙 0，Vivi 的 A 字连衣裙 +3，Victoria 的蓬裙 +6
   */
  armOut?: number;
}

export const MODELS: ModelMeta[] = [
  { id: 'shino', name: '千駄ヶ谷 詩乃', file: 'Sendagaya_Shino.vrm', desc: '黑长直 · 制服', license: 'CC0', face: '分部位' },
  {
    id: 'vivi',
    name: 'Vivi',
    file: 'candidates/Vivi.vrm',
    desc: '棕色短发 · 围裙连衣裙',
    license: 'CC0',
    face: '分部位',
    armOut: 3,
  },
  {
    id: 'victoria',
    name: 'Victoria Rubin',
    file: 'candidates/Victoria_Rubin.vrm',
    desc: '金粉渐变 · 侧马尾',
    license: 'CC0',
    face: '分部位',
    armOut: 6,
  },
  { id: 'vita', name: 'Vita', file: 'candidates/Vita.vrm', desc: '白发异瞳 · 科幻', license: 'CC0', face: '分部位' },
  {
    id: 'hair_female',
    name: 'HairSample_Female',
    file: 'candidates/HairSample_Female.vrm',
    desc: '猫耳双马尾',
    license: 'CC0',
    face: '分部位',
  },
  {
    id: 'avatar_b',
    name: 'AvatarSample_B',
    file: 'candidates/AvatarSample_B.vrm',
    desc: '紫发 · 辣妹风',
    license: 'VRM 许可：可商用、可改、可再分发',
    face: '分部位',
  },
  {
    id: 'perfect_sync',
    name: 'VRoid 素体（52 表情形状）',
    file: 'candidates/VRoid_V110_Female.vrm',
    desc: '灰色素体',
    license: '可商用（作者 README）',
    face: '分部位',
  },
  {
    id: 'avatar_a',
    name: 'AvatarSample_A',
    file: 'candidates/AvatarSample_A.vrm',
    desc: '棕红短发 · 开衫',
    license: '可商用、可改、可再分发',
    face: '整脸',
  },
  {
    id: 'alicia',
    name: 'Alicia Solid',
    file: 'candidates/AliciaSolid.vrm',
    desc: '金色麻花辫 · 蓝裙',
    license: 'ニコニ立体ちゃん 利用规约',
    face: '整脸',
  },
];

export const DEFAULT_MODEL = MODELS[0];

export const modelUrl = (m: ModelMeta) => `${import.meta.env.BASE_URL}models/${m.file}`;

/**
 * 哪些模型文件真的在。Vite 对不存在的路径会回退成 index.html（200），所以要看类型
 */
export async function probeModels(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    MODELS.map(async (m) => {
      try {
        const r = await fetch(modelUrl(m), { method: 'HEAD' });
        return [m.id, r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')] as const;
      } catch {
        return [m.id, false] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
