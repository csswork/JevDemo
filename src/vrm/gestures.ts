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
  // 下面的角度不是估出来的，是在浏览器里对着世界坐标网格搜索标定的：
  // 固定住 clip、逐帧读 rightHand 的世界坐标，向目标点（嘴 / 下巴 / 脸颊 /
  // 额头 / 后颈 / 胸口）逼近。解析推不准 —— 肩→肘→腕三层坐标系复合，
  // 而且前臂的旋转轴会跟着上臂一起转。
  //
  // 一个绕不开的结论：这个模型肩到嘴的直线距离只有 0.14，而上臂就有 0.29、
  // 前臂 0.21。要够到脸，**肘部必须抬起并前伸**（实测肘部 z≈0.20），
  // 这是二次元比例决定的，不是姿势没调好。硬把肘压低，手就到不了脸。
  //
  // 另一个教训：只优化手的位置会得到"肘比手还高"的怪姿势。胸口那条加了
  // 肘部高度和前伸量的惩罚项才搜出自然的解。
  //
  // 第二轮标定（在测试预览面板里肉眼验收后返工）：
  //   1. 第一轮对准的是 rightHand 骨骼 —— 那是**手腕**，掌心还要再往外 0.067。
  //      结果手贴脸颊举到了太阳穴、扶额挡在鼻梁正中。现在对准掌心
  //      （rightMiddleProximal，中指根部）。
  //   2. 只约束了终点没约束路径。摸后颈的手腕确实到了脖子后面，但肘在脸前方，
  //      前臂从脸中间穿过去。现在上臂、前臂两段都要求离头部中心 > 0.10。
  //   3. 第一轮没搜上臂的 X 轴扭转，第二轮的四个解都用上了它。
  //   4. 掌心到位不等于手势对：手贴脸颊的掌心误差只有 0.005，手指却往上张开
  //      挡住了眼睛。又单独搜了一轮手腕，约束指尖不许高过眼睛。

  /**
   * 掩嘴笑 —— 第一个改成 IK 驱动的动作。
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
      palmOffset: [-0.005, -0.015, 0.13],
      fingerDir: [0.45, 0.88, 0.05],
      palmNormal: [0, 0, -1],
      pole: [-0.25, -0.35, 0.1],
      arc: 0.1,
      times: [0.05, 0.62, 1.95, 2.65],
      curl: [18, 22, 14],
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

  /** 手贴脸颊：害羞，头往手的方向偏一点 */
  hand_to_cheek: clip(3.0, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.55, 38, 98, -75],
        [2.4, 38, 98, -75],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.55, 0, 155, -26],
        [2.4, 0, 155, -26],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.55, 0, -20, 0],
        [2.4, 0, -20, 0],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.6, 4, -7, -10],
        [2.4, 4, -7, -10],
        [3.0, 0, 0, 0],
      ],
    },
  ]),

  /** 托腮 / 摸下巴：思考。标定误差最小的一条（0.004） */
  hand_to_chin: clip(3.2, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.55, 0, 85, -60],
        [2.6, 0, 85, -60],
        [3.2, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.55, 0, 130, -25],
        [2.6, 0, 130, -25],
        [3.2, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.55, -12, 0, -10],
        [2.6, -12, 0, -10],
        [3.2, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.65, 4, -5, -4],
        [2.6, 4, -5, -4],
        [3.2, 0, 0, 0],
      ],
    },
  ]),

  /** 摸后颈：尴尬。肘部高抬外展，前臂往后折，还要来回蹭两下 */
  rub_neck: clip(2.8, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.5, -32, 23, -92],
        [2.2, -32, 23, -92],
        [2.8, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.5, 27, 0, -28],
        [2.2, 27, 0, -28],
        [2.8, 0, 0, 0],
      ],
    },
    // 前臂围绕标定值 148° 来回蹭
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.5, 0, 148, -17],
        [1.0, 0, 156, -17],
        [1.5, 0, 140, -17],
        [2.0, 0, 152, -17],
        [2.2, 0, 148, -17],
        [2.8, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.6, 8, 6, 5],
        [2.2, 8, 6, 5],
        [2.8, 0, 0, 0],
      ],
    },
  ]),

  /** 手抚胸口：松一口气。肘垂在体侧，是唯一一条肘部不用抬高的 */
  hand_on_chest: clip(3.0, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.55, 0, 50, 0],
        [2.4, 0, 50, 0],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.55, 0, 110, 0],
        [2.4, 0, 110, 0],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.55, -22, 0, -16],
        [2.4, -22, 0, -16],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.65, 6, 0, 0],
        [2.4, 5, 0, 0],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'chest',
      keys: [
        [0, 0, 0, 0],
        [0.8, 2.5, 0, 0],
        [1.8, -1.5, 0, 0],
        [3.0, 0, 0, 0],
      ],
    },
  ]),

  /** 手撑额头：无奈。手臂够不到更高，落在眉骨处（标定误差 0.046） */
  palm_forehead: clip(3.0, [
    {
      bone: 'rightUpperArm',
      keys: [
        [0, 0, 0, 0],
        [0.5, 15, 85, -75],
        [2.4, 15, 85, -75],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightLowerArm',
      keys: [
        [0, 0, 0, 0],
        [0.5, 0, 150, -50],
        [2.4, 0, 150, -50],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'rightHand',
      keys: [
        [0, 0, 0, 0],
        [0.5, -39, 0, -15],
        [2.4, -39, 0, -15],
        [3.0, 0, 0, 0],
      ],
    },
    {
      bone: 'head',
      keys: [
        [0, 0, 0, 0],
        [0.6, 13, 0, 0],
        [2.4, 12, 0, 0],
        [3.0, 0, 0, 0],
      ],
    },
  ]),

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

  /** 预览：跳到 clip 的保持段并冻结，方便逐个肉眼验收。 */
  preview(id: GestureId) {
    const c = GESTURE_CLIPS[id];
    if (!c) return;
    this.active.length = 0;
    // 取姿势最完整的一帧：有 IK 的取保持段中点，否则取 fadeIn 与 fadeOut 之间的中点
    const t = c.reach
      ? (c.reach.times[1] + c.reach.times[2]) / 2
      : (c.fadeIn + (c.duration - c.fadeOut)) / 2;
    this.active.push({ clip: c, id, time: t, weight: 1, speed: 1, reachState: {} });
    this.frozen = true;
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
      for (const [t, emo, peak, dur] of a.clip.accents ?? []) {
        if (prev < t && a.time >= t) this.pendingAccents.push([emo, peak, dur]);
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
