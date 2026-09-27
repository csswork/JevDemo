import * as THREE from 'three';
import { VRMUtils } from '@pixiv/three-vrm';
import { createStage } from './vrm/stage';
import { Character } from './vrm/character';
import { TimelinePlayer, compileAct, type CompiledAct } from './act/timeline';
import { estimateDuration, makeMeasuredMapper, makeTimeToChar } from './act/anchors';
import type { ActScript, Emotion } from './act/schema';
import { pickChineseVoice, speak, ttsAvailable, type SpeakHandle } from './speech/tts';
import { VoiceSession } from './speech/voice';

export interface LiveState {
  fps: number;
  posture: string;
  gestures: string[];
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
  private systemVoice: SpeechSynthesisVoice | null = null;
  private speech: SpeakHandle | null = null;
  private compiled: CompiledAct | null = null;
  /** 当前在演的脚本（基线，或者升级之后的）。真实语音的时长到了要用它重新编译 */
  private act: ActScript | null = null;
  private audio: AudioContext | null = null;
  /** 本地语音（Vivian）的这一次说话；没有就是 null（无声或系统语音） */
  private session: VoiceSession | null = null;
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

  async mount(canvas: HTMLCanvasElement, modelUrl: string, onProgress?: (r: number) => void) {
    const stage = createStage(canvas);
    this.stage = stage;
    stage.resize();

    const character = new Character(stage.camera.position);
    this.character = character;

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
      // 手势穿模 / 连贯性审计，见 src/dev/audit.ts。动态 import，生产包里不会有
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
    character.gaze.setCameraPos(stage.camera.position);
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
    if (wasPlaying) this.character?.apply({ time: this.elapsed, kind: 'speech_end' });
    this.onSpeechText?.('');
  }

  /**
   * 换模型。新模型加载好之前旧的一直在画面里，加载好之后一帧内换掉。
   * 正在说的话会停掉 —— 口型、表情、手势都绑在旧模型上。调试开关沿用旧角色的。
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
      next.gesturesEnabled = old.gesturesEnabled;
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
    if (!this.audio) this.audio = new AudioContext();
    if (this.audio.state === 'suspended') void this.audio.resume();
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
    character?.gesture.clear();
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
      if (ev.kind === 'gesture' && this.elapsed - ev.time > 0.8) continue;
      character.apply(ev);
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
    // 手势晚了太久再做也不对劲（笑点已经过去了）
    for (const ev of this.player.upgrade(compiled)) {
      if (ev.kind === 'cue') continue;
      if (ev.kind === 'gesture' && this.elapsed - ev.time > 0.8) continue;
      character.apply(ev);
    }
    character.setArousal(act.emotion.arousal);
    this.judged = true;
    return true;
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

  /** 单独试放一个手势（正常速度播完）。 */
  testGesture(id: string) {
    const g = this.character?.gesture;
    if (!g) return;
    g.frozen = false;
    g.play(id as never, 1, 1);
  }

  // ---- 测试预览播放器（仅 dev 面板用）----
  private preview: { id: string; speed: number; loop: boolean } | null = null;

  /** 从当前姿势开始播放，可以慢放。 */
  playPreview(id: string, speed: number, loop: boolean) {
    const g = this.character?.gesture;
    if (!g) return;
    this.preview = { id, speed, loop };
    g.frozen = false;
    g.clear();
    g.play(id as never, 1, speed);
  }

  setPreviewSpeed(speed: number) {
    if (this.preview) this.preview.speed = speed;
    this.character?.gesture.setSpeed(speed);
  }

  setPreviewLoop(loop: boolean) {
    if (this.preview) this.preview.loop = loop;
  }

  setPreviewPaused(paused: boolean) {
    const g = this.character?.gesture;
    if (!g || !this.preview) return;
    // 已经播完了再按播放：从头开始
    if (!paused && !g.info()) {
      this.playPreview(this.preview.id, this.preview.speed, this.preview.loop);
      return;
    }
    g.frozen = paused;
  }

  /** 拖时间轴：暂停并跳到指定时刻 */
  seekPreview(t: number) {
    const g = this.character?.gesture;
    if (!g || !this.preview) return;
    g.frozen = true;
    g.seek(this.preview.id as never, t);
    g.setSpeed(this.preview.speed);
  }

  previewState() {
    const g = this.character?.gesture;
    const info = g?.info() ?? null;
    return { id: this.preview?.id ?? null, info, paused: !!g?.frozen };
  }

  /** 解除冻结，让当前手势正常播完。 */
  releaseGesture() {
    const g = this.character?.gesture;
    if (!g) return;
    this.preview = null;
    g.frozen = false;
    g.clear();
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

  setGesturesEnabled(v: boolean) {
    if (this.character) this.character.gesturesEnabled = v;
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
    for (const ev of due) {
      character.apply(ev);
    }
    if (session && this.timeToChar) {
      character.lipsync.follow(this.timeToChar(Math.max(0, session.time)), session.level());
    }
    if (this.preview?.loop && !character.gesture.frozen && !character.gesture.info()) {
      character.gesture.play(this.preview.id as never, 1, this.preview.speed);
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
        gestures: character.gesture.activeIds,
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
    this.speech?.cancel();
    this.session?.stop();
    void this.audio?.close();
    this.character?.dispose();
    this.stage?.dispose();
    this.stage = null;
    this.character = null;
  }
}
