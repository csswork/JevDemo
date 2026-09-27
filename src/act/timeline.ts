/**
 * Act IR → 绝对时间事件流。
 *
 * 这是"表演调度"与"渲染"的分界：编译产物只有 { time, kind, payload }，
 * 不含任何 three.js 概念。换 Live2D / Unity 只需另写一个消费者。
 */

import { MOTIONS, type ActScript, type Cue, type Emotion, type GazeTarget, type MotionId, type PostureId, type TimeRef } from './schema';
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
  | { time: number; kind: 'motion'; clip: MotionId; speed: number }
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

export function compileAct(
  act: ActScript,
  opts: {
    duration?: number;
    /**
     * 字符下标 → 秒。省略就按时长线性估算。
     * 接上真实语音后由每一段的实测时长构造（makeMeasuredMapper），锚点就落在真实的时间上。
     */
    charToTime?: (charIndex: number) => number;
  } = {},
): CompiledAct {
  const { text, anchors } = parseAnchors(act.speech);
  const duration = opts.duration ?? estimateDuration(text);
  const charToTime = opts.charToTime ?? makeLinearMapper(text.length, duration);

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
  for (const b of act.tracks.motion) {
    events.push({ time: resolve(b.at), kind: 'motion', clip: b.clip, speed: b.speed ?? 1 });
  }
  for (const b of act.tracks.gaze) {
    events.push({ time: resolve(b.at), kind: 'gaze', target: b.target, hold: b.hold });
  }

  // 锚点名如果正好是一个动作 id，就自动补一条动作 —— 写 `<b:greeting>` 即可出动作，
  // 不必在 motion 数组里重复声明。名字不在动作表里的锚点是**纯时间标记**，
  // 只供 expression / gaze 的 at 引用，不产生任何动作。
  const isMotion = (n: string): n is MotionId => (MOTIONS as readonly string[]).includes(n);
  for (const a of anchors) {
    if (!isMotion(a.name)) continue;
    if (act.tracks.motion.some((b) => b.clip === a.name)) continue;
    events.push({ time: charToTime(a.charIndex), kind: 'motion', clip: a.name, speed: 1 });
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
  /** 每种事件已经触发了几个（按时间顺序）。校时（retime）靠它认出哪些已经演过了 */
  private fired = new Map<TimelineEvent['kind'], number>();

  start(compiled: CompiledAct) {
    this.events = compiled.events;
    this.cursor = 0;
    this.elapsed = 0;
    this.playing = true;
    this.fired.clear();
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
   * speech_start 不参与替换：语音已经在播。speech_end 默认也不换（时长由第一次 play 拥有），
   * 只有 retime —— 真实语音的时长比估算的更准 —— 时才换成新的。
   *
   * retime：同一份脚本、只是时间变了。已经触发过的节拍不能再返回 —— 否则每排上一段音频，
   * 过去的表情就重放一遍，每次都重新冲一次峰值（实测一句话里开头的表情被重放了 4 次，
   * 脸一抽一抽的）。同一份脚本编译出的同类事件顺序不变，所以按"每种已触发几个"认。
   * 内容升级（Jev 的判断到了）则相反：过去的状态要按新内容补齐一次。
   */
  upgrade(compiled: CompiledAct, opts: { retime?: boolean } = {}): TimelineEvent[] {
    if (!this.playing) return [];

    const speechEnd = opts.retime
      ? compiled.events.find((e) => e.kind === 'speech_end')
      : this.events.find((e) => e.kind === 'speech_end');
    const seen = new Map<TimelineEvent['kind'], number>();
    const next: TimelineEvent[] = compiled.events.filter((e) => {
      if (e.kind === 'speech_start' || e.kind === 'speech_end') return false;
      if (!opts.retime) return true;
      const n = seen.get(e.kind) ?? 0;
      seen.set(e.kind, n + 1);
      return n >= (this.fired.get(e.kind) ?? 0);
    });
    if (speechEnd) next.push(speechEnd);
    // 还没触发的 speech_start 要留着。真实语音的第一段一排上就会校时，那时第一帧都还没跑，
    // 丢掉它角色就永远进不了"说话"状态（实测整句都停在"倾听"）
    next.push(...this.events.slice(this.cursor).filter((e) => e.kind === 'speech_start'));
    next.sort((a, b) => a.time - b.time);

    this.events = next;
    const due: TimelineEvent[] = [];
    let i = 0;
    while (i < next.length && next[i].time <= this.elapsed) due.push(next[i++]);
    this.cursor = i;
    if (!opts.retime) this.fired.clear();
    this.count(due);
    return due;
  }

  private count(events: TimelineEvent[]) {
    for (const e of events) this.fired.set(e.kind, (this.fired.get(e.kind) ?? 0) + 1);
  }

  /** 每帧调用，返回本帧到期的事件。 */
  update(dt: number): TimelineEvent[] {
    return this.updateTo(this.elapsed + dt);
  }

  /**
   * 推进到指定时刻（秒）。有真实语音时时钟跟着音频走，而不是按帧累加 ——
   * 下一段音频晚到了、播放顿了一下，表情的时间点也跟着顿。
   */
  updateTo(time: number): TimelineEvent[] {
    if (!this.playing) return [];
    this.elapsed = Math.max(this.elapsed, time);
    const due: TimelineEvent[] = [];
    while (this.cursor < this.events.length && this.events[this.cursor].time <= this.elapsed) {
      due.push(this.events[this.cursor++]);
    }
    if (this.cursor >= this.events.length) this.playing = false;
    this.count(due);
    return due;
  }
}
