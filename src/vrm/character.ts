import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { TimelineEvent } from '../act/timeline';
import { PoseAccumulator, vrmMetaVersion } from './pose';
import { IdleLayer } from './idle';
import { IDLE_BASE, MOTION_FILES, MotionLayer } from './motion';
import { GazeLayer } from './gaze';
import { ExpressionLayer, type ConversationState } from './expressions';
import { LipSyncLayer } from './lipsync';

/**
 * 角色控制器 —— Act IR 的消费端。
 *
 * 每帧的层叠顺序是固定的，也是这个 demo 的核心：
 *   resetNormalizedPose → motion → idle → gaze → flush → expression → lipsync → vrm.update
 *
 * motion 写的是绝对姿势：底层是一直循环的动捕待机，对话触发的动作整体叠在它上面。
 * idle / gaze 是乘在上面的偏移：动作在播时按 (1 - 动作权重) 让出来；
 * 有动捕待机时 idle 只留姿态的微调（呼吸、重心、垂手都由动捕负责）。
 *
 * 换渲染引擎（Live2D / Unity / AnimeActEngine）时，需要重写的只有这个文件和 vrm/ 目录；
 * act/ 和 jev/ 两层原样保留。
 */
export class Character {
  vrm: VRM | null = null;

  readonly idle = new IdleLayer();
  readonly motion = new MotionLayer();
  readonly gaze: GazeLayer;
  readonly expression = new ExpressionLayer();
  readonly lipsync = new LipSyncLayer();

  private acc = new PoseAccumulator();
  /** 调试开关：关掉后只跑 vrm.update，用于隔离"是我的层还是引擎本身"的问题 */
  layersEnabled = true;
  /** 动作总开关（对话里由 Jev 的答案触发的动作；预览面板不受它影响） */
  motionsEnabled = true;
  private hipsRest = new THREE.Vector3();
  private conversation: ConversationState = 'idle';

  constructor(cameraPos: THREE.Vector3) {
    this.gaze = new GazeLayer(cameraPos);
  }

  async load(url: string, onProgress?: (ratio: number) => void): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url, (e) => {
      if (e.total > 0) onProgress?.(e.loaded / e.total);
    });

    const vrm = gltf.userData.vrm as VRM;

    // 注意：VRMUtils 的 removeUnnecessaryVertices / combineSkeletons / combineMorphs
    // 在这个模型上会撕裂头发的蒙皮（弹簧骨被拽成放射状）。它们是 draw call 优化，
    // 对单角色场景收益很小，这里直接不用。换模型时可以单独试，但务必肉眼验收。
    VRMUtils.rotateVRM0(vrm);

    // 二次元模型不需要视锥剔除和阴影，关掉省事也避免手抬高时被裁掉
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    const metaVersion = vrmMetaVersion(vrm);
    this.idle.setVrmVersion(metaVersion);
    this.gaze.setVrmVersion(metaVersion);

    this.expression.bind(vrm);
    this.lipsync.bind(vrm);
    this.motion.bind(vrm);
    // 有动捕待机就垫在最底下；没配（IDLE_BASE = null）或文件不在时用 idle 层的程序待机
    if (IDLE_BASE) void this.motion.setBase(IDLE_BASE);

    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) this.hipsRest.copy(hips.position);

    if (vrm.lookAt) {
      vrm.lookAt.autoUpdate = true;
      vrm.lookAt.target = this.gaze.target;
    }

    this.vrm = vrm;
    this.gaze.look('camera');

    // 暖机：先把姿态落到位再重置弹簧骨。
    // 两个坑都在这里：
    //   1. rotateVRM0 把 vrm.scene 整体转了 180°，而弹簧骨记录的是上一帧的**世界**
    //      位置。旋转之后每个关节的世界坐标瞬间跳到镜像位置，被当成一个巨大的速度
    //      输入 —— 这个模型 dragForce 只有 0.05，阻尼极低，于是头发和裙子会直接炸开
    //      成放射状且再也收不回来。必须在旋转之后重新播种弹簧骨状态。
    //   2. VRM 规范的静止姿态是 T-pose，而 idle 层的目标是垂手。如果让它从 T-pose
    //      缓动过去，开场一秒内手臂扫过的大位移同样会甩飞头发。所以先 snap 到位、
    //      空跑几帧、再 reset。
    this.idle.snap();
    for (let i = 0; i < 12; i++) this.update(1 / 60);
    vrm.springBoneManager?.reset();

    return vrm;
  }

  /** 消费时间轴事件。这是 Act IR 与渲染层之间唯一的接触面。 */
  apply(ev: TimelineEvent) {
    switch (ev.kind) {
      case 'posture':
        this.idle.setPosture(ev.posture);
        break;
      case 'expression':
        // 整组一次性设定：给定的情绪按权重叠加，没给的淡出。
        // 逐个 setExclusive 会让同时刻的后一拍清掉前一拍，分布退化成 top-1。
        this.expression.setBlend(Object.fromEntries(ev.mix), ev.fade);
        break;
      case 'motion':
        // 对话里只播适合半身景别的那一段（见 MOTION_FILES 的 talk）。
        // 同一个动作已经在播就不重来：Jev 的判断晚到时会把已经过去的节拍补一次
        if (!this.motionsEnabled || this.motion.current?.id === ev.clip) break;
        void this.motion.play(ev.clip, { speed: ev.speed, ...MOTION_FILES[ev.clip].talk });
        break;
      case 'gaze':
        this.gaze.look(ev.target, ev.hold);
        break;
      case 'cue':
        this.expression.cue(ev.cue);
        break;
      case 'speech_start':
        this.setConversation('speaking');
        this.expression.setSpeaking(true);
        break;
      case 'speech_end':
        this.expression.setSpeaking(false);
        this.lipsync.stop();
        // 说完不立刻回到面无表情，余韵见 ExpressionLayer.release
        this.expression.release();
        this.setConversation('idle');
        break;
    }
  }

  /**
   * 对话状态：倾听（用户在打字）→ 思考（等台词）→ 说话 → 回到待机。
   * 只影响神态（视线回避、抿嘴、眼神），不设定任何情绪。
   */
  setConversation(state: ConversationState) {
    this.conversation = state;
    this.expression.setState(state);
    this.gaze.setThinking(state === 'thinking');
  }

  get conversationState() {
    return this.conversation;
  }

  setArousal(a: number) {
    this.idle.setArousal(a);
    // 情绪越激动，待机的节奏越快一点（和 idle 层的呼吸节奏同一个道理）
    this.motion.setBaseSpeed(0.92 + Math.max(0, Math.min(1, a)) * 0.16);
  }

  update(dt: number) {
    const vrm = this.vrm;
    if (!vrm) return;

    vrm.humanoid.resetNormalizedPose();
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) hips.position.copy(this.hipsRest);

    if (this.layersEnabled) {
      this.motion.update(dt);
      this.motion.apply();
      this.acc.reset();
      this.acc.scale = 1 - this.motion.weight;
      this.idle.setBaseWeight(this.motion.baseWeight);
      this.idle.update(dt, this.acc);
      this.gaze.update(dt, vrm, this.acc);
      this.acc.flush(vrm);
    }

    this.expression.setMouthActivity(this.lipsync.openness);
    this.expression.update(dt, vrm);
    this.lipsync.setMouthRoom(1 - 0.6 * this.expression.mouthOcclusion());
    this.lipsync.update(dt, vrm);

    vrm.update(dt);
  }

  dispose() {
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }
}
