/**
 * 可选的角色模型（都是女性、授权允许这样用的样例模型）。
 *
 * 下拉框按这里的顺序列，不分组；第一个是默认模型。名字用角色名（和 server/personas.ts 的人设一致），
 * desc 是「性格 · 装扮」，都写短。
 *
 * 下拉框里的模型都入库（public/models/ 和 quappa/）。浏览器只下载当前选中的那一个，
 * 其余只在启动时发一个 HEAD 探测文件在不在（不下载内容）；隐藏的连探测都不发。
 * 隐藏的 VRoid 素体、爱丽西亚在 public/models/candidates/（gitignored，对比用下载下来的）。
 *
 * quappa/ 是从 QUAPPA-EL 的 MMD 模型（PMX）转出来的 VRM，加密成 .vrmx 入库（规约要求防再利用，
 * 见 vrm/protect.ts 和 public/models/quappa/README.txt）。转换脚本在 scripts/pmx2vrm/。
 * 规约只允许个人非商用；商用要先联系作者。
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
  /** 「性格 · 装扮」 */
  desc: string;
  license: string;
  face: '分部位' | '整脸';
  /**
   * 默认音色：MiniMax 系统音色（见 server/minimaxTts.ts 的 MINIMAX_VOICES）。
   * 照着人设挑的；用户在面板上换过就以用户的为准（按角色存）
   */
  voice?: string;
  /**
   * 以前的千问音色（见 server/qwenTts.ts 的 QWEN_VOICES；本地后端按小写对上）。
   * 配了 MINIMAX_API_KEY 时千问音色是隐藏的，这个用不上；没配 MiniMax 时退回它
   */
  qwenVoice?: string;
  /**
   * 待机时上臂额外外展多少度（在待机动作自带的 6° 之上）。裙子越蓬，垂手时手越容易陷进裙摆：
   * 逐个模型看手部特写定的 —— 詩乃 / 绮拉这类窄裙 0，薇薇的 A 字连衣裙 +3，维多利亚的蓬裙 +6
   */
  armOut?: number;
  /** 不在下拉框里显示（文件和配置都留着，开发时 ?model= 照样能载入）；上次选的是它就回到默认模型 */
  hidden?: boolean;
}

/** QUAPPA-EL 转换的模型（加密的 .vrmx），分部位表情都按语义形状名认 */
function quappa(
  id: string,
  name: string,
  code: string,
  desc: string,
  opts: { editor?: string; voice?: string; qwenVoice?: string; armOut?: number; hidden?: boolean } = {},
): ModelMeta {
  return {
    id,
    name,
    file: `quappa/${code}.vrmx`,
    desc,
    license: `©QUAPPA-ELの巣処${opts.editor ? `（${opts.editor}）` : ''} · 个人非商用`,
    face: '分部位',
    voice: opts.voice,
    qwenVoice: opts.qwenVoice,
    armOut: opts.armOut,
    hidden: opts.hidden,
  };
}

export const MODELS: ModelMeta[] = [
  {
    id: 'avatar_a',
    name: '夏夏',
    file: 'AvatarSample_A.vrm',
    desc: '温柔会倾听 · 棕红短发开衫',
    license: '可商用、可改、可再分发',
    face: '整脸',
    voice: 'minimax:Chinese (Mandarin)_Warm_Girl',
    qwenVoice: 'Cherry',
  },
  {
    id: 'shino',
    name: '诗乃',
    file: 'Sendagaya_Shino.vrm',
    desc: '外冷内热 · 黑长直制服',
    license: 'CC0',
    face: '分部位',
    voice: 'minimax:danya_xuejie',
    qwenVoice: 'Seren',
  },
  quappa('quelle', '库薇勒', 'EL-F3U_Quelle', '要强小女仆 · 猫耳女仆装', {
    editor: 'Edit by SirAyane',
    voice: 'minimax:Chinese (Mandarin)_Crisp_Girl',
    qwenVoice: 'Mia',
    armOut: 8,
  }),
  quappa('menabell', '梅娜贝尔', 'EL-Pr236_Menabell', '话痨发明家 · 圆眼镜红裙', { voice: 'minimax:qiaopi_mengmei', qwenVoice: 'Bunny', armOut: 8 }),
  quappa('kuromatsu', '沙瑠纱', 'EL-Pr238_KUROMATSU', '慢热文艺 · 麻花辫开衫', { voice: 'minimax:Chinese (Mandarin)_Soft_Girl', qwenVoice: 'Nini', armOut: 4 }),
  quappa('fukuharae', '七七春', 'EL-Pr243M1_FUKUHARAE', '慵懒贝斯手 · 猫耳朋克', { voice: 'minimax:female-yujie', qwenVoice: 'Vivian' }),
  quappa('inahade', '露艾卡', 'EL-Pr250_INAHADE', '宅系吐槽 · 眼镜卷发双马尾', { voice: 'minimax:Chinese (Mandarin)_Warm_Bestie', qwenVoice: 'Chelsie' }),
  quappa('rosastout', '萝莎', 'EL-Pr251_Rosastout', '张扬好胜 · 粉发朋克夹克', { voice: 'minimax:Arrogant_Miss', qwenVoice: 'Vivian' }),
  quappa('kotora', '莉莉', 'EL-Pr252_KOTORA', '元气短跑少女 · 橙发麻花辫', { voice: 'minimax:tianxin_xiaoling', qwenVoice: 'Bella', armOut: 5 }),
  {
    id: 'vivi',
    name: '薇薇',
    file: 'Vivi.vrm',
    desc: '元气天然 · 围裙连衣裙',
    license: 'CC0',
    face: '分部位',
    voice: 'minimax:diadia_xuemei',
    qwenVoice: 'Stella',
    armOut: 3,
  },
  {
    id: 'victoria',
    name: '维多利亚',
    file: 'Victoria_Rubin.vrm',
    desc: '傲娇大小姐 · 金粉侧马尾',
    license: 'CC0',
    face: '分部位',
    voice: 'minimax:Chinese (Mandarin)_Mature_Woman',
    qwenVoice: 'Maia',
    armOut: 6,
  },
  {
    id: 'vita',
    name: '维塔',
    file: 'Vita.vrm',
    desc: '理性仿生人 · 白发异瞳',
    license: 'CC0',
    face: '分部位',
    voice: 'minimax:Chinese (Mandarin)_Gentle_Senior',
    qwenVoice: 'Serena',
  },
  {
    id: 'hair_female',
    name: '小夜',
    file: 'HairSample_Female.vrm',
    desc: '嘴硬猫系 · 猫耳双马尾',
    license: 'CC0',
    face: '分部位',
    voice: 'minimax:female-shaonv',
    qwenVoice: 'Momo',
  },
  {
    id: 'avatar_b',
    name: '绮拉',
    file: 'AvatarSample_B.vrm',
    desc: '直率辣妹 · 紫发挑染',
    license: 'VRM 许可：可商用、可改、可再分发',
    face: '分部位',
    voice: 'minimax:wumei_yujie',
    qwenVoice: 'Bellona',
  },
  // 下面的不在下拉框里
  {
    id: 'perfect_sync',
    name: '素',
    file: 'candidates/VRoid_V110_Female.vrm',
    desc: '认真新人 · 灰色素体',
    license: '可商用（作者 README）',
    face: '分部位',
    voice: 'minimax:Chinese (Mandarin)_Sweet_Lady',
    qwenVoice: 'Cherry',
    hidden: true,
  },
  {
    id: 'alicia',
    name: '爱丽西亚',
    file: 'candidates/AliciaSolid.vrm',
    desc: '天真爱幻想 · 金色麻花辫',
    license: 'ニコニ立体ちゃん 利用规约',
    face: '整脸',
    voice: 'minimax:female-tianmei',
    qwenVoice: 'Stella',
    hidden: true,
  },
];

export const DEFAULT_MODEL = MODELS[0];

/** 没设置过背景的角色用这个 */
export const DEFAULT_BACKDROP = 'park' as const;

/** 下拉框里列出来的 */
export const VISIBLE_MODELS = MODELS.filter((m) => !m.hidden);

export const modelUrl = (m: ModelMeta) => `${import.meta.env.BASE_URL}models/${m.file}`;

/**
 * 下拉框里的模型文件在不在（HEAD，不下载内容；隐藏的模型不探测）。
 * Vite 对不存在的路径会回退成 index.html（200），所以要看类型
 */
export async function probeModels(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    VISIBLE_MODELS.map(async (m) => {
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
