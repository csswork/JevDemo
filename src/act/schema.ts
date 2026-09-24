/**
 * Act IR —— Jev 与渲染层之间的唯一契约。
 *
 * 设计要点：
 * 1. 四条独立轨道（expression / gesture / gaze / posture），而不是一个整块动作。
 *    一句话一个表情是数字人显得僵硬的头号原因。
 * 2. 所有 id 都是**闭集枚举**。LLM 自由发挥出来的动作名映射不到 clip 库，
 *    所以词表必须在这里定死，并原样写进 Jev 的 output schema。
 * 3. 时间锚点优先用内联标记（见 anchors.ts），而不是绝对秒数 ——
 *    决策发生时 TTS 时长还未知。二期换成实时语音流时这套锚点原样可用。
 */

/** VRM 1.0 标准表情槽，三方模型通用。three-vrm 会把 VRM 0.x 的 joy/sorrow/fun 自动归一到这套命名。 */
export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
export type Emotion = (typeof EMOTIONS)[number];

/**
 * 手势 clip 词表。新增动作 = 在 vrm/gestures.ts 里加一条，然后加到这里。
 *
 * 分两组：
 *   手到脸（hand-to-face）—— 半身景别下**唯一看得见**的一类，和表情耦合，
 *                            由 Jev 的情绪判断推导出来，是当前默认启用的。
 *   身体动作            —— 全身景别才有意义，胸像里手垂在画面外，默认不触发。
 */
export const GESTURES = [
  // 手到脸
  'cover_mouth_laugh',
  'cover_mouth_gasp',
  'hand_to_cheek',
  'hand_to_chin',
  'rub_neck',
  'hand_on_chest',
  'palm_forehead',
  // 身体
  'wave',
  'wave_small',
  'nod',
  'shake_head',
  'tilt_head',
  'shrug',
  'point_self',
  'present',
  'think',
  'lean_in',
  'bow',
  'clap',
] as const;
export type GestureId = (typeof GESTURES)[number];

/** 全身待机基调。决定"这个人此刻整体是什么状态"，比手势的时间尺度长得多。 */
export const POSTURES = ['idle_neutral', 'idle_cheerful', 'idle_low', 'idle_alert'] as const;
export type PostureId = (typeof POSTURES)[number];

/**
 * 对话节奏信号：问句末尾睁眼、感叹时一闪、句界眨眼、笑声的起伏。
 * **不带情绪**，由时间轴按台词的标点派生（timeline.ts），不需要 Jev 判断 ——
 * 情绪是什么由 Jev 决定，这些只是"说话的人脸上本来就有的节奏"。
 */
export const CUES = ['question', 'emphasis', 'boundary', 'laugh'] as const;
export type Cue = (typeof CUES)[number];

/** 视线目标。camera = 看着用户。 */
export const GAZE_TARGETS = ['camera', 'away_left', 'away_right', 'down', 'up'] as const;
export type GazeTarget = (typeof GAZE_TARGETS)[number];

/**
 * 时间引用。
 * - number：相对语音开始的秒数
 * - { anchor }：指向 speech 里的 `<b:name>` 标记，在 TTS 时长已知后才解析成绝对时间
 */
export type TimeRef = number | { anchor: string };

export interface ExpressionBeat {
  at: TimeRef;
  preset: Emotion;
  /** 0..1 */
  weight: number;
  /** 交叉淡入时长（秒），默认 0.25 */
  fade?: number;
}

export interface GestureBeat {
  at: TimeRef;
  clip: GestureId;
  /** 0..1，叠加到 idle 层上的权重，默认 1 */
  weight?: number;
  /** 播放速度倍率，默认 1 */
  speed?: number;
}

export interface GazeBeat {
  at: TimeRef;
  target: GazeTarget;
  /** 保持多久后回到 camera（秒）。省略 = 一直保持 */
  hold?: number;
}

export interface ActScript {
  /** 台词。可含内联锚点 `<b:wave>`，渲染/TTS 前会被剥离。 */
  speech: string;
  /** 情绪坐标，供 idle 层做连续调制（不是离散表情）。 */
  emotion: { valence: number; arousal: number };
  tracks: {
    posture: PostureId;
    expression: ExpressionBeat[];
    gesture: GestureBeat[];
    gaze: GazeBeat[];
  };
}

/**
 * 基线表演。
 *
 * 渐进式管线的第一段：输入层一返回台词就用它开口，不等判断层。
 * 判断层的结果后到之后再升级还没触发的节拍（见 timeline.ts 的 upgrade）。
 *
 * 所以它要满足两个条件：中性到任何情绪的过渡都不突兀；本身别太死板 ——
 * 配上 idle 层的呼吸和微表情，判断层挂掉时也能当兜底用。
 */
export function baselineAct(speech: string, seed?: Array<[Emotion, number]> | null): ActScript {
  const arr = [...speech];
  const mid = Math.max(1, Math.round(arr.length * 0.6));
  // 有倾听反应（Jev 对用户那句话的第一反应）就带着它开口，句子后半段收一点；
  // 这样整句的判断晚到时，开头几个字也不是一张空白的脸
  const expression: ExpressionBeat[] = seed?.length
    ? [
        ...seed.map(([preset, weight]) => ({ at: 0, preset, weight, fade: 0.3 })),
        ...seed.map(([preset, weight]) => ({
          at: { anchor: 'settle' },
          preset,
          weight: weight * 0.7,
          fade: 0.5,
        })),
      ]
    : [
        { at: 0, preset: 'neutral', weight: 1, fade: 0.25 },
        { at: { anchor: 'settle' }, preset: 'relaxed', weight: 0.35, fade: 0.4 },
      ];
  return {
    speech: arr.slice(0, mid).join('') + '<b:settle>' + arr.slice(mid).join(''),
    emotion: { valence: 0.1, arousal: 0.3 },
    tracks: {
      posture: 'idle_neutral',
      expression,
      gesture: [],
      gaze: [{ at: 0, target: 'camera' }],
    },
  };
}

/** 兜底脚本：任何一环出错都不应该让角色卡死。 */
export function fallbackAct(speech: string): ActScript {
  return {
    speech,
    emotion: { valence: 0, arousal: 0.2 },
    tracks: {
      posture: 'idle_neutral',
      expression: [{ at: 0, preset: 'neutral', weight: 1 }],
      gesture: [],
      gaze: [{ at: 0, target: 'camera' }],
    },
  };
}

/** 对来自外部（Jev / LLM）的脚本做防御性校验，非法值就近修正而不是抛错。 */
export function sanitizeAct(raw: unknown, fallbackSpeech = '……'): ActScript {
  const r = (raw ?? {}) as Partial<ActScript>;
  const speech = typeof r.speech === 'string' && r.speech.trim() ? r.speech : fallbackSpeech;
  const base = fallbackAct(speech);
  if (!r.tracks) return base;

  const inSet = <T extends readonly string[]>(set: T, v: unknown): v is T[number] =>
    typeof v === 'string' && (set as readonly string[]).includes(v);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const time = (v: unknown): TimeRef => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof (v as { anchor?: unknown }).anchor === 'string') {
      return { anchor: (v as { anchor: string }).anchor };
    }
    return 0;
  };

  return {
    speech,
    emotion: {
      valence: Math.max(-1, Math.min(1, num(r.emotion?.valence, 0))),
      arousal: Math.max(0, Math.min(1, num(r.emotion?.arousal, 0.2))),
    },
    tracks: {
      posture: inSet(POSTURES, r.tracks.posture) ? r.tracks.posture : 'idle_neutral',
      expression: (r.tracks.expression ?? [])
        .filter((b) => inSet(EMOTIONS, b?.preset))
        .map((b) => ({
          at: time(b.at),
          preset: b.preset,
          weight: Math.max(0, Math.min(1, num(b.weight, 1))),
          fade: Math.max(0, num(b.fade, 0.25)),
        })),
      gesture: (r.tracks.gesture ?? [])
        .filter((b) => inSet(GESTURES, b?.clip))
        .map((b) => ({
          at: time(b.at),
          clip: b.clip,
          weight: Math.max(0, Math.min(1, num(b.weight, 1))),
          speed: Math.max(0.25, Math.min(3, num(b.speed, 1))),
        })),
      gaze: (r.tracks.gaze ?? [])
        .filter((b) => inSet(GAZE_TARGETS, b?.target))
        .map((b) => ({ at: time(b.at), target: b.target, hold: b.hold })),
    },
  };
}
