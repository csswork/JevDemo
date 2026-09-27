import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationHumanoidTracks,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { MOTIONS, type MotionId } from '../act/schema';

/**
 * 动作层：播放动捕的 .vrma（VRM Animation）。
 *
 * 素材是 VRoid 官方免费的 7 个动作（public/motions/vroid/，VRMA_MotionPack）。
 * 规约：可商用，但要署名"キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト"；
 * **禁止以可提取的形式再分发** —— 所以文件不进仓库（.gitignore），也不打包进构建产物以外的地方。
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

/** 每个动作的文件和说明（VRMA_MotionPack 的 Readme） */
export const MOTION_FILES: Record<MotionId, { file: string; label: string }> = {
  show_full_body: { file: 'VRMA_01.vrma', label: '展示全身' },
  greeting: { file: 'VRMA_02.vrma', label: '打招呼' },
  peace_sign: { file: 'VRMA_03.vrma', label: '比耶' },
  shoot: { file: 'VRMA_04.vrma', label: '开枪' },
  spin: { file: 'VRMA_05.vrma', label: '转圈' },
  model_pose: { file: 'VRMA_06.vrma', label: '模特姿势' },
  squat: { file: 'VRMA_07.vrma', label: '蹲下' },
};

export const MOTION_CREDIT = 'キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト';

const motionUrl = (id: MotionId) => `${import.meta.env.BASE_URL}motions/vroid/${MOTION_FILES[id].file}`;

/** .vrma 本身和模型无关，换模型时不用重新下载 */
const animCache = new Map<MotionId, Promise<VRMAnimation | null>>();

function loadAnimation(id: MotionId): Promise<VRMAnimation | null> {
  let p = animCache.get(id);
  if (!p) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    p = loader
      .loadAsync(motionUrl(id))
      .then((gltf) => (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0] ?? null)
      .catch(() => null);
    animCache.set(id, p);
  }
  return p;
}

/** 一个动作针对当前模型的轨道（按模型的 hips 高度和 VRM 0/1 轴向换算过） */
interface Clip {
  duration: number;
  rotation: Array<{ bone: VRMHumanBoneName; interp: THREE.Interpolant }>;
  hips: THREE.Interpolant | null;
}

interface Playing {
  id: MotionId;
  clip: Clip;
  t: number;
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

  /** 当前动作的总权重（0..1）。Character 用它把 idle 层让出来 */
  get weight(): number {
    let w = 0;
    for (const p of this.playing) w = Math.max(w, p.w);
    return w;
  }

  get current(): { id: MotionId; t: number; duration: number } | null {
    const p = this.playing.find((x) => !x.leaving);
    return p ? { id: p.id, t: p.t, duration: p.clip.duration } : null;
  }

  /** 正在播，或者正在加载准备播（第一次播某个动作要先下载 .vrma） */
  get busy(): boolean {
    return this.loading > 0 || this.current != null;
  }

  private loading = 0;

  /** 绑定到一个模型，并在后台把所有动作准备好（第一次播放就不用等） */
  bind(vrm: VRM) {
    this.vrm = vrm;
    this.clips.clear();
    this.playing = [];
    for (const id of MOTIONS) void this.prepare(id);
  }

  private async prepare(id: MotionId): Promise<Clip | null> {
    const cached = this.clips.get(id);
    if (cached) return cached;
    const vrm = this.vrm;
    const anim = await loadAnimation(id);
    if (!anim || !vrm || vrm !== this.vrm) return null;
    const meta = (vrm.meta as { metaVersion?: string }).metaVersion === '0' ? '0' : '1';
    const tracks = createVRMAnimationHumanoidTracks(anim, vrm.humanoid, meta);
    const clip: Clip = {
      duration: anim.duration,
      rotation: [...tracks.rotation].map(([bone, track]) => ({ bone, interp: track.createInterpolant() })),
      hips: tracks.translation.get('hips')?.createInterpolant() ?? null,
    };
    this.clips.set(id, clip);
    return clip;
  }

  /**
   * 播一个动作。正在播的会被淡出（交叉淡化），不是硬切。
   * 返回 false = 动作文件不在（没下载 / 加载失败）
   */
  async play(id: MotionId, opts: { speed?: number; fadeIn?: number; fadeOut?: number } = {}): Promise<boolean> {
    this.loading++;
    const clip = await this.prepare(id).finally(() => this.loading--);
    if (!clip) return false;
    for (const p of this.playing) p.leaving = true;
    this.playing.push({
      id,
      clip,
      t: 0,
      w: 0,
      fadeIn: opts.fadeIn ?? 0.45,
      fadeOut: opts.fadeOut ?? 0.7,
      speed: opts.speed ?? 1,
      leaving: false,
    });
    return true;
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
    if (p) p.t = Math.max(0, Math.min(p.clip.duration, t));
  }

  update(dt: number) {
    for (const p of this.playing) {
      p.t += dt * p.speed;
      // 快放完时自己开始淡出，淡完正好到最后一帧（暂停时不算）
      const remain = p.clip.duration - p.t;
      if (!p.leaving && p.speed > 0 && remain <= p.fadeOut * p.speed) p.leaving = true;
      const target = p.leaving ? 0 : 1;
      const rate = 1 / Math.max(0.05, p.leaving ? p.fadeOut : p.fadeIn);
      p.w = target > p.w ? Math.min(1, p.w + dt * rate) : Math.max(0, p.w - dt * rate);
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
      const t = Math.min(p.t, p.clip.duration);
      for (const { bone, interp } of p.clip.rotation) {
        const node = vrm.humanoid.getNormalizedBoneNode(bone);
        if (!node) continue;
        const v = interp.evaluate(t);
        this._q.set(v[0], v[1], v[2], v[3]);
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
