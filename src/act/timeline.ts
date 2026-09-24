/**
 * Act IR → 绝对时间事件流。
 *
 * 这是"表演调度"与"渲染"的分界：编译产物只有 { time, kind, payload }，
 * 不含任何 three.js 概念。换 Live2D / Unity 只需另写一个消费者。
 */

import { GESTURES, type ActScript, type Cue, type Emotion, type GazeTarget, type GestureId, type PostureId, type TimeRef } from './schema';
import { estimateDuration, makeLinearMapper, parseAnchors, type Anchor } from './anchors';

export type TimelineEvent =
  /**
   * 同一时刻的多个表情拍合并成一条，携带整个混合。
   *
   * 这是 Act IR 里"情绪是分布不是单值"的落点：Jev 的 choice 回来的是概率分布，
   * composeAct 把它摊成多个 at 相同的 beat。如果渲染层对每一拍单独调 setExclusive，
   * 后一拍会把前一拍清零，分布就退化成 top-1 —— 混合表情等于白做。
   */
  | { time: number; kind: 'expression'; mix: Array<[Emotion, number]>; fade: number }
  | { time: number; kind: 'gesture'; clip: GestureId; weight: number; speed: number }
  | { time: number; kind: 'gaze'; target: GazeTarget; hold?: number }
  | { time: number; kind: 'posture'; posture: PostureId }
  | { time: number; kind: 'cue'; cue: Cue }
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

  // 按解析后的时刻分组：同一时刻的若干拍是**一个**混合表情，不是先后覆盖
  const byTime = new Map<number, { mix: Array<[Emotion, number]>; fade: number }>();
  for (const b of act.tracks.expression) {
    const t = resolve(b.at);
    const slot = byTime.get(t) ?? { mix: [], fade: b.fade ?? 0.25 };
    slot.mix.push([b.preset, b.weight]);
    // 同组取最短的淡入时长，避免一个慢拍拖住整组
    slot.fade = Math.min(slot.fade, b.fade ?? 0.25);
    byTime.set(t, slot);
  }
  for (const [time, { mix, fade }] of byTime) {
    events.push({ time, kind: 'expression', mix, fade });
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

  events.push(...deriveCues(text, charToTime));

  events.sort((x, y) => x.time - y.time);
  return { text, duration, events };
}

/**
 * 从台词里派生对话节奏信号。只看标点和笑声词，不判断情绪。
 *   问号   → 问句最后一两个字时眼睛微微睁大（在交出话轮）
 *   叹号   → 感叹字上一闪
 *   句末   → 句界（真人倾向于在句子边界眨眼）
 *   哈哈…  → 笑声的起伏
 */
function deriveCues(text: string, charToTime: (i: number) => number): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const chars = [...text];
  chars.forEach((ch, i) => {
    if (ch === '？' || ch === '?') out.push({ time: charToTime(Math.max(0, i - 1.5)), kind: 'cue', cue: 'question' });
    else if (ch === '！' || ch === '!') out.push({ time: charToTime(Math.max(0, i - 1)), kind: 'cue', cue: 'emphasis' });
    if (/[。！？!?；;…]/.test(ch) && i < chars.length - 1 && !/[。！？!?；;…]/.test(chars[i + 1] ?? '')) {
      out.push({ time: charToTime(i + 0.5), kind: 'cue', cue: 'boundary' });
    }
  });
  const laugh = /(哈哈|呵呵|嘿嘿|嘻嘻|噗)/g;
  const joined = chars.join('');
  for (let m = laugh.exec(joined); m !== null; m = laugh.exec(joined)) {
    out.push({ time: charToTime([...joined.slice(0, m.index)].length), kind: 'cue', cue: 'laugh' });
  }
  // 同类信号挨得太近只留一个
  out.sort((a, b) => a.time - b.time);
  return out.filter(
    (e, i) =>
      !out.slice(0, i).some((p) => p.kind === 'cue' && e.kind === 'cue' && p.cue === e.cue && e.time - p.time < 0.35),
  );
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

  /**
   * 播放途中换掉表演轨道，保留已经走过的时间。
   *
   * 渐进式管线的第二段：输入层返回后角色已经在用基线表演说话了，判断层的结果
   * 晚到几百毫秒。这时不能重新开始 —— 台词和 TTS 都在走 —— 只能把**还没触发**
   * 的节拍换掉，已经过去的那些一次性补齐（返回给调用方立即应用）。
   *
   * 前提：新旧脚本的台词和时长必须一致，否则锚点解析出的时间对不上。
   * 调用方负责保证（Runtime.upgrade 里做了校验）。
   *
   * speech_start / speech_end 不参与替换：语音已经在播，它的时间由第一次 play 拥有。
   */
  upgrade(compiled: CompiledAct): TimelineEvent[] {
    if (!this.playing) return [];

    const speechEnd = this.events.find((e) => e.kind === 'speech_end');
    const next: TimelineEvent[] = compiled.events.filter(
      (e) => e.kind !== 'speech_start' && e.kind !== 'speech_end',
    );
    if (speechEnd) next.push(speechEnd);
    next.sort((a, b) => a.time - b.time);

    this.events = next;
    const due: TimelineEvent[] = [];
    let i = 0;
    while (i < next.length && next[i].time <= this.elapsed) due.push(next[i++]);
    this.cursor = i;
    return due;
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
