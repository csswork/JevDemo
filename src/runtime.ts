import { VRMUtils } from '@pixiv/three-vrm';
import { createStage } from './vrm/stage';
import { Character } from './vrm/character';
import { TimelinePlayer, compileAct, type CompiledAct } from './act/timeline';
import { estimateDuration } from './act/anchors';
import type { ActScript, Emotion } from './act/schema';
import { pickChineseVoice, speak, ttsAvailable, type SpeakHandle } from './speech/tts';

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
  private voice: SpeechSynthesisVoice | null = null;
  private speech: SpeakHandle | null = null;
  private compiled: CompiledAct | null = null;
  private elapsed = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;
  private stateTimer = 0;

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

    // 调参用：控制台里可以直接 __jev.character / __jev.stage 拨数值
    if (import.meta.env.DEV) {
      (window as unknown as { __jev: unknown }).__jev = this;
      // 手势穿模 / 连贯性审计，见 src/dev/audit.ts。动态 import，生产包里不会有
      void import('./dev/audit').then((m) => m.installAudit(this));
    }

    if (ttsAvailable()) this.voice = await pickChineseVoice();
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

  /** 播放一段表演。返回编译后的时间轴，供 UI 展示。 */
  play(act: ActScript): CompiledAct {
    const character = this.character;
    // 先估算时长；TTS 开启时 boundary 事件会在播放中校正口型
    const text = act.speech.replace(/<b:[a-z0-9_]+>/gi, '');
    const duration = estimateDuration(text);
    const compiled = compileAct(act, { duration });

    this.compiled = compiled;
    this.elapsed = 0;
    this.judged = false;
    this.player.start(compiled);
    character?.setArousal(act.emotion.arousal);
    character?.gesture.clear();
    character?.lipsync.start(compiled.text, compiled.duration);
    this.onSpeechText?.(compiled.text);

    this.speech?.cancel();
    this.speech = null;
    if (this.ttsEnabled && ttsAvailable()) {
      this.speech = speak(compiled.text, {
        voice: this.voice,
        onEnd: () => {
          this.character?.lipsync.stop();
        },
      });
    }

    return compiled;
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

    const compiled = compileAct(act, { duration: base.duration });
    if (compiled.text !== base.text) return false;

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
    for (const ev of this.player.update(dt)) {
      character.apply(ev);
    }
    if (this.preview?.loop && !character.gesture.frozen && !character.gesture.info()) {
      character.gesture.play(this.preview.id as never, 1, this.preview.speed);
    }
    character.layersEnabled = this.layersEnabled;
    if (this.player.isPlaying) this.elapsed += dt;
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
    this.character?.dispose();
    this.stage?.dispose();
    this.stage = null;
    this.character = null;
  }
}
