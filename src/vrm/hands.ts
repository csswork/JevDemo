import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Cue, PostureId } from '../act/schema';
import { PoseAccumulator, damp, deg, noise } from './pose';
import type { HandShape } from './gestures';

/**
 * 手的层 —— 待机时手指的自然弯曲和细微的随机变化，说话时手上的小动作。
 *
 * 动捕待机（ChatVRM 的 idle_loop）只有手腕，没有手指轨道；VRM 的静止姿势是 T-pose 的平手，
 * 所以不加这一层时手指一直绷得笔直、五指张开、拇指支棱在外面，像两块板子。
 *
 * 待机，三部分叠在一起：
 *   自然弯曲  放松垂手时的样子：从食指到小指越来越弯、并拢一点，拇指收在食指旁边
 *   缓慢漂移  每根手指各自的伪噪声 + 整只手的松紧，周期 6~16s、幅度几度 —— 和身体的待机一样"活着"，
 *            两只手各走各的
 *   小动作    每只手隔 7~18 秒随机来一下：轻轻握一下、某根手指动一下、拇指在食指上蹭两下
 *
 * 说话（speech_start → speech_end），手不离开体侧，只做小幅度的"说话的手"：
 *   主手      每句话挑一只手（多半是右手）当主手：小臂抬起一点（12°）、掌心稍微转向前、手指松开一点
 *   节拍      落在发声的音节上（口型张开时），隔 0.7~1.7 秒一下：小臂轻轻一抬（再 +11°）、手指一松 ——
 *            真人说话时的"节拍手势"（beat gesture），不表达内容，只跟着说话的节奏
 *   标点      问号 → 小臂往前送（+24°）、掌心转向对方、手指张开（交出话轮的"你说呢"）；
 *            叹号 → 更用力的一下，手指收紧；笑声 → 两下轻颤；句末 → 停一拍，有时换另一只手
 *   幅度是按全身景别（相机 4m 外）看得出来定的：第一版小臂只抬 6°，手只挪 2~3cm，看上去和待机没区别
 *   说话时不做待机的小动作（手在"说话"，不是在发呆）
 * 节奏信号和台词里的标点一样是派生的、不带情绪（timeline.ts 的 cue）；
 * 幅度和频率跟着 Jev 定的姿态和激动程度走：低落时又少又小，开心、激动时多一点、大一点。
 *
 * 上层动作（VRoid 的动捕带完整的手指和手臂）在播时按 (1 - 动作权重) 让出来（PoseAccumulator.scale）。
 *
 * 角度都按 VRM 1.0 规范空间里的**左手**写（度，[绕 X, 绕 Y, 绕 Z]）：
 *   手指  X = 沿手指的轴（自转）  Y = 侧摆（正 = 往小指一侧）  Z = 弯曲（负 = 往掌心弯）
 *   小臂  X = 旋前旋后（负 = 掌心转向前）  Y = 屈肘（负 = 小臂往前抬，和 idle 层一致）
 *   上臂  Y = 前摆（负 = 往前）  Z = 外展（正 = 往外）
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
/** 手形覆盖里"并拢"一项每根手指再往中间收多少（度） */
const CLOSE: Record<Finger, number> = { Index: 3, Middle: 0.5, Ring: -2.5, Little: -5 };
/** 弯曲往下两节传的比例：真手的指间关节是联动的，近节动，中节、远节跟着动 */
const COUPLE = [1, 0.8, 0.5];

/**
 * 姿态 → 手的松紧（整只手多弯几度）和说话时手势的幅度系数。
 * 开心时手更松、手势多；低落时手垂着几乎不动；警觉时手更收
 */
const POSTURE_HANDS: Record<PostureId, { tension: number; gesture: number }> = {
  idle_neutral: { tension: 0, gesture: 1 },
  idle_cheerful: { tension: -3, gesture: 1.15 },
  idle_low: { tension: 3, gesture: 0.55 },
  idle_alert: { tension: 4, gesture: 0.9 },
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

/** 说话时的手势：beat = 节拍，offer = 问句摊手，press = 感叹，bounce = 笑 */
type GestureKind = 'beat' | 'offer' | 'press' | 'bounce';

interface Gesture {
  kind: GestureKind;
  t: number;
  dur: number;
  amp: number;
  /** 主手是哪只；另一只手跟多少（0..1） */
  lead: Side;
  other: number;
}

/** 一只手此刻说话手势的量（度） */
interface Talk {
  /** 小臂往前抬（屈肘） */
  elbow: number;
  /** 上臂往前摆 */
  forward: number;
  /** 上臂往外张 */
  out: number;
  /** 掌心转向前（旋后） */
  supinate: number;
  /** 手腕上翘（负 = 往下压） */
  flex: number;
  /** 手指松开（负 = 收紧） */
  open: number;
  /** 拇指张开 */
  thumbOut: number;
}

const zeroTalk = (): Talk => ({ elbow: 0, forward: 0, out: 0, supinate: 0, flex: 0, open: 0, thumbOut: 0 });

/** 两头导数为 0 的鼓包：0 → 1 → 0 */
const bump = (u: number) => Math.sin(Math.PI * Math.max(0, Math.min(1, u))) ** 2;
const ease = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};
/** 起得快、落得慢：rise 之前升到 1，之后慢慢回落 */
const flick = (u: number, rise: number) => (u < rise ? ease(u / rise) : 1 - ease((u - rise) / (1 - rise)));
/** 升起 → 停住 → 回落 */
const hold = (u: number, rise: number, fall: number) => ease(u / rise) * (1 - ease((u - fall) / (1 - fall)));

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
  private posture = POSTURE_HANDS.idle_neutral;
  private tension = 0;
  private rnd = mulberry32(20261001);
  private hands: Record<Side, HandState> = {
    left: { seed: 1.3, next: 4 + this.rnd() * 6, fidget: null },
    right: { seed: 7.9, next: 8 + this.rnd() * 8, fidget: null },
  };

  // ---- 说话 ----
  private speaking = false;
  /** 说话的包络 0..1：开口时升起、说完慢慢落回待机 */
  private speak = 0;
  private lead: Side = 'right';
  private gestures: Gesture[] = [];
  private nextBeat = 0;
  /** 嘴此刻张开的程度（口型层每帧喂进来）：节拍落在发声的音节上，停顿处不打拍子 */
  private voice = 0;
  /** 说话时的基础姿势（平滑过渡） */
  private talkBase: Record<Side, Talk> = { left: zeroTalk(), right: zeroTalk() };
  /** 基础姿势 + 此刻的手势，updateHand 用这个 */
  private talk: Record<Side, Talk> = { left: zeroTalk(), right: zeroTalk() };
  /** 表演动作（gestures.ts）要的手形，比如掩嘴时手指并拢、拇指收起 */
  private shapes: Record<Side, HandShape | null> = { left: null, right: null };

  setVrmVersion(metaVersion: string | undefined) {
    this.axisFlip = metaVersion === '0' ? -1 : 1;
  }

  setPosture(p: PostureId) {
    this.posture = POSTURE_HANDS[p] ?? POSTURE_HANDS.idle_neutral;
  }

  setArousal(a: number) {
    this.arousal = Math.max(0, Math.min(1, a));
  }

  setSpeaking(on: boolean) {
    if (on && !this.speaking) {
      // 每句话挑一只主手，多半是右手
      this.lead = this.rnd() < 0.65 ? 'right' : 'left';
      this.nextBeat = 0.25 + this.rnd() * 0.4;
    }
    this.speaking = on;
  }

  setShape(side: Side, shape: HandShape | null) {
    this.shapes[side] = shape;
  }

  setVoice(level: number) {
    this.voice = level;
  }

  /** 说话的节奏信号（timeline.ts 从标点派生的） */
  cue(kind: Cue) {
    if (!this.speaking) return;
    const r = this.rnd;
    switch (kind) {
      case 'question':
        // 问句：主手掌心转向对方、手指张开 —— "你说呢"
        this.push('offer', 1.5 + r() * 0.4, 0.85 + r() * 0.3, 0.3);
        this.nextBeat = Math.max(this.nextBeat, 1.2);
        break;
      case 'emphasis':
        this.push('press', 0.55 + r() * 0.15, 0.9 + r() * 0.3, 0.6);
        this.nextBeat = Math.max(this.nextBeat, 0.6);
        break;
      case 'laugh':
        this.push('bounce', 0.75, 0.8 + r() * 0.3, 0.8);
        break;
      case 'boundary':
        // 句末停一拍；下一句有时换另一只手
        this.nextBeat = Math.max(this.nextBeat, 0.5 + r() * 0.4);
        if (r() < 0.3) this.lead = this.lead === 'right' ? 'left' : 'right';
        break;
    }
  }

  /** 正在做的小动作 / 手势（调试用） */
  get debug() {
    return {
      fidgets: { left: this.hands.left.fidget?.kind ?? null, right: this.hands.right.fidget?.kind ?? null },
      speak: +this.speak.toFixed(2),
      lead: this.lead,
      gestures: this.gestures.map((g) => g.kind),
    };
  }

  /** 说话手势的总幅度：姿态 × 激动程度 */
  private get gestureScale() {
    return this.posture.gesture * (0.7 + 0.6 * this.arousal);
  }

  private push(kind: GestureKind, dur: number, amp: number, other: number) {
    this.gestures.push({ kind, t: 0, dur, amp: amp * this.gestureScale, lead: this.lead, other });
  }

  private startFidget(h: HandState) {
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
    this.tension = damp(this.tension, this.posture.tension, 1.5, dt);
    this.speak = damp(this.speak, this.speaking ? 1 : 0, this.speaking ? 3 : 1.5, dt);
    this.updateTalk(dt * rate);
    for (const side of ['left', 'right'] as const) this.updateHand(side, dt * rate, acc);
  }

  /** 说话时两只手各自的手势量 */
  private updateTalk(dt: number) {
    // 节拍：说话时隔一会儿来一下，只落在发声的音节上（嘴张开），停顿处等着
    if (this.speaking) {
      this.nextBeat -= dt;
      const busy = this.gestures.some((g) => g.kind === 'offer');
      if (this.nextBeat <= 0 && this.voice > 0.25 && !busy) {
        // 有时两只手一起
        this.push('beat', 0.5 + this.rnd() * 0.2, 0.6 + this.rnd() * 0.45, this.rnd() < 0.3 ? 0.5 : 0);
        this.nextBeat = (0.7 + this.rnd() * 1.1) / (0.8 + this.arousal * 0.5);
      }
    }

    const k = this.speak * Math.min(1, this.gestureScale);
    for (const side of ['left', 'right'] as const) {
      const lead = side === this.lead ? 1 : 0.3;
      // 主手说话时的基础姿势：小臂微微抬起、掌心稍微转向前、手指松一点
      const b = this.talkBase[side];
      b.elbow = damp(b.elbow, 12 * k * lead, 2, dt);
      b.forward = damp(b.forward, 3 * k * lead, 2, dt);
      // 正面看，往前抬是纵深方向、几乎看不出来；带一点往外，正面才读得到
      b.out = damp(b.out, 2 * k * lead, 2, dt);
      b.supinate = damp(b.supinate, 10 * k * lead, 2, dt);
      b.open = damp(b.open, 4 * k * lead, 2, dt);
      b.thumbOut = damp(b.thumbOut, 3 * k * lead, 2, dt);
    }
    // 手势的量是瞬时的，叠在基础姿势上（不进 damp，曲线本身就是平滑的）
    const add: Record<Side, Talk> = { left: zeroTalk(), right: zeroTalk() };
    // 摊手取最大的那一份，不叠加：连着两个问句时第二个接着第一个，不会翻掌翻到两倍
    const offer: Record<Side, number> = { left: 0, right: 0 };
    for (const g of this.gestures) {
      g.t += dt;
      const u = g.t / g.dur;
      for (const side of ['left', 'right'] as const) {
        const w = (side === g.lead ? 1 : g.other) * g.amp;
        if (w <= 0) continue;
        const a = add[side];
        if (g.kind === 'beat') {
          const e = flick(u, 0.35) * w;
          a.elbow += 11 * e;
          a.forward += 2 * e;
          a.out += 2 * e;
          a.flex += 5 * e;
          a.open += 5 * e;
        } else if (g.kind === 'offer') {
          offer[side] = Math.max(offer[side], hold(u, 0.3, 0.55) * w);
        } else if (g.kind === 'press') {
          const e = flick(u, 0.3) * w;
          a.elbow += 12 * e;
          a.forward += 2 * e;
          a.flex -= 7 * e;
          a.open -= 8 * e;
        } else {
          // 笑：两下轻颤，第二下小一点
          const e = bump((u * 2) % 1) * (u < 0.5 ? 1 : 0.6) * w;
          a.elbow += 6 * e;
          a.open += 4 * e;
        }
      }
    }
    this.gestures = this.gestures.filter((g) => g.t < g.dur);
    for (const side of ['left', 'right'] as const) {
      const b = this.talkBase[side];
      const a = add[side];
      const e = offer[side];
      a.elbow += 24 * e;
      a.forward += 5 * e;
      a.out += 6 * e;
      a.supinate += 28 * e;
      a.open += 12 * e;
      a.thumbOut += 10 * e;
      const g = this.talk[side];
      g.elbow = b.elbow + a.elbow;
      g.forward = b.forward + a.forward;
      g.out = b.out + a.out;
      g.supinate = b.supinate + a.supinate;
      g.flex = b.flex + a.flex;
      g.open = b.open + a.open;
      g.thumbOut = b.thumbOut + a.thumbOut;
    }
  }

  private updateHand(side: Side, dt: number, acc: PoseAccumulator) {
    const h = this.hands[side];
    const t = this.t;
    const s = h.seed;
    const talk = this.talk[side];
    const shape = this.shapes[side];
    const sw = shape?.weight ?? 0;

    // ---- 小动作（说话时、手在做表演动作时不做）----
    if (!h.fidget && this.speak < 0.3 && sw < 0.1) {
      h.next -= dt;
      if (h.next <= 0) this.startFidget(h);
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
        grip = hold(u, 0.3, 0.55) * f.amp;
      } else if (f.kind === 'twitch') {
        twitch = bump(u) * f.amp;
      } else {
        // 拇指在食指侧面来回蹭两下半
        rub = bump(u) * f.amp;
        rubSwing = Math.sin(u * Math.PI * 2 * 2.5) * rub;
      }
    }

    // ---- 整只手的松紧：姿态 + 缓慢漂移（~16s）+ 握一下 - 说话时松开 ----
    const hand = this.tension + 4 * noise(t * 0.55, s) + 11 * grip - talk.open + sw * (shape?.curl ?? 0);

    // ---- 四根手指 ----
    FINGERS.forEach((name, i) => {
      // 每根手指自己的漂移（~6~10s），相邻手指的种子挨得近、略相关，不会各抽各的
      let c = hand + 3.5 * noise(t * (0.85 + i * 0.12), s + i * 0.9);
      if (f?.kind === 'twitch' && name === f.finger) c -= 12 * twitch; // 抬一下再放回去
      if (name === 'Index') c += 7 * rub; // 拇指蹭的时候食指迎过来一点
      const spread =
        SPREAD[name] - 0.15 * (c - this.tension) + 1.2 * noise(t * 0.7, s + 10 + i) + sw * (shape?.close ?? 0) * CLOSE[name];
      SEGS.forEach((seg, k) => {
        const curl = Math.max(k === 0 ? -4 : 0, CURL[name][k] + c * COUPLE[k]);
        this.bone(acc, side, `${name}${seg}`, 0, k === 0 ? spread : 0, -curl);
      });
    });

    // ---- 拇指：收在食指旁边，跟着手的松紧一起动；说话摊手时张开 ----
    const th = 3 * noise(t * 0.8, s + 20) + 0.4 * (hand - this.tension) - talk.thumbOut + sw * (shape?.thumb ?? 0);
    this.bone(acc, side, 'ThumbMetacarpal', 0, 22 + th + 6 * rubSwing, -(24 + 0.5 * th + 4 * rub));
    this.bone(acc, side, 'ThumbProximal', 0, 8 + 0.5 * th, 0);
    this.bone(acc, side, 'ThumbDistal', 0, 14 + 0.6 * th + 8 * rub, 0);

    // ---- 手腕：动捕的手腕动作上再加一点不循环的漂移；说话时的翻掌、上翘 ----
    this.bone(
      acc,
      side,
      'Hand',
      1.5 * noise(t * 0.6, s + 30) - 0.4 * talk.supinate,
      0,
      -1.5 * noise(t * 0.5, s + 31) + talk.flex,
    );

    // ---- 小臂：说话时微微抬起；翻掌一大半在小臂上（真人旋前旋后是小臂在转，只转手腕会拧）----
    if (talk.elbow || talk.supinate) this.bone(acc, side, 'LowerArm', -0.6 * talk.supinate, -talk.elbow, 0);
    if (talk.forward || talk.out) this.bone(acc, side, 'UpperArm', 0, -talk.forward, talk.out);
  }

  private bone(acc: PoseAccumulator, side: Side, name: string, x: number, y: number, z: number) {
    const m = side === 'left' ? 1 : -1;
    const fl = this.axisFlip;
    acc.add(`${side}${name}` as VRMHumanBoneName, deg(x) * fl, deg(y) * m, deg(z) * m * fl);
  }
}
