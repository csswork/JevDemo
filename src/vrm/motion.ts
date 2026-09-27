import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationHumanoidTracks,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { MOTIONS, type MotionId } from '../act/schema';
import { retargetSmpl, type HumanoidTracks } from './retargetSmpl';

/**
 * 动作层：播放动捕动作。两种来源，播放时一视同仁：
 *
 *   .vrma  VRoid 官方免费的 7 个动作（public/motions/vroid/，VRMA_MotionPack）。
 *          规约：可商用，但要署名"キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト"；
 *          **禁止以可提取的形式再分发** —— 所以文件不进仓库（.gitignore）
 *   .fbx   腾讯混元文生动作（HY-Motion）生成的（public/motions/hunyuan/，server/motionGen.ts 生成），
 *          SMPL-H 骨架，由 retargetSmpl.ts 换算到 VRM
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
 * offset = 某几根骨骼额外转一点（度，VRM 1.0 规范空间：绕 X 负向 = 手臂往前送；VRM 0.x 自动换算）
 *   微笑聆听（混元生成）  动捕是成年人的比例和幅度：4s 附近头连脖子低到约 50°，脸整个埋进刘海里 ——
 *                        头、脖子减半。原片右手握着左手腕、跨过身体中线 11.6cm，换到肩窄、身体小的
 *                        角色上成了双臂交叉、一只手陷进裙子 —— 上臂各外展 16°、往前送 6°，
 *                        两手并在身前正中（间距 4.4cm、离身体 12cm）。实测挑的，不是猜的
 * 这两项播放时实时读取，控制台里改 `__jev.character.motion.edits.<id>` 马上看到效果
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
}

export const MOTION_FILES: Record<MotionId, MotionEdit> = {
  show_full_body: { file: 'vroid/VRMA_01.vrma', label: '展示全身' },
  greeting: { file: 'vroid/VRMA_02.vrma', label: '打招呼', trim: { from: 2.6 } },
  peace_sign: { file: 'vroid/VRMA_03.vrma', label: '比耶', talk: { to: 7 } },
  shoot: { file: 'vroid/VRMA_04.vrma', label: '开枪' },
  spin: { file: 'vroid/VRMA_05.vrma', label: '转圈' },
  model_pose: { file: 'vroid/VRMA_06.vrma', label: '模特姿势' },
  squat: { file: 'vroid/VRMA_07.vrma', label: '蹲下（深蹲）' },
  // 混元文生动作："一个女孩站着，面带微笑认真聆听对方说话，时不时轻轻点头，双手自然交握在身前，身体微微前倾"
  listen_smile: {
    file: 'hunyuan/listen_smile.fbx',
    label: '微笑聆听（混元）',
    scale: { head: 0.5, neck: 0.5 },
    offset: { leftUpperArm: [-6, 0, 16], rightUpperArm: [-6, 0, -16] },
  },
};

export const MOTION_CREDIT = 'キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト · 部分动作由腾讯混元 HY-Motion 生成';

const motionUrl = (id: MotionId) => `${import.meta.env.BASE_URL}motions/${MOTION_FILES[id].file}`;

/** 动作文件本身和模型无关，换模型时不用重新下载，只重新换算轨道 */
type Source = { kind: 'vrma'; anim: VRMAnimation } | { kind: 'fbx'; fbx: THREE.Group };
const sourceCache = new Map<MotionId, Promise<Source | null>>();

function loadSource(id: MotionId): Promise<Source | null> {
  let p = sourceCache.get(id);
  if (!p) {
    const url = motionUrl(id);
    p = url.endsWith('.fbx')
      ? // FBXLoader 只有混元的动作要用，用到再加载
        import('three/examples/jsm/loaders/FBXLoader.js')
          .then(({ FBXLoader }) => new FBXLoader().loadAsync(url))
          .then((fbx): Source => ({ kind: 'fbx', fbx }))
          .catch(() => null)
      : (() => {
          const loader = new GLTFLoader();
          loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
          return loader
            .loadAsync(url)
            .then((gltf) => (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0] ?? null)
            .then((anim): Source | null => (anim ? { kind: 'vrma', anim } : null))
            .catch(() => null);
        })();
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
  rotation: Array<{ bone: VRMHumanBoneName; interp: THREE.Interpolant }>;
  hips: THREE.Interpolant | null;
}

interface Playing {
  id: MotionId;
  clip: Clip;
  t: number;
  /** 播到哪里为止（秒，默认整段） */
  end: number;
  /** 当前权重（淡入淡出） */
  w: number;
  fadeIn: number;
  fadeOut: number;
  speed: number;
  /** 被新动作顶掉 / 手动停下：从现在开始淡出 */
  leaving: boolean;
}

export class MotionLayer {
  private vrm: VRM | null = null;
  private clips = new Map<MotionId, Clip>();
  private playing: Playing[] = [];
  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();
  private _o = new THREE.Quaternion();
  private _e = new THREE.Euler();
  private static IDENTITY = new THREE.Quaternion();
  /** VRM 0.x 的骨骼局部轴和 1.0 差 180°，offset 的 x / z 要取反 */
  private flip = 1;

  /** 剪辑表（开发时在控制台里直接改，下一帧生效） */
  get edits() {
    return MOTION_FILES;
  }

  /** 当前动作的总权重（0..1）。Character 用它把 idle 层让出来 */
  get weight(): number {
    let w = 0;
    for (const p of this.playing) w = Math.max(w, p.w);
    return w;
  }

  get current(): { id: MotionId; t: number; duration: number } | null {
    const p = this.playing.find((x) => !x.leaving);
    return p ? { id: p.id, t: p.t, duration: p.end } : null;
  }

  /** 正在播，或者正在加载准备播（第一次播某个动作要先下载 .vrma） */
  get busy(): boolean {
    return this.loading > 0 || this.current != null;
  }

  private loading = 0;

  /** 绑定到一个模型，并在后台把所有动作准备好（第一次播放就不用等） */
  bind(vrm: VRM) {
    this.vrm = vrm;
    this.flip = (vrm.meta as { metaVersion?: string }).metaVersion === '0' ? -1 : 1;
    this.clips.clear();
    this.playing = [];
    for (const id of MOTIONS) void this.prepare(id);
  }

  private async prepare(id: MotionId): Promise<Clip | null> {
    const cached = this.clips.get(id);
    if (cached) return cached;
    const vrm = this.vrm;
    const src = await loadSource(id);
    if (!src || !vrm || vrm !== this.vrm) return null;
    const meta = (vrm.meta as { metaVersion?: string }).metaVersion === '0' ? '0' : '1';
    const tracks: HumanoidTracks =
      src.kind === 'vrma'
        ? { ...createVRMAnimationHumanoidTracks(src.anim, vrm.humanoid, meta), duration: src.anim.duration }
        : retargetSmpl(src.fbx, vrm);
    const fullDuration = tracks.duration;
    // 线性插值；四元数轨道的 Linear 工厂在 three 里返回的是 slerp 插值器
    const interp = (track: THREE.KeyframeTrack) =>
      track.InterpolantFactoryMethodLinear(new Float32Array(track.getValueSize()));
    const hips = tracks.translation.get('hips');
    const trim = MOTION_FILES[id].trim ?? {};
    const from = Math.max(0, Math.min(fullDuration, trim.from ?? 0));
    const to = Math.max(from, Math.min(fullDuration, trim.to ?? fullDuration));
    const clip: Clip = {
      duration: to - from,
      offset: from,
      rotation: [...tracks.rotation].map(([bone, track]) => ({ bone, interp: interp(track) })),
      hips: hips ? interp(hips) : null,
    };
    this.clips.set(id, clip);
    return clip;
  }

  /**
   * 播一个动作。正在播的会被淡出（交叉淡化），不是硬切。
   * 返回 false = 动作文件不在（没下载 / 加载失败）
   */
  play(
    id: MotionId,
    opts: { speed?: number; fadeIn?: number; fadeOut?: number; from?: number; to?: number } = {},
  ): Promise<boolean> {
    // 已经准备好的动作当帧就开始（不等 Promise），没准备好的等下载完
    const ready = this.clips.get(id);
    if (ready) {
      this.start(id, ready, opts);
      return Promise.resolve(true);
    }
    this.loading++;
    return this.prepare(id)
      .finally(() => this.loading--)
      .then((clip) => {
        if (!clip) return false;
        this.start(id, clip, opts);
        return true;
      });
  }

  private start(
    id: MotionId,
    clip: Clip,
    opts: { speed?: number; fadeIn?: number; fadeOut?: number; from?: number; to?: number },
  ) {
    for (const p of this.playing) p.leaving = true;
    const from = Math.max(0, Math.min(clip.duration, opts.from ?? 0));
    this.playing.push({
      id,
      clip,
      t: from,
      end: Math.max(from, Math.min(clip.duration, opts.to ?? clip.duration)),
      w: 0,
      // 从中间开始播时起始姿势离待机更远，淡入慢一点
      fadeIn: opts.fadeIn ?? (from > 0 ? 0.6 : 0.45),
      fadeOut: opts.fadeOut ?? 0.7,
      speed: opts.speed ?? 1,
      leaving: false,
    });
  }

  /** 停下（淡出） */
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
    for (const p of this.playing) {
      p.t += dt * p.speed;
      // 快放完时自己开始淡出，淡完正好到最后一帧（暂停时不算）
      const remain = p.end - p.t;
      if (!p.leaving && p.speed > 0 && remain <= p.fadeOut * p.speed) p.leaving = true;
      const target = p.leaving ? 0 : 1;
      const rate = 1 / Math.max(0.05, p.leaving ? p.fadeOut : p.fadeIn);
      p.w = target >= p.w ? Math.min(target, p.w + dt * rate) : Math.max(target, p.w - dt * rate);
    }
    this.playing = this.playing.filter((p) => !(p.leaving && p.w <= 0));
  }

  /**
   * 把动作写进骨骼。必须在 resetNormalizedPose 之后、idle / 视线的偏移 flush 之前调用：
   * 这里写的是**绝对**姿势（静止姿势和动作之间按权重 slerp），偏移再乘在它上面。
   */
  apply() {
    const vrm = this.vrm;
    if (!vrm || !this.playing.length) return;
    for (const p of this.playing) {
      if (p.w <= 0) continue;
      // 平滑的起止：线性权重过一遍 smoothstep，速度连续
      const w = p.w * p.w * (3 - 2 * p.w);
      const t = Math.min(p.t, p.end) + p.clip.offset;
      const edit = MOTION_FILES[p.id];
      for (const { bone, interp } of p.clip.rotation) {
        const node = vrm.humanoid.getNormalizedBoneNode(bone);
        if (!node) continue;
        const v = interp.evaluate(t);
        this._q.set(v[0], v[1], v[2], v[3]);
        const k = edit.scale?.[bone];
        // 注意 slerpQuaternions 会先把自己设成第一个参数，所以第二个参数不能是自己
        if (k != null && k !== 1) this._q.slerpQuaternions(MotionLayer.IDENTITY, this._o.copy(this._q), k);
        const off = edit.offset?.[bone];
        if (off) {
          const d = Math.PI / 180;
          this._e.set(off[0] * d * this.flip, off[1] * d, off[2] * d * this.flip);
          this._q.premultiply(this._o.setFromEuler(this._e));
        }
        // 多个动作交叉淡化时，后一个在前一个的结果上继续 slerp
        node.quaternion.slerp(this._q, w);
      }
      if (p.clip.hips) {
        const node = vrm.humanoid.getNormalizedBoneNode('hips');
        if (node) {
          const v = p.clip.hips.evaluate(t);
          this._v.set(v[0], v[1], v[2]);
          node.position.lerp(this._v, w);
        }
      }
    }
  }
}
