import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { GestureId } from '../act/schema';
import { PoseAccumulator, deg, smoothstep } from './pose';
import type { ActiveReach, ReachSpec } from './reach';
import type { Emotion } from '../act/schema';

/**
 * 程序化手势库。
 *
 * 为什么不用 .vrma 文件：能自由下载的 VRMA 动作包极少（VRoid 官方只免费放了 7 个，
 * 还要走 BOOTH 下载），而对话场景真正高频的是点头/摇头/歪头/摊手这类小动作。
 * 用骨骼关键帧写死，既没有素材授权问题，也天然能和 idle 层叠加。
 * 需要接 .vrma 时，@pixiv/three-vrm-animation 走 AnimationMixer 另起一层即可。
 *
 * 坐标约定（VRM 1.0 规范空间）：角色面向 +Z，+Y 向上，角色的左手边为 +X。
 *   绕 X 正向 = 低头      绕 Y 正向 = 向角色左侧转头     绕 Z 正向 = 头顶倒向角色右肩
 *   右臂抬起 = Z 负向     左臂抬起 = Z 正向
 *   右肘前屈 = Y 正向     左肘前屈 = Y 负向
 * VRM 0.x 模型的骨骼局部轴与此相差绕 Y 的 180°，由 GestureLayer 自动对 X/Z 取反，
 * 因此下面所有 clip 只需按 VRM 1.0 规范书写一次。
 */

/** [时间(秒), X(度), Y(度), Z(度)] */
type Key = [number, number, number, number];

interface BoneTrack {
  bone: VRMHumanBoneName;
  keys: Key[];
}

export interface GestureClip {
  duration: number;
  /** 进入/退出淡化时长（秒），保证和 idle 层平滑衔接 */
  fadeIn: number;
  fadeOut: number;
  tracks: BoneTrack[];
  /** 手到脸的 IK 目标。有它时手臂由 IK 求解，tracks 只管头、胸、肩 */
  reach?: ReachSpec;
  /**
   * 表情节奏：[时刻, 情绪, 峰值, 时长]。
   * 只**放大 Jev 已经选中的情绪**（该情绪当前权重 > 0.15 才触发），
   * 不会引入新情绪 —— 情绪是什么仍然由 Jev 决定，动作只负责给它加上节奏。
   */
  accents?: Array<[number, Emotion, number, number]>;
}

const clip = (
  duration: number,
  tracks: BoneTrack[],
  fadeIn = 0.18,
  fadeOut = 0.28,
): GestureClip => ({ duration, fadeIn, fadeOut, tracks });

export const GESTURE_CLIPS: Record<GestureId, GestureClip> = {
  // ===================== 手到脸 =====================
  // 半身景别下唯一看得见的一类。
  //
  // 除了捂嘴惊讶，全部由 ReachLayer（reach.ts）按 IK 求解：spec 只描述"掌心去哪、
  // 手怎么朝向、肘往哪边"，手臂关节角度每帧现算，跟着头和胸走，手指贴着接触面自适应。
  // 每个 spec 的数值都在浏览器里用 src/dev/audit.ts 对着审计数字调过（外推、穿透、
  // 相机视角遮挡真值、手腕和指尖的逐帧位移），各自的注释里记了踩过的坑。
  //
  // 捂嘴惊讶（cover_mouth_gasp）刻意保留成关节角度关键帧（FK）：它是早期在浏览器里
  // 对着世界坐标网格搜出来的，肉眼效果很好，没有理由去动。那一轮标定的经验：
  //   - 要对准掌心（rightMiddleProximal，中指根部），不是 rightHand —— 那是手腕，
  //     掌心还要再往外 0.067
  //   - 只约束终点不够，路径上的上臂、前臂也要离开头部
  //   - 这个模型上臂 0.219、前臂 0.214，肩到嘴只有 0.14，肘部必须抬起并前伸

  /**
   * 掩嘴笑 —— 第一个改成 IK 驱动的动作，后面几个都照这个模式写。
   *
   * 手臂没有任何关节角度，只描述"掌心去哪、手怎么朝向"，由 ReachLayer 每帧求解。
   * tracks 只管头、胸、肩这些 IK 不碰的部分。
   *
   * 节奏上刻意错开：头先歪（0.0s 起），手随后到（0.05s 起、0.62s 到位），
   * 放手比抬手更慢（撤回 0.7s）。胸腔的抖动、手的颤动、表情的脉冲三者同频，
   * 笑起来才是一个整体而不是三个各自在动的零件。
   */
  cover_mouth_laugh: {
    duration: 2.7,
    fadeIn: 0.2,
    fadeOut: 0.5,
    tracks: [
      {
        bone: 'head',
        keys: [
          [0, 0, 0, 0],
          [0.35, 6, -5, 9],
          [2.0, 6, -5, 9],
          [2.6, 0, 0, 0],
        ],
      },
      {
        bone: 'rightShoulder',
        keys: [
          [0, 0, 0, 0],
          [0.4, 0, 0, -4],
          [1.95, 0, 0, -4],
          [2.6, 0, 0, 0],
        ],
      },
      // 笑的时候胸腔会抖，和下面的手部颤动、表情脉冲同频（约 2.8Hz）
      {
        bone: 'chest',
        keys: [
          [0, 0, 0, 0],
          [0.55, 2.2, 0, 0],
          [0.73, 0.4, 0, 0],
          [0.91, 2.2, 0, 0],
          [1.09, 0.4, 0, 0],
          [1.27, 1.8, 0, 0],
          [1.45, 0.5, 0, 0],
          [1.63, 1.2, 0, 0],
          [2.6, 0, 0, 0],
        ],
      },
    ],
    reach: {
      // 掌心在嘴唇前，手指斜向上指向对侧脸颊 —— 指尖朝正上方会直冲鼻梁。
      // 接触约束只用来兜底，姿势本身就应该避开鼻子
      palmOffset: [-0.012, -0.028, 0.125],
      fingerDir: [0.72, 0.68, 0.06],
      palmNormal: [0, 0, -1],
      pole: [-0.25, -0.35, 0.1],
      arc: 0.1,
      times: [0.05, 0.62, 1.95, 2.65],
      curl: [26, 32, 22],
      bob: { amp: 0.004, hz: 2.8 },
    },
    accents: [
      [0.55, 'happy', 0.12, 0.25],
      [0.91, 'happy', 0.12, 0.25],
      [1.27, 'happy', 0.09, 0.25],
    ],
  },

  /** 捂嘴惊讶：同样到嘴前，但进得快、按得实，头微微后仰 */
  cover_mouth_gasp: clip(2.3, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.2, 35, 78, -63],
        [1.75, 35, 78, -63],
        [2.3, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.2, 0, 136, -32],
        [1.75, 0, 136, -32],
        [2.3, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.2, -35, 0, -14],
        [1.75, -35, 0, -14],
        [2.3, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.16, -7, 0, 0],
        [1.75, -5, 0, 0],
        [2.3, 0, 0, 0],
      ],
    },
  ], 0.09, 0.3),

  /**
   * 手贴脸颊：害羞。掌心捧住右脸颊下半，手指斜向太阳穴，头往手里靠一点。
   *
   * 手指方向是在浏览器里对着审计数字调出来的：
   *   - 朝正上方：小指（右手贴右脸时小指在靠鼻子那一侧）直接盖住眼睛
   *   - 太往后倒：手掌翻到脸侧面，从正面看手指全藏到脸的轮廓后面，像插进了脸里
   * 现在指尖离眼睛中心 36mm。撤回路径往外（-X）绕，否则拇指会顺着下颌蹭下去。
   * 从正面看中指尖有一点藏在脸的轮廓后面（贴着太阳穴侧面），这是正常的侧面接触，
   * 接触体确认没有穿进去。
   */
  hand_to_cheek: {
    duration: 3.0,
    fadeIn: 0.2,
    fadeOut: 0.5,
    tracks: [
      {
        bone: 'head',
        keys: [
          [0, 0, 0, 0],
          [0.7, 4, -5, 8],
          [2.3, 4, -5, 8],
          [2.95, 0, 0, 0],
        ],
      },
      {
        bone: 'rightShoulder',
        keys: [
          [0, 0, 0, 0],
          [0.7, 0, 0, -3],
          [2.3, 0, 0, -3],
          [2.95, 0, 0, 0],
        ],
      },
    ],
    reach: {
      palmOffset: [-0.058, 0, 0.085],
      fingerDir: [-0.55, 0.78, -0.2],
      palmNormal: [0.6, 0.05, -0.8],
      pole: [-0.15, -0.4, 0.2],
      arc: [-0.12, 0.02, 0.08],
      times: [0.05, 0.7, 2.3, 2.95],
      curl: [22, 28, 18],
      // 食指在最外侧（靠耳朵），弯多了会绕到脸的轮廓后面，从正面看像插进了太阳穴
      curlScale: [0.4, 1, 1, 1],
      // 掌根（拇指根）贴着下颌，不先抬起的话到位和离开时都会蹭到下颌，整只手被推开 14mm
      standoff: 0.025,
    },
  },

  /**
   * 托下巴：思考。手松松握拳，食指从下方抵住下巴尖，头轻轻压上去。
   *
   * 调这个动作踩过的三个坑（数字都是审计量出来的）：
   *   1. "拳头垫在下巴底下"做不出来：这个模型胸口比下巴往前突出约 4cm，下巴底下还有
   *      领结，前臂竖着上来一定撞胸，整只手被推开 50~75mm
   *   2. 掌心朝后（朝脖子）时，蜷起的手指正对着胸口，手一往下撤就刮到领结，
   *      手指被迫一帧弹开 78mm。改成掌心朝左，拳头往侧面蜷
   *   3. 放松的拇指是张开的，掌心朝左时正好戳进脖子，所以要 thumb 内收
   */
  hand_to_chin: {
    duration: 3.2,
    fadeIn: 0.2,
    fadeOut: 0.5,
    tracks: [
      {
        bone: 'head',
        keys: [
          [0, 0, 0, 0],
          [0.8, 5, -4, 4],
          [2.5, 5, -4, 4],
          [3.15, 0, 0, 0],
        ],
      },
    ],
    reach: {
      palmOffset: [-0.02, -0.072, 0.132],
      fingerDir: [0.1, 0.95, -0.3],
      palmNormal: [0.85, -0.1, -0.3],
      pole: [-0.45, -0.3, 0.3],
      arc: [-0.05, -0.05, 0.2],
      times: [0.05, 0.75, 2.5, 3.15],
      curl: [60, 75, 50],
      curlScale: [0.15, 1, 1.05, 1.1],
      thumb: 45,
    },
  },

  /**
   * 摸后颈：尴尬。肘部抬起外展，手绕到脖子后面来回蹭。
   *
   * 这个模型上臂 0.219、前臂 0.214，后颈离肩关节只有 0.11 左右，手肘要折到 27° 上下，
   * 而且手腕在肩膀后面 —— 这时肘部只能往上、往外，不可能往前。
   * 手在后发下面（后发比后颈厚 9~11cm），从正面看被头和头发挡住，看得见的是抬起的大臂。
   *
   * 调参记录：
   *   - 手指朝上会顶到后脑勺，整只手被推离脖子 30mm。现在横着搭在后颈上
   *   - 手指弯多了，蹭的时候指尖在圆柱形的脖子上时深时浅，允许的弯曲一帧从 1.0
   *     掉到 0.4，指尖跳 30mm。反正正面看不见，手指基本伸平
   *   - 接近路径往外、往上绕过肩膀，不然朝下的拇指会刮到肩头；拇指也内收
   *   - standoff：撤回时先把手从脖子上抬起来再走
   */
  rub_neck: {
    duration: 2.8,
    fadeIn: 0.2,
    fadeOut: 0.5,
    tracks: [
      {
        bone: 'head',
        keys: [
          [0, 0, 0, 0],
          [0.7, 8, 6, 5],
          [2.05, 8, 6, 5],
          [2.75, 0, 0, 0],
        ],
      },
    ],
    reach: {
      palmOffset: [-0.03, -0.055, -0.072],
      fingerDir: [0.9, 0.3, 0.15],
      palmNormal: [0.3, 0, 1],
      pole: [-0.5, 0.35, 0.1],
      arc: [-0.2, 0.22, 0.05],
      times: [0.05, 0.75, 2.05, 2.75],
      curl: [10, 14, 8],
      thumb: 35,
      rub: { dir: [1, 0.2, 0], amp: 0.008, hz: 1.8 },
      standoff: 0.025,
    },
  },

  /**
   * 手抚胸口：松一口气。手掌平贴在胸口上方（领结下面），手指斜向左肩。
   * 目标挂在上胸骨骼上，呼吸起伏时手跟着动。
   *
   * 两处要点：
   *   - 肘部要往前。肘垂在体侧时前臂从侧面斜穿过右胸，整只手被推开 40~60mm
   *   - 放松的拇指偏向掌心一侧约 25mm，手掌一平贴拇指就戳进胸口（推开 80mm），
   *     所以 thumb 取负值，把拇指放平到手掌平面里
   */
  hand_on_chest: {
    duration: 3.0,
    fadeIn: 0.2,
    fadeOut: 0.5,
    tracks: [
      {
        bone: 'head',
        keys: [
          [0, 0, 0, 0],
          [0.65, 6, 0, 0],
          [2.3, 5, 0, 0],
          [2.95, 0, 0, 0],
        ],
      },
      {
        bone: 'chest',
        keys: [
          [0, 0, 0, 0],
          [0.8, 2.5, 0, 0],
          [1.8, -1.5, 0, 0],
          [2.95, 0, 0, 0],
        ],
      },
    ],
    reach: {
      anchor: 'upperChest',
      palmOffset: [0.01, 0.025, 0.105],
      fingerDir: [0.8, 0.47, -0.37],
      palmNormal: [0, -0.62, -0.78],
      pole: [-0.25, -0.35, 0.35],
      arc: 0.06,
      times: [0.05, 0.7, 2.3, 2.95],
      curl: [6, 10, 6],
      thumb: -25,
      standoff: 0.015,
    },
  },

  /**
   * 手扶额头：无奈。头往下低，手掌压在刘海上，手指斜向左上方。
   * 刘海比额头皮肤往前 9~13mm，接触面用的是刘海（ReachLayer 的 bangs 碰撞体），
   * 不然手掌会陷进头发里。
   */
  palm_forehead: {
    duration: 3.0,
    fadeIn: 0.2,
    fadeOut: 0.5,
    tracks: [
      {
        bone: 'head',
        keys: [
          [0, 0, 0, 0],
          [0.6, 12, -3, 4],
          [2.3, 11, -3, 4],
          [2.95, 0, 0, 0],
        ],
      },
      {
        bone: 'rightShoulder',
        keys: [
          [0, 0, 0, 0],
          [0.6, 0, 0, -4],
          [2.3, 0, 0, -4],
          [2.95, 0, 0, 0],
        ],
      },
    ],
    reach: {
      palmOffset: [0, 0.125, 0.135],
      fingerDir: [0.75, 0.63, -0.19],
      palmNormal: [0, -0.29, -0.96],
      pole: [-0.35, -0.15, 0.25],
      arc: 0.1,
      times: [0.05, 0.6, 2.3, 2.95],
      curl: [8, 12, 8],
    },
  },
  // ===================== 身体动作 =====================
  // 胸像景别下手垂在画面外，基本看不见，保留给全身景别。
  // 挥手：抬臂 → 小臂左右摆三次 → 放下
  wave: clip(2.0, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.35, -8, 18, -95],
        [1.5, -8, 18, -95],
        [2.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, 22, -10],
        [0.62, 0, 22, -32],
        [0.88, 0, 22, 8],
        [1.14, 0, 22, -32],
        [1.4, 0, 22, 4],
        [1.5, 0, 22, -10],
        [2.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.4, 0, 0, -12],
        [1.5, 0, 0, -12],
        [2.0, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.5, -3, 0, 4],
        [1.5, -3, 0, 4],
        [2.0, 0, 0, 0],
      ],
    },
  ]),

  // 打招呼的轻量版：手抬到胸口高度晃两下，适合句中插入
  wave_small: clip(1.2, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 12, -48],
        [0.9, 0, 12, -48],
        [1.2, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 38, -12],
        [0.55, 0, 38, -26],
        [0.8, 0, 38, 0],
        [0.9, 0, 38, -12],
        [1.2, 0, 0, 0],
      ],
    },
  ]),

  // 点头两次，幅度递减 —— 等幅点头是最典型的"机器人感"来源
  nod: clip(1.0, [
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.18, 13, 0, 0],
        [0.36, -2, 0, 0],
        [0.54, 8, 0, 0],
        [0.72, -1, 0, 0],
        [1.0, 0, 0, 0],
      ],
    },
    {
      bone: 'neck',
      keys: [
        [0, 0, 0, 0],
        [0.18, 6, 0, 0],
        [0.54, 4, 0, 0],
        [1.0, 0, 0, 0],
      ],
    },
  ]),

  shake_head: clip(1.1, [
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.2, 0, 16, 0],
        [0.45, 0, -16, 0],
        [0.7, 0, 11, 0],
        [0.9, 0, -5, 0],
        [1.1, 0, 0, 0],
      ],
    },
    {
      bone: 'neck',
      keys: [
        [0, 0, 0, 0],
        [0.2, 0, 6, 0],
        [0.45, 0, -6, 0],
        [1.1, 0, 0, 0],
      ],
    },
  ]),

  // 歪头：保持时间长一些，配合疑问句
  tilt_head: clip(1.8, [
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.4, -4, 7, 15],
        [1.4, -4, 7, 15],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'neck',
      keys: [
        [0, 0, 0, 0],
        [0.4, 0, 3, 7],
        [1.4, 0, 3, 7],
        [1.8, 0, 0, 0],
      ],
    },
  ]),

  shrug: clip(1.6, [
    {
      bone: 'leftShoulder',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, 0, 14],
        [1.1, 0, 0, 14],
        [1.6, 0, 0, 0],
      ],
    },
    {
      bone: 'rightShoulder',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, 0, -14],
        [1.1, 0, 0, -14],
        [1.6, 0, 0, 0],
      ],
    },
    {
      bone: 'leftUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, -14, 22],
        [1.1, 0, -14, 22],
        [1.6, 0, 0, 0],
      ],
    },
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, 14, -22],
        [1.1, 0, 14, -22],
        [1.6, 0, 0, 0],
      ],
    },
    {
      bone: 'leftLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, -52, 0],
        [1.1, 0, -52, 0],
        [1.6, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, 52, 0],
        [1.1, 0, 52, 0],
        [1.6, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.35, 0, 0, 8],
        [1.1, 0, 0, 8],
        [1.6, 0, 0, 0],
      ],
    },
  ]),

  // 指自己（"我" / "我觉得"）
  point_self: clip(1.4, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 30, -28],
        [1.0, 0, 30, -28],
        [1.4, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 72, -18],
        [1.0, 0, 72, -18],
        [1.4, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 12, -18],
        [1.0, 0, 12, -18],
        [1.4, 0, 0, 0],
      ],
    },
  ]),

  // 双手摊开呈现（"就是这样" / 介绍某件事）
  present: clip(1.8, [
    {
      bone: 'leftUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.4, 0, -22, 26],
        [1.2, 0, -22, 26],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.4, 0, 22, -26],
        [1.2, 0, 22, -26],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'leftLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.4, 0, -44, 12],
        [1.2, 0, -38, 12],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.4, 0, 44, -12],
        [1.2, 0, 38, -12],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'leftHand',
      keys: [
        [0, 0, 0, 0],
        [0.5, -22, 0, 0],
        [1.2, -22, 0, 0],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.5, -22, 0, 0],
        [1.2, -22, 0, 0],
        [1.8, 0, 0, 0],
      ],
    },
  ]),

  // 思考：手托下巴 + 视线偏移由 gaze 轨道另行负责
  think: clip(2.4, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.45, 0, 24, -34],
        [1.9, 0, 24, -34],
        [2.4, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.45, 0, 88, -22],
        [1.9, 0, 88, -22],
        [2.4, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.45, 0, 16, -10],
        [1.9, 0, 16, -10],
        [2.4, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.5, -6, -8, -6],
        [1.9, -6, -8, -6],
        [2.4, 0, 0, 0],
      ],
    },
  ]),

  // 身体前倾，表示"有兴趣 / 凑近听"
  lean_in: clip(2.2, [
    {
      bone: 'spine',
      keys: [
        [0, 0, 0, 0],
        [0.5, 6, 0, 0],
        [1.7, 6, 0, 0],
        [2.2, 0, 0, 0],
      ],
    },
    {
      bone: 'chest',
      keys: [
        [0, 0, 0, 0],
        [0.5, 4, 0, 0],
        [1.7, 4, 0, 0],
        [2.2, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.5, -5, 0, 0],
        [1.7, -5, 0, 0],
        [2.2, 0, 0, 0],
      ],
    },
  ]),

  bow: clip(2.0, [
    {
      bone: 'spine',
      keys: [
        [0, 0, 0, 0],
        [0.5, 16, 0, 0],
        [1.1, 16, 0, 0],
        [2.0, 0, 0, 0],
      ],
    },
    {
      bone: 'chest',
      keys: [
        [0, 0, 0, 0],
        [0.5, 10, 0, 0],
        [1.1, 10, 0, 0],
        [2.0, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.5, 14, 0, 0],
        [1.1, 14, 0, 0],
        [2.0, 0, 0, 0],
      ],
    },
  ]),

  clap: clip(1.8, [
    {
      bone: 'leftUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, -30, 34],
        [1.3, 0, -30, 34],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 30, -34],
        [1.3, 0, 30, -34],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'leftLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, -62, 0],
        [0.5, 0, -74, 0],
        [0.7, 0, -62, 0],
        [0.9, 0, -74, 0],
        [1.1, 0, -62, 0],
        [1.3, 0, -74, 0],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.3, 0, 62, 0],
        [0.5, 0, 74, 0],
        [0.7, 0, 62, 0],
        [0.9, 0, 74, 0],
        [1.1, 0, 62, 0],
        [1.3, 0, 74, 0],
        [1.8, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.4, 5, 0, 0],
        [1.3, 5, 0, 0],
        [1.8, 0, 0, 0],
      ],
    },
  ]),
};

/** 在关键帧之间做 smoothstep 插值，避免线性插值的机械感。 */
function sampleTrack(keys: Key[], t: number, out: [number, number, number]) {
  if (t <= keys[0][0]) {
    out[0] = keys[0][1];
    out[1] = keys[0][2];
    out[2] = keys[0][3];
    return;
  }
  const last = keys[keys.length - 1];
  if (t >= last[0]) {
    out[0] = last[1];
    out[1] = last[2];
    out[2] = last[3];
    return;
  }
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1];
      const b = keys[i];
      const span = b[0] - a[0];
      const k = span <= 0 ? 0 : smoothstep((t - a[0]) / span);
      out[0] = a[1] + (b[1] - a[1]) * k;
      out[1] = a[2] + (b[2] - a[2]) * k;
      out[2] = a[3] + (b[3] - a[3]) * k;
      return;
    }
  }
}

interface ActiveGesture {
  clip: GestureClip;
  id: GestureId;
  time: number;
  weight: number;
  speed: number;
  /** 这次触发的 IK 状态（接近起点等），每次 play 重建 */
  reachState: ActiveReach['state'];
}

/**
 * 手势层。允许多个 clip 同时在播（比如"点头"叠加"歪头"），
 * 但同一个 clip 重复触发会重置而不是叠加，避免权重爆掉。
 */
export class GestureLayer {
  private active: ActiveGesture[] = [];
  /**
   * 冻结：停止推进 clip 时间，把当前姿势定住。
   * 只给预览用 —— clip 只有 2~3 秒，想看清楚一个手势根本来不及。
   */
  frozen = false;
  private sample: [number, number, number] = [0, 0, 0];
  /** VRM 0.x 骨骼轴相对 VRM 1.0 规范绕 Y 翻转 180°，等价于对 X/Z 分量取反 */
  private axisFlip = 1;

  setVrmVersion(metaVersion: string | undefined) {
    this.axisFlip = metaVersion === '0' ? -1 : 1;
  }

  play(id: GestureId, weight = 1, speed = 1) {
    const c = GESTURE_CLIPS[id];
    if (!c) return;
    const existing = this.active.find((a) => a.id === id);
    if (existing) {
      existing.time = 0;
      existing.weight = weight;
      existing.speed = speed;
      existing.reachState = {};
      return;
    }
    this.active.push({ clip: c, id, time: 0, weight, speed, reachState: {} });
  }

  clear() {
    this.active.length = 0;
  }

  /**
   * 预览用：把正在播的手势跳到指定时刻。手势已经播完的话，按原 id 重新挂上。
   * 往回拖进接近段时沿用这次触发记录的起点，轨迹和正常播放完全一致。
   */
  seek(id: GestureId, t: number) {
    let a = this.active.find((g) => g.id === id);
    if (!a) {
      const c = GESTURE_CLIPS[id];
      if (!c) return;
      a = { clip: c, id, time: 0, weight: 1, speed: 1, reachState: {} };
      this.active.push(a);
    }
    a.time = Math.max(0, Math.min(a.clip.duration - 1e-3, t));
  }

  setSpeed(speed: number) {
    for (const a of this.active) a.speed = speed;
  }

  /** 预览面板读取：当前手势的时间、时长，以及 IK 的阶段分界 */
  info(): { id: GestureId; time: number; duration: number; phases?: number[] } | null {
    const a = this.active[0];
    if (!a) return null;
    return { id: a.id, time: a.time, duration: a.clip.duration, phases: a.clip.reach?.times };
  }

  /** 当前需要 IK 求解的手势（同一时刻只取一个，右手只有一只） */
  activeReach(): ActiveReach | null {
    const a = this.active.find((g) => g.clip.reach);
    return a ? { spec: a.clip.reach!, time: a.time, state: a.reachState } : null;
  }

  /** 本帧新越过的表情节奏点，由 Character 转交给表情层 */
  private pendingAccents: Array<[Emotion, number, number]> = [];
  takeAccents() {
    const out = this.pendingAccents;
    this.pendingAccents = [];
    return out;
  }

  get activeIds(): GestureId[] {
    return this.active.map((a) => a.id);
  }

  update(dt: number, acc: PoseAccumulator) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      const prev = a.time;
      if (!this.frozen) a.time += dt * a.speed;
      if (!this.frozen) {
        for (const [t, emo, peak, dur] of a.clip.accents ?? []) {
          if (prev < t && a.time >= t) this.pendingAccents.push([emo, peak, dur]);
        }
      }
      if (a.time >= a.clip.duration) {
        this.active.splice(i, 1);
        continue;
      }

      // 进出淡化包络，保证与 idle 层的接缝看不出来
      const fin = a.clip.fadeIn > 0 ? smoothstep(a.time / a.clip.fadeIn) : 1;
      const remain = a.clip.duration - a.time;
      const fout = a.clip.fadeOut > 0 ? smoothstep(remain / a.clip.fadeOut) : 1;
      const w = a.weight * (this.frozen ? 1 : Math.min(fin, fout));

      for (const track of a.clip.tracks) {
        sampleTrack(track.keys, a.time, this.sample);
        acc.add(
          track.bone,
          deg(this.sample[0]) * this.axisFlip,
          deg(this.sample[1]),
          deg(this.sample[2]) * this.axisFlip,
          w,
        );
      }
    }
  }
}

/** 从 VRM 读出 meta 版本，供 GestureLayer 决定轴向。 */
export function vrmMetaVersion(vrm: VRM): string | undefined {
  return (vrm.meta as { metaVersion?: string } | undefined)?.metaVersion;
}
