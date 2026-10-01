import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { PostureId } from '../act/schema';
import { PoseAccumulator, damp, deg, noise } from './pose';

/**
 * 手指层 —— 待机时手的自然弯曲和细微的随机变化。
 *
 * 动捕待机（ChatVRM 的 idle_loop）只有手腕，没有手指轨道；VRM 的静止姿势是 T-pose 的平手，
 * 所以不加这一层时手指一直绷得笔直、五指张开、拇指支棱在外面，像两块板子。
 *
 * 三部分叠在一起：
 *   自然弯曲  放松垂手时的样子：从食指到小指越来越弯、并拢一点，拇指收在食指旁边
 *   缓慢漂移  每根手指各自的伪噪声 + 整只手的松紧，周期 6~16s、幅度几度 —— 和身体的待机一样"活着"，
 *            两只手各走各的
 *   小动作    每只手隔 7~18 秒随机来一下：轻轻握一下、某根手指动一下、拇指在食指上蹭两下
 *
 * 姿态（Jev 定的 posture）改变整只手的松紧：开心时手更松更开，低落 / 警觉时更收；
 * 激动程度（arousal）让漂移和小动作都快一点、勤一点 —— 和 idle 层同一个道理。
 *
 * 上层动作（VRoid 的动捕带完整的手指）在播时按 (1 - 动作权重) 让出来（PoseAccumulator.scale）。
 *
 * 角度都按 VRM 1.0 规范空间里的**左手**写（度，[绕 X, 绕 Y, 绕 Z]）：
 *   X = 沿手指的轴（自转）  Y = 侧摆（正 = 往小指一侧）  Z = 弯曲（负 = 往掌心弯）
 * 右手镜像（Y、Z 取反），VRM 0.x 再把 X、Z 取反（和 idle 层一样）。
 * 弯曲的方向和量级参考了 VRoid 官方动捕开头垂手那几帧的手指（用 `__hands` 截特写对比定的）。
 */

type Side = 'left' | 'right';
type Finger = 'Index' | 'Middle' | 'Ring' | 'Little';
const FINGERS: Finger[] = ['Index', 'Middle', 'Ring', 'Little'];
const SEGS = ['Proximal', 'Intermediate', 'Distal'] as const;

/** 放松垂手时每根手指三节的弯曲（度：近节 / 中节 / 远节） */
const CURL: Record<Finger, [number, number, number]> = {
  Index: [14, 18, 8],
  Middle: [18, 22, 10],
  Ring: [22, 24, 11],
  Little: [26, 24, 12],
};
/** 近节的侧摆（度，正 = 往小指一侧）：并拢一点 —— 静止姿势的五指是张开的 */
const SPREAD: Record<Finger, number> = { Index: 4, Middle: 0.5, Ring: -3, Little: -7 };
/** 弯曲往下两节传的比例：真手的指间关节是联动的，近节动，中节、远节跟着动 */
const COUPLE = [1, 0.8, 0.5];

/** 姿态 → 整只手多弯几度（松紧） */
const TENSION: Record<PostureId, number> = {
  idle_neutral: 0,
  idle_cheerful: -3,
  idle_low: 3,
  idle_alert: 4,
};

type FidgetKind = 'grip' | 'twitch' | 'rub';

interface Fidget {
  kind: FidgetKind;
  t: number;
  dur: number;
  /** twitch 动哪根手指 */
  finger: Finger;
  /** 幅度系数（0.7~1.2），每次不一样 */
  amp: number;
}

interface HandState {
  seed: number;
  /** 离下一个小动作还有几秒 */
  next: number;
  fidget: Fidget | null;
}

/** 两头导数为 0 的鼓包：0 → 1 → 0 */
const bump = (u: number) => Math.sin(Math.PI * Math.max(0, Math.min(1, u))) ** 2;
const ease = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};

/** 可复现的随机数（截图对比时每次一样） */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HandLayer {
  private t = 0;
  private axisFlip = 1;
  private arousal = 0.2;
  private tensionTarget = 0;
  private tension = 0;
  private rnd = mulberry32(20261001);
  private hands: Record<Side, HandState> = {
    left: { seed: 1.3, next: 4 + this.rnd() * 6, fidget: null },
    right: { seed: 7.9, next: 8 + this.rnd() * 8, fidget: null },
  };

  setVrmVersion(metaVersion: string | undefined) {
    this.axisFlip = metaVersion === '0' ? -1 : 1;
  }

  setPosture(p: PostureId) {
    this.tensionTarget = TENSION[p] ?? 0;
  }

  setArousal(a: number) {
    this.arousal = Math.max(0, Math.min(1, a));
  }

  /** 正在做的小动作（调试用） */
  get fidgets(): Record<Side, FidgetKind | null> {
    return { left: this.hands.left.fidget?.kind ?? null, right: this.hands.right.fidget?.kind ?? null };
  }

  private start(h: HandState) {
    const r = this.rnd();
    const kind: FidgetKind = r < 0.4 ? 'grip' : r < 0.7 ? 'twitch' : 'rub';
    const dur = kind === 'grip' ? 2.4 + this.rnd() * 1.4 : kind === 'twitch' ? 0.8 + this.rnd() * 0.5 : 1.6 + this.rnd() * 0.8;
    // 动的多半是食指（最灵活），偶尔中指
    const finger: Finger = this.rnd() < 0.7 ? 'Index' : 'Middle';
    h.fidget = { kind, t: 0, dur, finger, amp: 0.7 + this.rnd() * 0.5 };
  }

  update(dt: number, acc: PoseAccumulator) {
    const rate = 0.85 + this.arousal * 0.45;
    this.t += dt * rate;
    this.tension = damp(this.tension, this.tensionTarget, 1.5, dt);
    for (const side of ['left', 'right'] as const) this.updateHand(side, dt * rate, acc);
  }

  private updateHand(side: Side, dt: number, acc: PoseAccumulator) {
    const h = this.hands[side];
    const t = this.t;
    const s = h.seed;

    // ---- 小动作 ----
    if (!h.fidget) {
      h.next -= dt;
      if (h.next <= 0) this.start(h);
    }
    let grip = 0;
    let twitch = 0;
    let rub = 0;
    let rubSwing = 0;
    const f = h.fidget;
    if (f) {
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) {
        h.fidget = null;
        h.next = 7 + this.rnd() * 11;
      } else if (f.kind === 'grip') {
        // 轻轻握一下：0.3 收拢 → 停一会 → 慢慢松开
        grip = ease(u / 0.3) * (1 - ease((u - 0.55) / 0.45)) * f.amp;
      } else if (f.kind === 'twitch') {
        twitch = bump(u) * f.amp;
      } else {
        // 拇指在食指侧面来回蹭两下半
        rub = bump(u) * f.amp;
        rubSwing = Math.sin(u * Math.PI * 2 * 2.5) * rub;
      }
    }

    // ---- 整只手的松紧：姿态 + 缓慢漂移（~16s）+ 握一下 ----
    const hand = this.tension + 4 * noise(t * 0.55, s) + 11 * grip;

    // ---- 四根手指 ----
    FINGERS.forEach((name, i) => {
      // 每根手指自己的漂移（~6~10s），相邻手指的种子挨得近、略相关，不会各抽各的
      let c = hand + 3.5 * noise(t * (0.85 + i * 0.12), s + i * 0.9);
      if (f?.kind === 'twitch' && name === f.finger) c -= 12 * twitch; // 抬一下再放回去
      if (name === 'Index') c += 7 * rub; // 拇指蹭的时候食指迎过来一点
      const spread = SPREAD[name] - 0.15 * (c - this.tension) + 1.2 * noise(t * 0.7, s + 10 + i);
      SEGS.forEach((seg, k) => {
        const curl = Math.max(k === 0 ? -4 : 0, CURL[name][k] + c * COUPLE[k]);
        this.bone(acc, side, `${name}${seg}`, 0, k === 0 ? spread : 0, -curl);
      });
    });

    // ---- 拇指：收在食指旁边，跟着手的松紧一起动 ----
    const th = 3 * noise(t * 0.8, s + 20) + 0.4 * (hand - this.tension);
    this.bone(acc, side, 'ThumbMetacarpal', 0, 22 + th + 6 * rubSwing, -(24 + 0.5 * th + 4 * rub));
    this.bone(acc, side, 'ThumbProximal', 0, 8 + 0.5 * th, 0);
    this.bone(acc, side, 'ThumbDistal', 0, 14 + 0.6 * th + 8 * rub, 0);

    // ---- 手腕：在动捕的手腕动作上再加一点点不循环的漂移 ----
    this.bone(acc, side, 'Hand', 1.5 * noise(t * 0.6, s + 30), 0, -1.5 * noise(t * 0.5, s + 31));
  }

  private bone(acc: PoseAccumulator, side: Side, name: string, x: number, y: number, z: number) {
    const m = side === 'left' ? 1 : -1;
    const fl = this.axisFlip;
    acc.add(`${side}${name}` as VRMHumanBoneName, deg(x) * fl, deg(y) * m, deg(z) * m * fl);
  }
}
