/**
 * Act IR → 绝对时间事件流。
 *
 * 这是"表演调度"与"渲染"的分界：编译产物只有 { time, kind, payload }，
 * 不含任何 three.js 概念。换 Live2D / Unity 只需另写一个消费者。
 */

import { GESTURES, type ActScript, type Emotion, type GazeTarget, type GestureId, type PostureId, type TimeRef } from './schema';
import { estimateDuration, makeLinearMapper, parseAnchors, type Anchor } from './anchors';

export type TimelineEvent =
  | { time: number; kind: 'expression'; preset: Emotion; weight: number; fade: number }
  | { time: number; kind: 'gesture'; clip: GestureId; weight: number; speed: number }
  | { time: number; kind: 'gaze'; target: GazeTarget; hold?: number }
  | { time: number; kind: 'posture'; posture: PostureId }
  | { time: number; kind: 'speech_start'; text: string }
  | { time: number; kind: 'speech_end' };

export interface CompiledAct {
  /** 剥离锚点后的台词，用于显示和 TTS */
  text: string;
  duration: number;
  events: TimelineEvent[];
}

export function compileAct(act: ActScript, opts: { duration?: number } = {}): CompiledAct {
  const { text, anchors } = parseAnchors(act.speech);
  const duration = opts.duration ?? estimateDuration(text);
  const charToTime = makeLinearMapper(text.length, duration);

  const anchorTime = (name: string): number | null => {
    const a: Anchor | undefined = anchors.find((x) => x.name === name);
    return a ? charToTime(a.charIndex) : null;
  };

  const resolve = (ref: TimeRef): number => {
    if (typeof ref === 'number') return Math.max(0, ref);
    return anchorTime(ref.anchor) ?? 0;
  };

  const events: TimelineEvent[] = [
    { time: 0, kind: 'posture', posture: act.tracks.posture },
    { time: 0, kind: 'speech_start', text },
    { time: duration, kind: 'speech_end' },
  ];

  for (const b of act.tracks.expression) {
    events.push({
      time: resolve(b.at),
      kind: 'expression',
      preset: b.preset,
      weight: b.weight,
      fade: b.fade ?? 0.25,
    });
  }
  for (const b of act.tracks.gesture) {
    events.push({
      time: resolve(b.at),
      kind: 'gesture',
      clip: b.clip,
      weight: b.weight ?? 1,
      speed: b.speed ?? 1,
    });
  }
  for (const b of act.tracks.gaze) {
    events.push({ time: resolve(b.at), kind: 'gaze', target: b.target, hold: b.hold });
  }

  // 锚点名如果正好是一个手势 id，就自动补一条手势 —— Jev 写 `<b:wave>` 即可出动作，
  // 不必在 gesture 数组里重复声明。名字不在手势表里的锚点是**纯时间标记**，
  // 只供 expression / gaze 的 at 引用，不产生任何动作。
  const isGesture = (n: string): n is GestureId => (GESTURES as readonly string[]).includes(n);
  const declared = new Set(
    act.tracks.gesture
      .filter((b) => typeof b.at === 'object')
      .map((b) => (b.at as { anchor: string }).anchor),
  );
  for (const a of anchors) {
    if (!isGesture(a.name)) continue;
    if (declared.has(a.name)) continue;
    if (act.tracks.gesture.some((b) => b.clip === a.name)) continue;
    events.push({
      time: charToTime(a.charIndex),
      kind: 'gesture',
      clip: a.name,
      weight: 1,
      speed: 1,
    });
  }

  events.sort((x, y) => x.time - y.time);
  return { text, duration, events };
}

/** 简单的时间轴播放器：按 wall clock 推进，依次触发事件。 */
export class TimelinePlayer {
  private events: TimelineEvent[] = [];
  private cursor = 0;
  private elapsed = 0;
  private playing = false;

  start(compiled: CompiledAct) {
    this.events = compiled.events;
    this.cursor = 0;
    this.elapsed = 0;
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.events = [];
    this.cursor = 0;
  }

  get isPlaying() {
    return this.playing;
  }

  /** 每帧调用，返回本帧到期的事件。 */
  update(dt: number): TimelineEvent[] {
    if (!this.playing) return [];
    this.elapsed += dt;
    const due: TimelineEvent[] = [];
    while (this.cursor < this.events.length && this.events[this.cursor].time <= this.elapsed) {
      due.push(this.events[this.cursor++]);
    }
    if (this.cursor >= this.events.length) this.playing = false;
    return due;
  }
}
