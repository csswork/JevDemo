import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationHumanoidTracks,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { GESTURES } from './gestures';
import { MOTIONS, isProceduralMotion, type MotionId as AnyMotionId, type ProceduralMotionId } from '../act/schema';

/** 动捕 .vrma 的动作 id（程序生成的在 gestures.ts） */
export type ClipMotionId = Exclude<AnyMotionId, ProceduralMotionId>;
type MotionId = ClipMotionId;
const CLIP_MOTIONS = MOTIONS.filter((id): id is ClipMotionId => !isProceduralMotion(id));

/**
 * 动作层：播放动捕的 .vrma（VRM Animation）。
 *
 * 素材是 VRoid 官方免费的 7 个动作（public/motions/vroid/，VRMA_MotionPack）。
 * 规约：可商用，但要署名"キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト"；
 * **禁止以可提取的形式再分发** —— 所以文件不进仓库（.gitignore）。
 *
 * 试过腾讯混元文生动作（HY-Motion）生成的动作，放弃了：成年人比例的骨架换到这些角色身上，
 * 手一碰身体就穿模，动作本身也常有换步、张望、幅度过大 —— 见 README"动作"一节。
 *
 * 为什么不用 THREE.AnimationMixer：mixer 在权重 < 1 时向"绑定那一刻的姿势"混合，
 * 而那一刻骨骼上已经叠着上一帧的 idle / 视线偏移，淡入淡出会混向一个过期的姿势。
 * 这里直接对每条轨道插值，自己决定和谁混：
 *
 *   静止姿势（resetNormalizedPose 之后）──slerp(w)──▶ 动作
 *
 * 然后 idle 层按 (1 - w) 叠呼吸、重心和垂手（见 Character.update），视线层照常叠在最上面。
 * 动作放完淡出，身体就回到 idle 的待机里。
 */

/**
 * 每个动作的文件和说明（VRMA_MotionPack 的 Readme），以及对原片的剪辑。
 * 剪辑都在加载 / 播放时生效，原文件不动。
 *
 * trim = 剪辑：加载时只保留原片的这一段（秒），预览和对话都用剪过的版本。
 *        原文件不动 —— 规约允许自由改数据，但文件本身不能再分发，改在代码里最干净
 *   打招呼  原片 0~1.6s 蹲着（膝盖弯 155°、胯部只有站立时的 35%），1.6~2.4s 跳起来，
 *           2.6s 才完全站直开始挥手。对话里看到"先蹲一下再打招呼"很奇怪 —— 从 2.6s 开始
 *
 * talk = 对话里自动触发时只播（剪辑后的）其中一段。一句台词没有 7~12 秒那么长：
 *   比耶    V 手势从 2.2s 一直举到 9.5s —— 举到 7s 就收
 *
 * scale  = 某几根骨骼的转动幅度乘一个系数（0.5 = 减半）
 * offset = 某几根骨骼额外转一点（度，VRM 1.0 规范空间：绕 X 负向 = 手臂往前送、绕 Z 正向 = 左臂外展；
 *          VRM 0.x 自动换算，两种格式实测一致）
 * hips   = 胯部水平位移：以剪辑范围内的平均位置为中心 / 缩放左右晃动
 * loop   = 当底层循环时头尾怎么接（wrap = 原片本身无缝）
 * 这几项播放时实时读取，控制台里改 `__jev.character.motion.edits.<id>` 马上看到效果
 *
 * 数值都是逐个看过全身截图（`__motionstrip`）、读过关键骨骼的曲线后定的。
 */
export interface MotionEdit {
  /** 相对 public/motions/ */
  file: string;
  label: string;
  trim?: { from?: number; to?: number };
  talk?: { from?: number; to?: number };
  scale?: Partial<Record<VRMHumanBoneName, number>>;
  offset?: Partial<Record<VRMHumanBoneName, [number, number, number]>>;
  /** 胯部水平位移：center = 以剪辑范围内的平均位置为中心；sway = 水平晃动的幅度系数 */
  hips?: { center?: boolean; sway?: number };
  /**
   * 当底层循环时怎么接头尾。默认交叉淡化（首尾姿势不一样的动作）；
   * wrap = 原片本身就是无缝循环（首尾两帧一样），直接绕回开头 —— 交叉淡化反而会把相差零点几秒的两个姿势混在一起
   */
  loop?: 'crossfade' | 'wrap';
}

export const MOTION_FILES: Record<MotionId, MotionEdit> = {
  show_full_body: { file: 'vroid/VRMA_01.vrma', label: '展示全身' },
  greeting: { file: 'vroid/VRMA_02.vrma', label: '打招呼', trim: { from: 2.6 } },
  peace_sign: { file: 'vroid/VRMA_03.vrma', label: '比耶', talk: { to: 7 } },
  shoot: { file: 'vroid/VRMA_04.vrma', label: '开枪' },
  spin: { file: 'vroid/VRMA_05.vrma', label: '转圈' },
  model_pose: { file: 'vroid/VRMA_06.vrma', label: '模特姿势' },
  squat: { file: 'vroid/VRMA_07.vrma', label: '蹲下（深蹲）' },
  // pixiv ChatVRM 的站立待机循环（MIT，public/motions/chatvrm/，授权原文在同目录 LICENSE）。
  // 原片里人站在偏离中心 15.7cm 的地方（胯部从第一帧起就在 x = -15.7cm），实际左右晃动只有约 2.7cm
  // —— 以平均位置为中心。原片首尾两帧完全一样（所有骨骼差 < 0.05°），直接绕回开头。
  // 手臂几乎竖直下垂（离竖直 5°），碰到往外蓬的裙摆，手指有一半在裙子里 —— 上臂各外展 6°（离竖直约 11°）
  idle_loop: {
    file: 'chatvrm/idle_loop.vrma',
    label: '待机循环（ChatVRM）',
    hips: { center: true },
    loop: 'wrap',
    offset: { leftUpperArm: [0, 0, 6], rightUpperArm: [0, 0, -6] },
  },
};

/**
 * 底层循环待机用哪个动作。null = 用 idle 层的程序待机。
 * 文件不在时（新克隆的仓库）同样静默退回程序待机
 */
export const IDLE_BASE: MotionId | null = 'idle_loop';

/** 动作的中文名（两种动作统一入口） */
export const motionLabel = (id: AnyMotionId) => (isProceduralMotion(id) ? GESTURES[id].label : MOTION_FILES[id].label);
/** 动作从哪来（预览面板的提示） */
export const motionSource = (id: AnyMotionId) =>
  isProceduralMotion(id) ? '程序生成（vrm/gestures.ts）' : MOTION_FILES[id].file;
/** 对话里自动触发时只播哪一段 */
export const motionTalk = (id: AnyMotionId) => (isProceduralMotion(id) ? undefined : MOTION_FILES[id].talk);

export const MOTION_CREDIT =
  'キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト · 待机动作 idle_loop.vrma © pixiv Inc.（MIT）';

const motionUrl = (id: MotionId) => `${import.meta.env.BASE_URL}motions/${MOTION_FILES[id].file}`;

/** .vrma 本身和模型无关，换模型时不用重新下载，只重新换算轨道 */
const sourceCache = new Map<MotionId, Promise<VRMAnimation | null>>();

function loadSource(id: MotionId): Promise<VRMAnimation | null> {
  let p = sourceCache.get(id);
  if (!p) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    p = loader
      .loadAsync(motionUrl(id))
      .then((gltf) => (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0] ?? null)
      .catch(() => null);
    sourceCache.set(id, p);
  }
  return p;
}

/** 一个动作针对当前模型的轨道（按模型的 hips 高度和 VRM 0/1 轴向换算过） */
interface Clip {
  /** 剪辑后的长度 */
  duration: number;
  /** 剪辑后的第 0 秒对应原片的第几秒 */
  offset: number;
  rotation: Map<VRMHumanBoneName, THREE.Interpolant>;
  hips: THREE.Interpolant | null;
  /** 胯部水平位置的中心（剪辑范围内的平均值），hips.center 时用 */
  hipsCenter: THREE.Vector3;
  hipsRest: THREE.Vector3;
}

interface Playing {
  id: MotionId;
  clip: Clip;
  t: number;
  /** 从哪里开始 / 播到哪里为止（秒，默认整段） */
  from: number;
  end: number;
  /** 当前权重（淡入淡出） */
  w: number;
  fadeIn: number;
  fadeOut: number;
  speed: number;
  /** 被新动作顶掉 / 手动停下：从现在开始淡出 */
  leaving: boolean;
  /** 底层循环：快放完时自己从头再起一份，首尾交叉淡化 */
  loop?: boolean;
}

type PlayOpts = { speed?: number; fadeIn?: number; fadeOut?: number; from?: number; to?: number };

const smooth = (w: number) => w * w * (3 - 2 * w);

/**
 * 两层：
 *   底层（base） 循环播放的待机动作。自己首尾交叉淡化，一直在
 *   上层        对话触发的动作 / 预览，叠在底层上面，放完淡回底层
 *
 * 同一层里多份交叉淡化时按权重归一化混合；上层对底层是整体覆盖（slerp(底层, 上层, w)）。
 * 都**不经过静止姿势** —— 静止姿势是 T-pose，两段交叉淡化时如果往它混，手臂会往上飘一下。
 */
export class MotionLayer {
  private vrm: VRM | null = null;
  private clips = new Map<MotionId, Clip>();
  private playing: Playing[] = [];
  private base: Playing[] = [];
  private baseId: MotionId | null = null;
  private baseSpeed = 1;
  private _q = new THREE.Quaternion();
  private _lq = new THREE.Quaternion();
  private _v = new THREE.Vector3();
  private _lv = new THREE.Vector3();
  private _o = new THREE.Quaternion();
  private _e = new THREE.Euler();
  private static IDENTITY = new THREE.Quaternion();
  /** VRM 0.x 的骨骼局部轴和 1.0 差 180°，offset 的 x / z 要取反 */
  private flip = 1;
  private loading = 0;
  /** 待机时上臂额外外展多少度（按模型的裙子蓬不蓬定，见 models.ts 的 armOut），只作用于底层 */
  private armClearance = 0;

  setArmClearance(deg: number) {
    this.armClearance = deg;
  }

  /** 剪辑表（开发时在控制台里直接改，下一帧生效） */
  get edits() {
    return MOTION_FILES;
  }

  /** 上层动作的总权重（0..1）。Character 用它把 idle 的偏移和视线的头部跟随让出来 */
  get weight(): number {
    let w = 0;
    for (const p of this.playing) w = Math.max(w, smooth(p.w));
    return w;
  }

  /** 底层待机的权重（0..1）。有它时 idle 层不再做呼吸、重心和垂手，只留姿态的微调 */
  get baseWeight(): number {
    let w = 0;
    for (const p of this.base) w += smooth(p.w);
    return Math.min(1, w);
  }

  get current(): { id: MotionId; t: number; duration: number } | null {
    const p = this.playing.find((x) => !x.leaving);
    return p ? { id: p.id, t: p.t, duration: p.end } : null;
  }

  get baseMotion(): MotionId | null {
    return this.baseId;
  }

  /** 正在播，或者正在加载准备播（第一次播某个动作要先下载） */
  get busy(): boolean {
    return this.loading > 0 || this.current != null;
  }

  /** 绑定到一个模型，并在后台把所有动作准备好（第一次播放就不用等） */
  bind(vrm: VRM) {
    this.vrm = vrm;
    this.flip = (vrm.meta as { metaVersion?: string }).metaVersion === '0' ? -1 : 1;
    this.clips.clear();
    this.playing = [];
    this.base = [];
    for (const id of CLIP_MOTIONS) void this.prepare(id);
    if (this.baseId) void this.setBase(this.baseId);
  }

  private async prepare(id: MotionId): Promise<Clip | null> {
    const cached = this.clips.get(id);
    if (cached) return cached;
    const vrm = this.vrm;
    const anim = await loadSource(id);
    if (!anim || !vrm || vrm !== this.vrm) return null;
    const meta = (vrm.meta as { metaVersion?: string }).metaVersion === '0' ? '0' : '1';
    const tracks = createVRMAnimationHumanoidTracks(anim, vrm.humanoid, meta);
    const fullDuration = anim.duration;
    // 线性插值；四元数轨道的 Linear 工厂在 three 里返回的是 slerp 插值器
    const interp = (track: THREE.KeyframeTrack) =>
      track.InterpolantFactoryMethodLinear(new Float32Array(track.getValueSize()));
    const hipsTrack = tracks.translation.get('hips');
    const hips = hipsTrack ? interp(hipsTrack) : null;
    const trim = MOTION_FILES[id].trim ?? {};
    const from = Math.max(0, Math.min(fullDuration, trim.from ?? 0));
    const to = Math.max(from, Math.min(fullDuration, trim.to ?? fullDuration));
    // 胯部水平位置的平均值：原地动作以它为中心，不偏到一边去
    const hipsCenter = new THREE.Vector3();
    if (hips) {
      const n = 60;
      for (let i = 0; i < n; i++) {
        const v = hips.evaluate(from + ((to - from) * (i + 0.5)) / n);
        hipsCenter.x += v[0] / n;
        hipsCenter.z += v[2] / n;
      }
    }
    const rest = vrm.humanoid.normalizedRestPose.hips?.position ?? [0, 0, 0];
    const clip: Clip = {
      duration: to - from,
      offset: from,
      rotation: new Map([...tracks.rotation].map(([bone, track]) => [bone, interp(track)])),
      hips,
      hipsCenter,
      hipsRest: new THREE.Vector3(rest[0], rest[1], rest[2]),
    };
    this.clips.set(id, clip);
    return clip;
  }

  /** 准备好就当帧开始（不等 Promise），没准备好的等下载完 */
  private withClip(id: MotionId, run: (clip: Clip) => void): Promise<boolean> {
    const ready = this.clips.get(id);
    if (ready) {
      run(ready);
      return Promise.resolve(true);
    }
    this.loading++;
    return this.prepare(id)
      .finally(() => this.loading--)
      .then((clip) => {
        if (!clip) return false;
        run(clip);
        return true;
      });
  }

  private entry(id: MotionId, clip: Clip, opts: PlayOpts): Playing {
    const from = Math.max(0, Math.min(clip.duration, opts.from ?? 0));
    return {
      id,
      clip,
      t: from,
      from,
      end: Math.max(from, Math.min(clip.duration, opts.to ?? clip.duration)),
      w: 0,
      // 从中间开始播时起始姿势离待机更远，淡入慢一点
      fadeIn: opts.fadeIn ?? (from > 0 ? 0.6 : 0.45),
      fadeOut: opts.fadeOut ?? 0.7,
      speed: opts.speed ?? 1,
      leaving: false,
    };
  }

  /**
   * 播一个动作（上层）。正在播的会被淡出（交叉淡化），不是硬切。
   * 返回 false = 动作文件不在（没下载 / 加载失败）
   */
  play(id: MotionId, opts: PlayOpts = {}): Promise<boolean> {
    return this.withClip(id, (clip) => {
      for (const p of this.playing) p.leaving = true;
      this.playing.push(this.entry(id, clip, opts));
    });
  }

  /**
   * 换底层待机（null = 不用动捕待机，退回 idle 层的程序待机）。
   * 文件不在时静默退回程序待机 —— 新克隆的仓库里没有生成的动作文件
   */
  setBase(id: MotionId | null): Promise<boolean> {
    this.baseId = id;
    if (!id) {
      for (const p of this.base) p.leaving = true;
      return Promise.resolve(true);
    }
    return this.withClip(id, (clip) => {
      if (this.baseId !== id) return;
      for (const p of this.base) p.leaving = true;
      this.base.push({ ...this.entry(id, clip, { fadeIn: 0.8, fadeOut: 1.2, speed: this.baseSpeed }), loop: true });
    });
  }

  /** 底层待机的播放速度（跟着情绪的激动程度走，0.9~1.1） */
  setBaseSpeed(speed: number) {
    this.baseSpeed = speed;
    for (const p of this.base) p.speed = speed;
  }

  /** 停下上层动作（淡出，回到底层待机） */
  stop() {
    for (const p of this.playing) p.leaving = true;
  }

  /** 改当前动作的播放速度（预览面板慢放；0 = 暂停在当前帧） */
  setSpeed(speed: number) {
    for (const p of this.playing) if (!p.leaving) p.speed = Math.max(0, speed);
  }

  /** 预览面板拖时间轴用：跳到某一时刻 */
  seek(t: number) {
    const p = this.playing.find((x) => !x.leaving);
    if (p) p.t = Math.max(0, Math.min(p.end, t));
  }

  update(dt: number) {
    const step = (list: Playing[]) => {
      const spawned: Playing[] = [];
      for (const p of list) {
        p.t += dt * p.speed;
        if (p.loop && !p.leaving && MOTION_FILES[p.id].loop === 'wrap') {
          // 无缝循环的底层：绕回开头，不淡出
          const len = p.end - p.from;
          if (len > 0 && p.t >= p.end) p.t = p.from + ((p.t - p.from) % len);
        } else if (!p.leaving && p.speed > 0 && p.end - p.t <= p.fadeOut * p.speed) {
          // 快放完时自己开始淡出，淡完正好到最后一帧（暂停时不算）；循环的同时从头再起一份
          p.leaving = true;
          if (p.loop) spawned.push({ ...p, t: p.from, w: 0, fadeIn: p.fadeOut, leaving: false });
        }
        const target = p.leaving ? 0 : 1;
        const rate = 1 / Math.max(0.05, p.leaving ? p.fadeOut : p.fadeIn);
        p.w = target >= p.w ? Math.min(target, p.w + dt * rate) : Math.max(target, p.w - dt * rate);
      }
      return [...list, ...spawned].filter((p) => !(p.leaving && p.w <= 0));
    };
    this.playing = step(this.playing);
    this.base = step(this.base);
  }

  /** 某一份动作在当前时刻某根骨骼的姿势（含剪辑表里的幅度 / 偏移），写到 this._q；没有这根骨骼返回 false */
  private evalBone(p: Playing, bone: VRMHumanBoneName): boolean {
    const interp = p.clip.rotation.get(bone);
    if (!interp) return false;
    const v = interp.evaluate(Math.min(p.t, p.end) + p.clip.offset);
    this._q.set(v[0], v[1], v[2], v[3]);
    const edit = MOTION_FILES[p.id];
    const k = edit.scale?.[bone];
    // 注意 slerpQuaternions 会先把自己设成第一个参数，所以第二个参数不能是自己
    if (k != null && k !== 1) this._q.slerpQuaternions(MotionLayer.IDENTITY, this._o.copy(this._q), k);
    const off = edit.offset?.[bone];
    // 底层待机按模型额外外展一点：裙子越蓬，垂手时越容易陷进裙摆
    const extra = p.loop && this.armClearance ? (bone === 'leftUpperArm' ? 1 : bone === 'rightUpperArm' ? -1 : 0) : 0;
    if (off || extra) {
      const d = Math.PI / 180;
      const z = (off?.[2] ?? 0) + extra * this.armClearance;
      this._e.set((off?.[0] ?? 0) * d * this.flip, (off?.[1] ?? 0) * d, z * d * this.flip);
      this._q.premultiply(this._o.setFromEuler(this._e));
    }
    return true;
  }

  private evalHips(p: Playing): boolean {
    if (!p.clip.hips) return false;
    const v = p.clip.hips.evaluate(Math.min(p.t, p.end) + p.clip.offset);
    this._v.set(v[0], v[1], v[2]);
    const h = MOTION_FILES[p.id].hips;
    if (h?.center) {
      // 以平均位置为中心，水平晃动按 sway 缩放
      const k = h.sway ?? 1;
      this._v.x = p.clip.hipsRest.x + (this._v.x - p.clip.hipsCenter.x) * k;
      this._v.z = p.clip.hipsRest.z + (this._v.z - p.clip.hipsCenter.z) * k;
    }
    return true;
  }

  /** 一层里的几份按权重归一化混合（交叉淡化时不往静止姿势混），结果在 this._lq，返回这一层的总权重 */
  private blendRotation(list: Playing[], bone: VRMHumanBoneName): number {
    let sum = 0;
    for (const p of list) {
      if (p.w <= 0 || !this.evalBone(p, bone)) continue;
      const w = smooth(p.w);
      if (sum === 0) this._lq.copy(this._q);
      else this._lq.slerp(this._q, w / (sum + w));
      sum += w;
    }
    return Math.min(1, sum);
  }

  private blendHips(list: Playing[]): number {
    let sum = 0;
    for (const p of list) {
      if (p.w <= 0 || !this.evalHips(p)) continue;
      const w = smooth(p.w);
      if (sum === 0) this._lv.copy(this._v);
      else this._lv.lerp(this._v, w / (sum + w));
      sum += w;
    }
    return Math.min(1, sum);
  }

  /**
   * 把动作写进骨骼。必须在 resetNormalizedPose 之后、idle / 视线的偏移 flush 之前调用：
   * 这里写的是**绝对**姿势，偏移再乘在它上面。先底层、再上层整体覆盖
   */
  apply() {
    const vrm = this.vrm;
    if (!vrm || (!this.playing.length && !this.base.length)) return;
    const bones = new Set<VRMHumanBoneName>();
    for (const p of [...this.base, ...this.playing]) for (const b of p.clip.rotation.keys()) bones.add(b);
    for (const bone of bones) {
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      for (const layer of [this.base, this.playing]) {
        const w = this.blendRotation(layer, bone);
        if (w > 0) node.quaternion.slerp(this._lq, w);
      }
    }
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) {
      for (const layer of [this.base, this.playing]) {
        const w = this.blendHips(layer);
        if (w > 0) hips.position.lerp(this._lv, w);
      }
    }
  }
}
