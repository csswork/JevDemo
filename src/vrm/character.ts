import * as THREE from 'three';
import { GLTFLoader } from './gltfLoader';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { TimelineEvent } from '../act/timeline';
import { PoseAccumulator, vrmMetaVersion } from './pose';
import { IdleLayer } from './idle';
import { HandLayer } from './hands';
import { IDLE_BASE, MotionLayer, motionTalk } from './motion';
import { GestureLayer } from './gestures';
import { FootLock } from './feet';
import { ManpuLayer } from './manpu';
import { isProceduralMotion, type Emotion, type MotionId } from '../act/schema';
import { moodArousal, moodFace, moodPosture, type MoodState } from '../act/mood';
import { GazeLayer } from './gaze';
import { ExpressionLayer, type ConversationState } from './expressions';
import { LipSyncLayer } from './lipsync';
import { decryptModel, fetchBytes, isProtected } from './protect';

/**
 * 角色控制器 —— Act IR 的消费端。
 *
 * 每帧的层叠顺序是固定的，也是这个 demo 的核心：
 *   resetNormalizedPose → motion → idle → gesture → hands → gaze → flush → 脚底锁定 → gesture IK → expression → lipsync → vrm.update
 *
 * motion 写的是绝对姿势：底层是一直循环的动捕待机，对话触发的动作整体叠在它上面。
 * idle / gaze 是乘在上面的偏移：动作在播时按 (1 - 动作权重) 让出来；
 * 有动捕待机时 idle 只留姿态的微调（呼吸、重心、垂手都由动捕负责）。
 * 手指和说话时手上的小动作由 hands 层负责（动捕待机没有手指轨道）。
 * 程序生成的表演动作（gestures.ts）：身体是叠加的偏移，手碰脸的那只胳膊在 flush 之后用 IK 覆盖。
 * 漫符（manpu.ts）：脸红、阴影竖线、眼泪、💢、♪、！、汗滴，按 Jev 给的情绪挂在头上，跟着头走。
 * 待机时脚踩住地面（feet.ts）：胯部的晃动由膝盖和大腿吸收，脚不跟着滑。
 * 镜头配合（推镜、一震、偏冷）不在这里，在 stage 的 cameraFx.ts：它读 emotionLevels() 和表情层的 takeAccents()。
 *
 * 换渲染引擎（Live2D / Unity / AnimeActEngine）时，需要重写的只有这个文件和 vrm/ 目录；
 * act/ 和 jev/ 两层原样保留。
 */
export class Character {
  vrm: VRM | null = null;

  readonly idle = new IdleLayer();
  readonly hands = new HandLayer();
  readonly motion = new MotionLayer();
  readonly gesture = new GestureLayer();
  readonly gaze: GazeLayer;
  readonly expression = new ExpressionLayer();
  readonly lipsync = new LipSyncLayer();
  readonly feet = new FootLock();
  readonly manpu = new ManpuLayer();

  private acc = new PoseAccumulator();
  /** 调试开关：关掉后只跑 vrm.update，用于隔离"是我的层还是引擎本身"的问题 */
  layersEnabled = true;
  /** 动作总开关（对话里由 Jev 的答案触发的动作；预览面板不受它影响） */
  motionsEnabled = true;
  private hipsRest = new THREE.Vector3();
  private conversation: ConversationState = 'idle';
  /** 困惑时歪头的角度（弧度，平滑过的） */
  private tilt = 0;
  /** 生气时低头瞪人的程度（0..1，平滑过的） */
  private glare = 0;
  /** 嫌弃时把头扭开的程度（0..1，平滑过的） */
  private turnAway = 0;
  /** VRM 0.x 的骨骼局部轴是反的（和 idle 层一样） */
  private axisFlip = 1;
  /** 当前的待机姿态是心情摆的（不是 Jev 给这一句选的） */
  private moodPosed = false;

  constructor(cameraPos: THREE.Vector3) {
    this.gaze = new GazeLayer(cameraPos);
  }

  async load(url: string, onProgress?: (ratio: number) => void): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    // 受保护的模型（.vrmx）先解密再 parse，见 protect.ts
    const gltf = isProtected(url)
      ? await loader.parseAsync(await decryptModel(await fetchBytes(url, onProgress)), '')
      : await loader.loadAsync(url, (e) => {
          if (e.total > 0) onProgress?.(e.loaded / e.total);
        });

    const vrm = gltf.userData.vrm as VRM;

    // 注意：VRMUtils 的 removeUnnecessaryVertices / combineSkeletons / combineMorphs
    // 在这个模型上会撕裂头发的蒙皮（弹簧骨被拽成放射状）。它们是 draw call 优化，
    // 对单角色场景收益很小，这里直接不用。换模型时可以单独试，但务必肉眼验收。
    VRMUtils.rotateVRM0(vrm);

    // 二次元模型不需要视锥剔除，关掉省事也避免手抬高时被裁掉。
    // 投影到地板 / 吧台上（有背景场景时），但不接收阴影 —— 自身阴影在 MToon 的脸上会出条纹瑕疵
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });

    const metaVersion = vrmMetaVersion(vrm);
    this.axisFlip = metaVersion === '0' ? -1 : 1;
    this.idle.setVrmVersion(metaVersion);
    this.hands.setVrmVersion(metaVersion);
    this.gaze.setVrmVersion(metaVersion);

    this.expression.bind(vrm);
    this.lipsync.bind(vrm);
    this.motion.bind(vrm);
    this.gesture.bind(vrm);
    this.feet.reset();
    this.manpu.bind(vrm);
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
        this.moodPosed = false;
        this.idle.setPosture(ev.posture);
        this.hands.setPosture(ev.posture);
        break;
      case 'expression':
        // 整组一次性设定：给定的情绪按权重叠加，没给的淡出。
        // 逐个 setExclusive 会让同时刻的后一拍清掉前一拍，分布退化成 top-1。
        this.expression.setBlend(Object.fromEntries(ev.mix), ev.fade);
        break;
      case 'motion':
        // 对话里只播适合半身景别的那一段（见 MOTION_FILES 的 talk）。
        // 同一个动作已经在播就不重来：Jev 的判断晚到时会把已经过去的节拍补一次
        if (!this.motionsEnabled || this.currentMotion?.id === ev.clip) break;
        void this.playMotion(ev.clip, { speed: ev.speed, ...motionTalk(ev.clip) });
        break;
      case 'gaze':
        this.gaze.look(ev.target, ev.hold);
        break;
      case 'cue':
        this.expression.cue(ev.cue);
        this.hands.cue(ev.cue);
        break;
      case 'speech_start':
        this.setConversation('speaking');
        this.expression.setSpeaking(true);
        this.hands.setSpeaking(true);
        break;
      case 'speech_end':
        this.expression.setSpeaking(false);
        this.hands.setSpeaking(false);
        this.lipsync.stop();
        // 说完不立刻回到面无表情，余韵见 ExpressionLayer.release
        this.expression.release();
        this.setConversation('idle');
        break;
    }
  }

  /**
   * 播一个动作（动捕的 .vrma 或程序生成的），另一种正在播的淡出。
   * 返回 false = 动作文件不在
   */
  playMotion(id: MotionId, opts: { speed?: number; from?: number; to?: number } = {}): Promise<boolean> {
    if (isProceduralMotion(id)) {
      this.motion.stop();
      return Promise.resolve(this.gesture.play(id, opts));
    }
    this.gesture.stop();
    return this.motion.play(id, opts);
  }

  stopMotion() {
    this.motion.stop();
    this.gesture.stop();
  }

  setMotionSpeed(speed: number) {
    this.motion.setSpeed(speed);
    this.gesture.setSpeed(speed);
  }

  seekMotion(t: number) {
    this.motion.seek(t);
    this.gesture.seek(t);
  }

  /** 正在播的上层动作（两种都算） */
  get currentMotion(): { id: MotionId; t: number; duration: number } | null {
    return this.gesture.current ?? this.motion.current;
  }

  /** 正在播，或者正在加载准备播 */
  get motionBusy(): boolean {
    return this.motion.busy || this.gesture.current != null;
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
    this.hands.setArousal(a);
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
      this.gesture.update(dt);
      for (const cue of this.gesture.takeCues()) this.expression.cue(cue);
      this.gesture.addOffsets(this.acc);
      this.hands.setShape('left', this.gesture.handShape('left'));
      this.hands.setShape('right', this.gesture.handShape('right'));
      // 说话时的节拍落在发声的音节上：口型此刻张多大（上一帧的，差一帧无所谓）
      this.hands.setVoice(this.lipsync.openness);
      this.hands.update(dt, this.acc);
      this.gaze.update(dt, vrm, this.acc);
      // 困惑：微微歪头（最多约 9°，头和脖子分着歪），跟着表情层的困惑强度走。上一帧的强度，差一帧无所谓
      const confused = this.expression.weightOf('confused') / Math.max(0.05, this.expression.ceiling.confused ?? 1);
      const tiltGoal = THREE.MathUtils.degToRad(9) * THREE.MathUtils.smoothstep(confused, 0.2, 0.65);
      this.tilt += (tiltGoal - this.tilt) * (1 - Math.exp(-(tiltGoal > this.tilt ? 5 : 2.5) * dt));
      if (this.tilt > 1e-4) {
        this.acc.add('neck', 0, 0, -0.4 * this.tilt * this.axisFlip);
        this.acc.add('head', 0, 0, -0.6 * this.tilt * this.axisFlip);
      }
      // 生气：低一点头（收下巴），眼睛照样盯着对方 —— 从眉毛底下瞪过来
      const angry = this.expression.weightOf('angry') / Math.max(0.05, this.expression.ceiling.angry ?? 1);
      const glareGoal = THREE.MathUtils.smoothstep(angry, 0.35, 0.75);
      this.glare += (glareGoal - this.glare) * (1 - Math.exp(-(glareGoal > this.glare ? 4 : 2) * dt));
      if (this.glare > 1e-3) {
        this.acc.add('neck', THREE.MathUtils.degToRad(2.5) * this.glare * this.axisFlip, 0, 0);
        this.acc.add('head', THREE.MathUtils.degToRad(4) * this.glare * this.axisFlip, 0, 0);
      }
      // 嫌弃：头扭开一点、低一点、往另一边歪一点；眼睛还由视线层盯着对方 —— 合起来就是斜着瞟过来的白眼
      const disgusted = this.expression.weightOf('disgusted') / Math.max(0.05, this.expression.ceiling.disgusted ?? 1);
      const awayGoal = THREE.MathUtils.smoothstep(disgusted, 0.3, 0.7);
      this.turnAway += (awayGoal - this.turnAway) * (1 - Math.exp(-(awayGoal > this.turnAway ? 4 : 2) * dt));
      if (this.turnAway > 1e-3) {
        const k = this.turnAway;
        this.acc.add('neck', THREE.MathUtils.degToRad(2) * k * this.axisFlip, THREE.MathUtils.degToRad(7) * k, 0);
        this.acc.add(
          'head',
          THREE.MathUtils.degToRad(3) * k * this.axisFlip,
          THREE.MathUtils.degToRad(9) * k,
          THREE.MathUtils.degToRad(4) * k * this.axisFlip,
        );
      }
      this.acc.flush(vrm);
      // 上层动作（转圈、深蹲……）自己会动脚，按它的权重让出来；动捕待机淡入淡出时重新落脚
      const bw = this.motion.baseWeight;
      this.feet.solve(vrm, 1 - this.motion.weight, bw > 0.02 && bw < 0.98);
      this.gesture.solve(vrm);
    }

    this.expression.setMouthActivity(this.lipsync.openness);
    this.expression.update(dt, vrm);
    this.manpu.update(dt, this.emotionLevels());
    this.lipsync.setMouthRoom(1 - 0.6 * this.expression.mouthOcclusion());
    this.lipsync.update(dt, vrm);

    vrm.update(dt);
  }

  /**
   * 用户发完消息、还在"想"的时候，Jev 的倾听反应到了：先用视线和漫符回应一下（表情由调用方设）。
   *   视线：多数情绪是转回来看着你（"听到了"）；害羞、难过是垂下眼
   *   漫符：反应偏温和时自动的符号可能还没到阈值，这里补一个一次性的 ♪ / ！，保证有个看得见的回应
   * 返回最强的那个情绪和强度（镜头的那一下用）
   */
  acknowledge(mix: Partial<Record<Emotion, number>>): { emo: Emotion; weight: number } | null {
    let top: { emo: Emotion; weight: number } | null = null;
    for (const [emo, w] of Object.entries(mix) as Array<[Emotion, number]>) {
      if (emo !== 'neutral' && w > (top?.weight ?? 0)) top = { emo, weight: w };
    }
    if (!top || top.weight < 0.25) {
      this.gaze.acknowledge('camera', 0.9);
      return top;
    }
    const down = top.emo === 'shy' || top.emo === 'sad';
    this.gaze.acknowledge(down ? 'down' : 'camera', down ? 1.1 : 1.3);
    if (top.emo === 'happy' || top.emo === 'relaxed') this.manpu.trigger('note');
    else if (top.emo === 'surprised' && top.weight < 0.45) this.manpu.trigger('exclaim');
    return top;
  }

  /**
   * 跨轮心情（act/mood.ts）：不说话时脸上的底色、漫符。
   * settle = 现在是闲着的时候（说完了 / 心情刚变）：顺便把待机姿态和节奏也换成心情的
   */
  setMood(m: MoodState, settle: boolean) {
    this.expression.setResting(moodFace(m));
    this.manpu.setMood(m);
    if (!settle || this.conversation === 'speaking') return;
    const p = moodPosture(m);
    if (p || this.moodPosed) {
      // 心情过去了：心情摆出来的姿态回到中性（Jev 给这一句选的姿态不动）
      this.idle.setPosture(p ?? 'idle_neutral');
      this.hands.setPosture(p ?? 'idle_neutral');
      this.moodPosed = !!p;
    }
    const a = moodArousal(m);
    if (a != null) this.setArousal(a);
  }

  /**
   * 各情绪此刻的语义强度（0..1），漫符和镜头都读它。
   * 是 Jev 定的强度：整脸预设的模型上表情层按 ceiling 压过幅度，这里还原回来
   */
  emotionLevels() {
    const ex = this.expression;
    const level = (e: Exclude<Emotion, 'neutral'>) =>
      Math.min(1, ex.weightOf(e) / Math.max(0.05, ex.ceiling[e] ?? 1));
    return {
      happy: level('happy'),
      angry: level('angry'),
      sad: level('sad'),
      relaxed: level('relaxed'),
      surprised: level('surprised'),
      shy: level('shy'),
      smug: level('smug'),
      confused: level('confused'),
      disgusted: level('disgusted'),
    };
  }

  dispose() {
    this.motion.unbind();
    this.manpu.dispose();
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }
}
