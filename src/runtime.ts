import * as THREE from 'three';
import { VRMUtils } from '@pixiv/three-vrm';
import { createStage, type BackdropId, type CameraView } from './vrm/stage';
import type { TimeMode } from './vrm/timeOfDay';
import { Character } from './vrm/character';
import { TimelinePlayer, compileAct, type CompiledAct, type TimelineEvent } from './act/timeline';
import { estimateDuration, makeMeasuredMapper, makeTimeToChar } from './act/anchors';
import { isProceduralMotion, type ActScript, type Emotion, type MotionId } from './act/schema';
import { GESTURES } from './vrm/gestures';
import { pickChineseVoice, speak, ttsAvailable, type SpeakHandle } from './speech/tts';
import { VoiceSession } from './speech/voice';
import { AmbiencePlayer } from './speech/ambience';

export interface LiveState {
  fps: number;
  posture: string;
  /** 正在播的动作（没有就是 null） */
  motion: string | null;
  gaze: string;
  expressions: Array<[string, number]>;
  speaking: boolean;
  progress: number;
}

/**
 * 把 stage / character / 时间轴 / TTS 串起来的运行时。
 * React 只负责 UI，渲染循环完全在 React 之外跑，避免 re-render 影响帧率。
 */
export class Runtime {
  stage: ReturnType<typeof createStage> | null = null;
  character: Character | null = null;
  layersEnabled = true;
  private player = new TimelinePlayer();
  private lastTime = 0;
  private raf = 0;
  private idleArmClearance = 0;
  private systemVoice: SpeechSynthesisVoice | null = null;
  private speech: SpeakHandle | null = null;
  private compiled: CompiledAct | null = null;
  /** 当前在演的脚本（基线，或者升级之后的）。真实语音的时长到了要用它重新编译 */
  private act: ActScript | null = null;
  private audio: AudioContext | null = null;
  /** 本地语音（Vivian）的这一次说话；没有就是 null（无声或系统语音） */
  private session: VoiceSession | null = null;
  /** 场景背景音。AudioContext 在 unlockAudio 里才建，见那里的注释 */
  private ambience: AmbiencePlayer | null = null;
  /** 用户开关：关掉就不再出声（只影响这一层，场景自己声明什么照旧） */
  private ambienceEnabled = true;
  /** 页面是不是在前台（可见 + 窗口有焦点） */
  private pageActive = true;
  /** 此刻的秒 → 字符下标，给口型用 */
  private timeToChar: ((t: number) => number) | null = null;
  private elapsed = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;
  private stateTimer = 0;

  /** 系统语音（Web Speech）。本地语音可用时不用它 */
  ttsEnabled = false;
  /**
   * dispose() 可能在 mount() 的 await 返回之前就被调用（React StrictMode 会挂两次，
   * 而模型加载要好几秒）。那种情况下 mount 剩下的部分必须全部跳过 ——
   * 否则会给一个已经废弃的实例启动 rAF 循环，它永远不停。
   */
  private disposed = false;
  onState: ((s: LiveState) => void) | null = null;
  onSpeechText: ((text: string) => void) | null = null;
  /**
   * 下一次取景（mount / setModel）之后换成这个视角：用户上次离开这个角色时的角度。用一次就清掉。
   * 在取景的同一帧里换，不会先闪一下默认的半身机位
   */
  pendingView: CameraView | null = null;
  /** 用户转完 / 拉完镜头、停稳之后调一次（App 用它把视角存下来） */
  onViewChange: (() => void) | null = null;
  private viewTimer = 0;

  getView(): CameraView | null {
    return this.stage?.getView() ?? null;
  }

  setView(view: CameraView) {
    this.stage?.setView(view);
  }

  async mount(canvas: HTMLCanvasElement, modelUrl: string, onProgress?: (r: number) => void) {
    const stage = createStage(canvas);
    this.stage = stage;
    stage.resize();
    stage.setBackdrop(this.backdrop);
    stage.setTimeOfDay(this.timeMode, true);
    this.applyAmbience();
    // 松开鼠标之后镜头还会因为阻尼滑一小段：等它停稳了再通知
    stage.controls.addEventListener('end', () => {
      clearTimeout(this.viewTimer);
      this.viewTimer = window.setTimeout(() => this.onViewChange?.(), 700);
    });

    const character = new Character(stage.camera.position);
    this.character = character;
    character.motion.setArmClearance(this.idleArmClearance);

    const vrm = await character.load(modelUrl, onProgress);
    if (this.disposed) {
      VRMUtils.deepDispose(vrm.scene);
      stage.dispose();
      return vrm;
    }
    stage.scene.add(vrm.scene);
    this.frameCharacter(character);

    // 调参用：控制台里可以直接 __jev.character / __jev.stage 拨数值
    if (import.meta.env.DEV) {
      (window as unknown as { __jev: unknown }).__jev = this;
      // 表情 / 动作的观察工具，见 src/dev/audit.ts。动态 import，生产包里不会有
      void import('./dev/audit').then((m) => m.installAudit(this));
    }

    if (ttsAvailable()) this.systemVoice = await pickChineseVoice();
    if (this.disposed) return vrm;

    this.lastTime = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);

    return vrm;
  }

  resize() {
    this.stage?.resize();
  }

  /**
   * 按模型的眼睛高度取景（模型之间身高差得很多：眼高 1.25 ~ 1.61m）。
   * 没有眼睛骨骼的模型（Seed-san）用头骨往上 6cm —— 12 个样例模型实测眼睛比头骨高 4.6 ~ 6.5cm
   */
  private frameCharacter(character: Character) {
    const stage = this.stage;
    const vrm = character.vrm;
    if (!stage || !vrm) return;
    vrm.scene.updateMatrixWorld(true);
    const eye = vrm.humanoid.getRawBoneNode('leftEye');
    const head = vrm.humanoid.getRawBoneNode('head');
    const eyeY = eye
      ? eye.getWorldPosition(new THREE.Vector3()).y
      : head
        ? head.getWorldPosition(new THREE.Vector3()).y + 0.06
        : null;
    if (eyeY == null) return;
    stage.frame(eyeY);
    // 视线看的是默认机位（"对话的人"站的地方），不是恢复出来的视角：先记默认机位，再换视角
    character.gaze.setCameraPos(stage.camera.position);
    if (this.pendingView) {
      stage.setView(this.pendingView);
      this.pendingView = null;
    }
  }

  private modelLoad = 0;

  /** 停下正在说的话（换模型、重置对话时）。表情照常慢慢淡掉 */
  stop() {
    const wasPlaying = this.player.isPlaying;
    this.player.stop();
    this.session?.stop();
    this.session = null;
    this.speech?.cancel();
    this.speech = null;
    // 说到一半停下：补一个"说完了"，不然对话状态会一直停在 speaking、嘴也不合上
    if (wasPlaying) this.apply({ time: this.elapsed, kind: 'speech_end' });
    this.onSpeechText?.('');
  }

  /**
   * 换模型。新模型加载好之前旧的一直在画面里，加载好之后一帧内换掉。
   * 正在说的话会停掉 —— 口型、表情、动作都绑在旧模型上。调试开关沿用旧角色的。
   * 连着换好几次时只有最后一次生效。
   */
  async setModel(url: string, onProgress?: (r: number) => void): Promise<boolean> {
    const stage = this.stage;
    if (!stage) return false;
    const id = ++this.modelLoad;
    const next = new Character(stage.camera.position);
    const vrm = await next.load(url, onProgress);
    if (this.disposed || id !== this.modelLoad) {
      next.dispose();
      return false;
    }

    this.stop();
    this.preview = null;

    const old = this.character;
    if (old) {
      next.motionsEnabled = old.motionsEnabled;
      next.motion.setArmClearance(this.idleArmClearance);
      next.expression.microEnabled = old.expression.microEnabled;
      next.idle.setBodyMotion(old.idle.bodyMotionScale);
      if (old.vrm) stage.scene.remove(old.vrm.scene);
      old.dispose();
    }
    stage.scene.add(vrm.scene);
    this.character = next;
    this.frameCharacter(next);
    this.onSpeechText?.('');
    return true;
  }

  // ---- 本地语音 ----

  /**
   * 浏览器要求音频必须在用户操作里启动。发送消息时调一次（点击 / 回车都算用户操作），
   * 之后同一个 AudioContext 一直复用。
   */
  unlockAudio() {
    if (!this.audio) {
      this.audio = new AudioContext();
      // 背景音复用同一个 ctx：浏览器只把音频放行给"在用户手势里建的那一个"
      this.ambience = new AmbiencePlayer(this.audio);
      this.applyAmbience();
      this.ambience.unlock();
      // 状态和"在不在前台"对不上就纠正：
      //   在前台却被挂起 —— 浏览器自己挂起/打断的（换音频设备、休眠恢复），不声不响，要拉回来；
      //   不在前台却在跑 —— 一次迟到的 resume（见 setPageActive），立刻挂回去
      this.audio.onstatechange = () => {
        const ctx = this.audio;
        if (!ctx) return;
        if (this.pageActive && ctx.state === 'suspended') void ctx.resume().catch(() => {});
        else if (!this.pageActive && ctx.state === 'running') void ctx.suspend().catch(() => {});
      };
      // 建的时候页面就不在前台（少见）：立刻挂起来，别出声
      if (!this.pageActive) void this.audio.suspend().catch(() => {});
    }
    if (this.audio.state === 'suspended' && this.pageActive) void this.audio.resume();
  }

  /** 把"当前场景 + 用户开关"合起来告诉背景音层 */
  private applyAmbience() {
    const url = this.stage?.ambience ?? null;
    this.ambience?.setScene(this.ambienceEnabled ? url : null, this.stage?.ambienceVolume ?? undefined);
  }

  /** 背景音开关（面板上的复选框） */
  setAmbience(on: boolean) {
    this.ambienceEnabled = on;
    this.applyAmbience();
  }

  /**
   * 切到别的 tab / 别的窗口时传 false，回来传 true。
   *
   * 挂起的是**整个 AudioContext**，而不是逐个去停声音：它一挂起，背景音和正在说的
   * 那句话一起暂停，而且**音频时钟也冻住** —— 回来 resume 时两者都从原来的位置接着走，
   * 不会出现"切走两分钟、回来发现话已经说完了"。
   *
   * 时间轴本身不用管：它由 tick() 里的 rAF 推进，后台标签页里 rAF 本来就被节流到几乎不动。
   * Web Speech（系统语音兜底）不走 AudioContext，要单独 pause / resume。
   */
  /** 调试用：前后台状态和音频上下文的状态 */
  get audioDebug() {
    return { active: this.pageActive, ctx: this.audio?.state ?? 'none', ambience: this.ambience?.current ?? null };
  }

  setPageActive(active: boolean) {
    const changed = active !== this.pageActive;
    this.pageActive = active;
    const ctx = this.audio;
    if (!ctx) return;
    if (active) {
      if (!changed) return;
      this.wakeAudio();
      this.speech?.resume();
      return;
    }
    // 不在前台就必须挂起，而且**不看当前状态**：resume() 是异步的。多显示器上从另一块屏点回来、
    // 点的却是别的 tab 时，focus → blur → hidden 在 3ms 内连着来 —— focus 发出的 resume 还没完成，
    // 此刻状态仍是 suspended，按"running 才挂起"就漏掉了，等 resume 完成时页面已经在后台，声音就响了
    // （dev-out/audio_*.txt 的日志里抓到的）。在途的 resume 之后再排一个 suspend，最终一定是挂起的。
    // 定时复查（状态没变）时也兜一下：万一还是跑起来了就再挂回去
    if (changed || ctx.state === 'running') void ctx.suspend().catch(() => {});
    if (changed) this.speech?.pause();
  }

  /**
   * 把声音要回来（长时间后台、系统休眠、切换音频输出设备之后）。
   *
   * 这里**不看"是不是我们挂起的"**：休眠/唤醒之后浏览器的音频状态我们并不掌握 ——
   * 上下文可能是它自己挂起的，设备可能刚回来导致第一次 resume 空转，
   * 最坏的情况是整条音频图已经作废。所以：
   *   1. 只要不是 running 就无条件 resume；
   *   2. 之后把背景音那条源重起一次（见 AmbiencePlayer.resumeFromBackground）；
   *   3. 隔 400ms 再确认一次，兜住"设备还没回来"的那一次空转。
   */
  private wakeAudio() {
    const ctx = this.audio;
    if (!ctx) return;
    const play = () => {
      if (this.pageActive) this.ambience?.resumeFromBackground();
    };
    if (ctx.state === 'running') {
      play();
      return;
    }
    // resume 完成时页面可能已经切走了（onstatechange 会挂回去，这里只是不再重起背景音）
    void ctx.resume().then(play, () => {});
    setTimeout(() => {
      const c = this.audio;
      if (!this.pageActive || !c || c.state === 'running') return;
      void c.resume().then(play, () => {});
    }, 400);
  }

  /** 本地语音的音色（预设音色 id）；null = 用服务端默认音色 */
  voiceSpeaker: string | null = null;

  /** 为一句台词准备本地语音。之后 prepare() 合成第一段，再交给 play({ voice }) */
  createVoice(text: string): VoiceSession | null {
    if (!this.audio) return null;
    return new VoiceSession(this.audio, text.replace(/<b:[a-z0-9_]+>/gi, ''), this.voiceSpeaker);
  }

  /**
   * 字符 ↔ 时间的换算。有真实语音时用每一段的实测起止时间（还没合成的段按语速外推），
   * 否则按字数估算。
   */
  private timing(text: string): { duration: number; charToTime: (i: number) => number } {
    const chars = text.length;
    const session = this.session;
    if (!session) {
      const duration = estimateDuration(text);
      this.timeToChar = null;
      return { duration, charToTime: (i) => (i / Math.max(1, chars)) * duration };
    }
    const duration = Math.max(0.3, session.estimatedDuration());
    const samples = session.samples.filter((p) => p.charIndex > 0 && p.charIndex < chars);
    this.timeToChar = makeTimeToChar(samples, chars, duration);
    return { duration, charToTime: makeMeasuredMapper(samples, chars, duration) };
  }

  /** 播放一段表演。返回编译后的时间轴，供 UI 展示。 */
  play(act: ActScript, opts: { voice?: VoiceSession | null } = {}): CompiledAct {
    const character = this.character;
    const text = act.speech.replace(/<b:[a-z0-9_]+>/gi, '');

    this.session?.stop();
    this.session = opts.voice ?? null;
    this.speech?.cancel();
    this.speech = null;

    const compiled = compileAct(act, this.timing(text));
    this.act = act;
    this.compiled = compiled;
    this.elapsed = 0;
    this.judged = false;
    this.player.start(compiled);
    character?.setArousal(act.emotion.arousal);
    character?.lipsync.start(compiled.text, compiled.duration);
    this.onSpeechText?.(compiled.text);

    if (this.session) {
      // 每合成好一段，时长就更准一点：重新编译时间轴，表情锚点落到真实的时间上
      this.session.onUpdate = () => this.retime();
      this.session.play();
    } else if (this.ttsEnabled && ttsAvailable()) {
      this.speech = speak(compiled.text, {
        voice: this.systemVoice,
        onEnd: () => {
          this.character?.lipsync.stop();
        },
      });
    }

    return compiled;
  }

  /**
   * 真实语音的某一段排上了：用新的时长重新编译当前脚本，替换还没触发的节拍
   * （和渐进升级是同一个机制，只是这次变的是时间，不是内容）。
   */
  private retime() {
    const character = this.character;
    if (!this.session || !this.act || !character || !this.player.isPlaying) return;
    const compiled = compileAct(this.act, this.timing(this.compiled?.text ?? ''));
    for (const ev of this.player.upgrade(compiled, { retime: true })) {
      if (ev.kind === 'cue') continue;
      if (ev.kind === 'motion' && this.elapsed - ev.time > 0.8) continue;
      this.apply(ev);
    }
    this.compiled = compiled;
  }

  /**
   * 渐进升级：把判断层晚到的表演接到正在播的台词上。
   *
   * 角色已经在用基线表演说话了，这里只换还没触发的节拍，已经过去的一次性补齐。
   * 台词和时长必须和 play() 时一致，否则锚点解析出的时间对不上 —— 不一致就直接放弃，
   * 宁可保持基线表演，也不能让口型和台词错位。
   */
  upgrade(act: ActScript): boolean {
    const base = this.compiled;
    const character = this.character;
    if (!base || !character || !this.player.isPlaying) return false;

    const compiled = compileAct(act, this.session ? this.timing(base.text) : { duration: base.duration });
    if (compiled.text !== base.text) return false;
    this.act = act;

    // 补齐已经过去的节拍时，只补"状态"（表情、视线、姿态），不补"瞬间"：
    // 过去的节奏信号（问句睁眼、句界眨眼）现在补上会在同一帧里一齐爆出来；
    // 动作晚了太久再做也不对劲（该打招呼的那一刻已经过去了）
    for (const ev of this.player.upgrade(compiled)) {
      if (ev.kind === 'cue') continue;
      if (ev.kind === 'motion' && this.elapsed - ev.time > 0.8) continue;
      this.apply(ev);
    }
    character.setArousal(act.emotion.arousal);
    this.judged = true;
    return true;
  }

  /**
   * 时间轴事件的统一入口。
   * 这里只多管一件渲染层不关心的事：角色开口时把背景音压下去，说完抬回来。
   */
  private apply(ev: TimelineEvent) {
    if (ev.kind === 'speech_start') this.ambience?.setDucked(true);
    else if (ev.kind === 'speech_end') this.ambience?.setDucked(false);
    this.character?.apply(ev);
  }

  // ---- 对话状态 ----
  // 这几个只改神态（视线、眼神、抿嘴），不设定情绪 —— 情绪只来自 Jev。

  /** 用户在打字：看着对方、眼睛稍微睁开。说话 / 思考时不打断 */
  setListening(on: boolean) {
    const ch = this.character;
    if (!ch) return;
    const s = ch.conversationState;
    if (s === 'speaking' || s === 'thinking') return;
    ch.setConversation(on ? 'listening' : 'idle');
  }

  /** 用户发出消息，等台词期间：视线移开去"想"，抿嘴，眨一下眼表示听到了 */
  think() {
    const ch = this.character;
    if (!ch) return;
    // 新的一轮开始了，上一轮的"已判断"作废，这一轮的倾听反应才能上脸
    this.judged = false;
    ch.setConversation('thinking');
    ch.expression.cue('boundary');
  }

  /**
   * Jev 给的倾听反应到了。还没开口就先上脸；已经开口、整句的判断还没回来，
   * 也用它替掉基线的中性脸。整句判断回来之后就不再接受（那时反应已经过时了）。
   */
  react(mix: Array<[Emotion, number]>) {
    const ch = this.character;
    if (!ch || this.judged) return;
    ch.expression.setBlend(Object.fromEntries(mix), 0.3);
  }

  /** 整句判断是否已经到了（到了之后倾听反应作废） */
  private judged = false;

  // ---- 动作预览（仅 dev 面板用）----
  private preview: { id: MotionId; speed: number; loop: boolean; paused: boolean } | null = null;

  /** 预览一个动作：从当前姿势交叉淡入，可以慢放、循环 */
  playMotion(id: MotionId, speed = 1, loop = false) {
    const ch = this.character;
    if (!ch) return;
    this.preview = { id, speed, loop, paused: false };
    // 程序生成的表演动作带着它该配的表情一起预览（只在开发面板；对话里的表情照常由 Jev 定）
    const face = isProceduralMotion(id) ? GESTURES[id].preview : undefined;
    if (face) ch.expression.setBlend(face, 0.3);
    void ch.playMotion(id, { speed });
  }

  stopMotion() {
    this.preview = null;
    this.character?.stopMotion();
  }

  setPreviewSpeed(speed: number) {
    if (!this.preview) return;
    this.preview.speed = speed;
    if (!this.preview.paused) this.character?.setMotionSpeed(speed);
  }

  setPreviewLoop(loop: boolean) {
    if (this.preview) this.preview.loop = loop;
  }

  setPreviewPaused(paused: boolean) {
    const ch = this.character;
    if (!ch || !this.preview) return;
    // 已经播完了再按播放：从头开始
    if (!paused && !ch.currentMotion) {
      this.playMotion(this.preview.id, this.preview.speed, this.preview.loop);
      return;
    }
    this.preview.paused = paused;
    ch.setMotionSpeed(paused ? 0 : this.preview.speed);
  }

  /** 拖时间轴：暂停并跳到指定时刻 */
  seekPreview(t: number) {
    const ch = this.character;
    if (!ch || !this.preview) return;
    this.preview.paused = true;
    ch.setMotionSpeed(0);
    ch.seekMotion(t);
  }

  previewState() {
    const cur = this.character?.currentMotion ?? null;
    return { id: this.preview?.id ?? null, current: cur, paused: !!this.preview?.paused };
  }

  /** 直接让表情层演一个情绪，走完整通路（含换表情时的眨眼和微表情）。 */
  testEmotion(emo: Emotion, weight = 0.85) {
    this.character?.expression.setExclusive(emo, weight, 0.22);
  }

  /** 试听单个表情槽：把权重钉死，传 null 交还给自动系统。 */
  overrideExpression(name: string, weight: number | null) {
    this.character?.expression.override(name, weight);
  }

  clearExpressionOverrides() {
    this.character?.expression.clearOverrides();
  }

  get expressionSlots(): string[] {
    return this.character?.expression.available ?? [];
  }

  setBodyMotion(scale: number) {
    this.character?.idle.setBodyMotion(scale);
  }

  private backdrop: BackdropId = 'none';
  private ambienceTimer = 0;
  private timeMode: TimeMode | number = 'now';

  /** 背景场景（mount 前后调用都行） */
  setBackdrop(id: BackdropId) {
    this.backdrop = id;
    this.stage?.setBackdrop(id);
    this.applyAmbience();
  }

  /**
   * 时间（只有街景用）：跟随现在 / 清晨 / 白天 / 黄昏 / 夜晚。mount 前后调用都行；
   * mount 之前设的（读偏好）直接跳过去，之后换的花 3 秒过渡
   */
  setTimeOfDay(mode: TimeMode) {
    this.timeMode = mode;
    this.stage?.setTimeOfDay(mode);
  }

  /** 调试：固定在某个钟点（太阳时，比如 19.5）。instant = 不过渡 */
  setTime(hours: number, instant = true) {
    this.timeMode = hours;
    this.stage?.setTimeOfDay(hours, instant);
  }

  /** 待机时上臂额外外展（按模型的裙子定，见 models.ts 的 armOut）。mount / setModel 前后调用都行 */
  setIdleArmClearance(deg: number) {
    this.idleArmClearance = deg;
    this.character?.motion.setArmClearance(deg);
  }

  setMotionsEnabled(v: boolean) {
    if (this.character) this.character.motionsEnabled = v;
  }

  setMicroExpressions(v: boolean) {
    if (this.character) this.character.expression.microEnabled = v;
  }

  setCeiling(emo: Emotion, value: number) {
    this.character?.expression.setCeiling(emo, value);
  }

  /**
   * 推进一帧（时间轴 + 角色），不渲染。rAF 循环每帧调一次；
   * 审计工具（src/dev/audit.ts）也用它同步逐帧推进 —— 预览窗格隐藏时 rAF 会被节流。
   */
  step(dt: number) {
    const character = this.character;
    if (!character) return;
    // 有真实语音时时钟跟着音频走：下一段晚到了、播放顿了一下，表情也一起等
    const session = this.player.isPlaying ? this.session : null;
    const due = session ? this.player.updateTo(session.time) : this.player.update(dt);
    for (const ev of due) this.apply(ev);
    if (session && this.timeToChar) {
      character.lipsync.follow(this.timeToChar(Math.max(0, session.time)), session.level());
    }
    // 预览循环：快放完（开始淡出）时从头再来，首尾交叉淡化
    if (this.preview?.loop && !this.preview.paused && !character.motionBusy) {
      void character.playMotion(this.preview.id, { speed: this.preview.speed });
    }
    character.layersEnabled = this.layersEnabled;
    if (session) this.elapsed = Math.max(0, session.time);
    else if (this.player.isPlaying) this.elapsed += dt;
    character.update(dt);
  }

  private tick() {
    const stage = this.stage;
    const character = this.character;
    if (!stage || !character) return;

    const now = performance.now();
    // 夹住 dt：切到后台标签页再切回来时 dt 会是几秒，足以让弹簧骨炸开
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    this.step(dt);
    stage.render();

    // 环境音的音量可能随时间变（街景夜里调低）：每秒对一次，变了才推（播放层 0.4 秒平滑过去，不会重播）
    this.ambienceTimer += dt;
    if (this.ambienceTimer >= 1) {
      this.ambienceTimer = 0;
      this.applyAmbience();
    }

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    // 调试面板不需要 60Hz，10Hz 足够且省掉大量 React re-render
    this.stateTimer += dt;
    if (this.stateTimer >= 0.1 && this.onState) {
      this.stateTimer = 0;
      this.onState({
        fps: Math.round(this.fps),
        posture: character.idle.currentPosture,
        motion: character.motion.current?.id ?? null,
        gaze: character.gaze.currentTarget,
        expressions: character.expression.snapshot(),
        speaking: character.lipsync.isActive,
        progress: this.compiled ? Math.min(1, this.elapsed / this.compiled.duration) : 0,
      });
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.viewTimer);
    this.speech?.cancel();
    this.session?.stop();
    this.ambience?.dispose();
    void this.audio?.close();
    this.character?.dispose();
    this.stage?.dispose();
    this.stage = null;
    this.character = null;
  }
}
