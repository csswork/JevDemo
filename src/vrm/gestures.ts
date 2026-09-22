import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { GestureId } from '../act/schema';
import { PoseAccumulator, deg, smoothstep } from './pose';

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
}

const clip = (
  duration: number,
  tracks: BoneTrack[],
  fadeIn = 0.18,
  fadeOut = 0.28,
): GestureClip => ({ duration, fadeIn, fadeOut, tracks });

export const GESTURE_CLIPS: Record<GestureId, GestureClip> = {
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
}

/**
 * 手势层。允许多个 clip 同时在播（比如"点头"叠加"歪头"），
 * 但同一个 clip 重复触发会重置而不是叠加，避免权重爆掉。
 */
export class GestureLayer {
  private active: ActiveGesture[] = [];
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
      return;
    }
    this.active.push({ clip: c, id, time: 0, weight, speed });
  }

  clear() {
    this.active.length = 0;
  }

  get activeIds(): GestureId[] {
    return this.active.map((a) => a.id);
  }

  update(dt: number, acc: PoseAccumulator) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.time += dt * a.speed;
      if (a.time >= a.clip.duration) {
        this.active.splice(i, 1);
        continue;
      }

      // 进出淡化包络，保证与 idle 层的接缝看不出来
      const fin = a.clip.fadeIn > 0 ? smoothstep(a.time / a.clip.fadeIn) : 1;
      const remain = a.clip.duration - a.time;
      const fout = a.clip.fadeOut > 0 ? smoothstep(remain / a.clip.fadeOut) : 1;
      const w = a.weight * Math.min(fin, fout);

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
