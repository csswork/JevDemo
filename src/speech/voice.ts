import { splitSegments, type Segment } from '../act/segments';
import { DEFAULT_TONE } from '../act/voiceStyle';

/**
 * 本地语音（Qwen3-TTS · Vivian）的一次说话。
 *
 * 一句话按段合成（和 Jev 按段判断情绪是同一套切分，act/segments.ts），每段一个语气：
 *
 *   第 1 段  台词一到就**流式**合成，攒够 0.3s 就开口（首包约 0.25s），不等整段合成完；
 *             语气用 Jev 的倾听反应（那时整句判断还没回来）
 *   第 2 段起 按需合成：尽量等 Jev 的整句判断，拿到这一段的语气再合成；
 *             等到"再不合成就接不上了"的那一刻还没回来，就先用倾听反应的语气
 *
 * 合成速度约为实时的 2 倍（M2 Max 实测 RTF 0.42~0.59），所以后面的段总能在前一段
 * 播完之前备好，一般不会有卡顿。万一晚了，时间轴的时钟是跟着音频走的，表情会一起等。
 *
 * 对外暴露三样东西给 Runtime：
 *   time     以音频为准的时钟（秒，相对播放起点）
 *   samples  每段在台词里的起止字符 ↔ 实际时间，用来校正表情锚点和口型
 *   level()  此刻的音量，口型按它开合
 */

export interface VoiceMeta {
  id: string;
  name: string;
  desc: string;
  /** 下拉框里的分组（"千问系统音色"、"预设音色"、"设计音色"） */
  group: string;
  /** 暂时不能选（比如本地的设计音色模型还在加载） */
  disabled?: boolean;
}

export interface VoiceStatus {
  ready: boolean;
  /** qwen = 远程千问；local = 本机 tts/server.py */
  backend?: 'qwen' | 'local';
  /** 服务端的默认音色（TTS_SPEAKER） */
  speaker?: string;
  /** 可选的音色。由服务端给，前端不用知道是哪个后端 */
  voices?: VoiceMeta[];
  /** 还有东西在加载（本地设计音色），前端继续探测 */
  pending?: boolean;
  error?: string | null;
  disabled?: boolean;
}

export async function probeVoice(): Promise<VoiceStatus> {
  try {
    const r = await fetch('/api/tts/health');
    return (await r.json()) as VoiceStatus;
  } catch {
    return { ready: false };
  }
}

interface Placed {
  index: number;
  /** AudioContext 时间 */
  start: number;
  duration: number;
  source: AudioBufferSourceNode;
}

/** 段与段之间的停顿：句末标点长一点，省略号更长（和 tts/bench.py 的试听版本一致） */
function pauseAfter(text: string): number {
  const end = text.trim().slice(-1);
  if (end === '…') return 0.32;
  if (/[。！？!?]/.test(end)) return 0.22;
  return 0.12;
}

/** 合成一段大概要多久：实测 RTF 约 0.5，中文约 5 字/秒，加上请求和解码的开销 */
function estimateGen(text: string): number {
  return ([...text].length / 5) * 0.55 + 0.35;
}

export class VoiceSession {
  readonly text: string;
  readonly segments: Segment[];
  /** 每段的真实时长到了（排上播放队列）时回调，Runtime 用它校正时间轴 */
  onUpdate: (() => void) | null = null;
  /** 所有段都已经排进播放队列 */
  finished = false;

  private ctx: AudioContext;
  private out: GainNode;
  private analyser: AnalyserNode;
  private buf = new Float32Array(1024);
  private tones: Array<string | null>;
  private fallback = DEFAULT_TONE;
  private judged: Promise<void>;
  private resolveJudged: () => void = () => {};
  private placed: Placed[] = [];
  /** 所有排上的音频源（第一段流式时是很多小块），stop() 时一起停 */
  private sources: AudioBufferSourceNode[] = [];
  private t0 = 0;
  private stopped = false;
  private started = false;
  // 第一段的流式状态
  private streamSr = 24000;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pending: Float32Array[] = [];
  private pendingSeconds = 0;
  private leftover: number | null = null;
  private streamDone = false;
  /** 第一段下一块该排在什么时刻（AudioContext 时间） */
  private cursor = 0;
  private firstDone = false;

  /** 预设音色；null = 用服务端的默认音色 */
  private speaker: string | null;

  constructor(ctx: AudioContext, text: string, speaker: string | null = null) {
    this.ctx = ctx;
    this.text = text;
    this.speaker = speaker;
    this.segments = splitSegments(text);
    this.tones = this.segments.map(() => null);
    this.judged = new Promise((r) => (this.resolveJudged = r));
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /** 整句判断回来之前用的语气（倾听反应） */
  setFallbackTone(tone: string) {
    this.fallback = tone;
  }

  /** Jev 的整句判断到了：每段的语气 */
  setJudgedTones(tones: string[]) {
    tones.forEach((t, i) => {
      if (i < this.tones.length) this.tones[i] = t;
    });
    this.resolveJudged();
  }

  /**
   * 流式合成第一段，攒够 0.3s 就返回（其余的在后台继续收）。
   * 失败（服务没起来、首包超时）返回 false，调用方退回无声模式。
   */
  async prepare(timeoutMs = 8000): Promise<boolean> {
    const ctrl = new AbortController();
    // 只给首包计时：整段流可能比这长，不能用 AbortSignal.timeout 把后面的也掐掉
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch('/api/tts/synth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: this.segments[0].text,
          instruct: this.tones[0] ?? this.fallback,
          speaker: this.speaker,
          stream: true,
        }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`tts ${r.status}`);
      this.streamSr = Number(r.headers.get('x-sample-rate')) || 24000;
      this.reader = r.body.getReader();
      while (this.pendingSeconds < 0.3 && !this.streamDone) await this.readChunk();
      clearTimeout(timer);
      void this.readRest();
      return this.pendingSeconds > 0 || this.streamDone;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  /** 开始播放（prepare 过之后）。第一段边收边播，后面的段在后台按需合成 */
  play() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.t0 = this.ctx.currentTime + 0.05;
    this.cursor = this.t0;
    this.flushPending();
    if (this.streamDone) this.finishFirst();
  }

  stop() {
    this.stopped = true;
    void this.reader?.cancel().catch(() => {});
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // 还没开始或已经停了
      }
    }
    this.out.disconnect();
    this.resolveJudged();
  }

  /** 以音频为准的时钟（秒，相对第一段开始播放的时刻；开播前是负的） */
  get time(): number {
    return this.ctx.currentTime - this.t0;
  }

  /**
   * 每段的起止：台词里的字符下标 ↔ 相对播放起点的秒数。
   * 只包含已经排上的段；后面的由 Runtime 按估算时长插值。
   */
  get samples(): Array<{ charIndex: number; time: number }> {
    const out: Array<{ charIndex: number; time: number }> = [];
    for (const p of this.placed) {
      const seg = this.segments[p.index];
      out.push({ charIndex: seg.start, time: p.start - this.t0 });
      // 结束点往前错开一点点：它和下一段的开始是同一个字符下标，中间隔着一段停顿。
      // 不错开的话，下一段开头的锚点会被换算成这一段的结束时刻，表情比声音早约 0.2s
      out.push({ charIndex: seg.start + [...seg.text].length - 0.01, time: p.start - this.t0 + p.duration });
    }
    return out;
  }

  /** 整句时长：全部排上后是准的；否则按已经合成的部分的语速外推 */
  estimatedDuration(): number {
    const last = this.placed[this.placed.length - 1];
    if (!last) return [...this.text].length / 5;
    const known = last.start - this.t0 + last.duration;
    if (this.finished) return known;
    const doneChars = this.placed.reduce((n, p) => n + [...this.segments[p.index].text].length, 0);
    const rate = doneChars / Math.max(0.3, this.placed.reduce((s, p) => s + p.duration, 0));
    let rest = 0;
    for (let i = last.index + 1; i < this.segments.length; i++) {
      rest += pauseAfter(this.segments[i - 1].text) + [...this.segments[i].text].length / rate;
    }
    return known + rest;
  }

  /** 此刻的音量（0..1）。口型按它开合，停顿处自然闭嘴 */
  level(): number {
    if (!this.started || this.stopped) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.min(1, Math.sqrt(sum / this.buf.length) / 0.12);
  }

  // ---- 内部 ----

  /** 收一块 PCM（16bit 小端）。网络分块不按采样对齐，奇数字节留到下一块 */
  private async readChunk() {
    const { value, done } = await this.reader!.read();
    if (done || !value) {
      this.streamDone = true;
      return;
    }
    let bytes = value;
    if (this.leftover != null) {
      const merged = new Uint8Array(bytes.length + 1);
      merged[0] = this.leftover;
      merged.set(bytes, 1);
      bytes = merged;
      this.leftover = null;
    }
    if (bytes.length % 2) {
      this.leftover = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const f32 = new Float32Array(bytes.length / 2);
    for (let i = 0; i < f32.length; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
    if (f32.length) {
      this.pending.push(f32);
      this.pendingSeconds += f32.length / this.streamSr;
    }
    if (this.started) this.flushPending();
  }

  private async readRest() {
    try {
      while (!this.streamDone && !this.stopped) await this.readChunk();
    } catch {
      // 流断了：已经收到的照播，后面的段照常
      this.streamDone = true;
    }
    if (this.started) {
      this.flushPending();
      this.finishFirst();
    }
  }

  /** 把收到的块按顺序、首尾相接地排进播放队列 */
  private flushPending() {
    for (const f32 of this.pending) {
      const buffer = this.ctx.createBuffer(1, f32.length, this.streamSr);
      buffer.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.out);
      // 网络慢于播放时（不太会发生，合成是实时的 2 倍）从"现在"接上，而不是排到过去
      const at = Math.max(this.cursor, this.ctx.currentTime + 0.01);
      source.start(at);
      this.sources.push(source);
      this.cursor = at + buffer.duration;
    }
    this.pending = [];
  }

  /** 第一段收完了：时长确定，通知校时，开始按需合成后面的段 */
  private finishFirst() {
    if (this.firstDone || this.stopped) return;
    this.firstDone = true;
    const source = this.sources[this.sources.length - 1];
    this.placed.push({ index: 0, start: this.t0, duration: this.cursor - this.t0, source });
    this.onUpdate?.();
    void this.pump();
  }

  private async pump() {
    for (let i = 1; i < this.segments.length; i++) {
      if (this.stopped) return;
      const prev = this.placed[this.placed.length - 1];
      const startAt = prev.start + prev.duration + pauseAfter(this.segments[i - 1].text);
      // 尽量等整句判断（拿到这一段自己的语气），但不能等到接不上
      if (this.tones[i] == null) {
        const deadline = startAt - estimateGen(this.segments[i].text) - 0.25;
        const wait = Math.max(0, (deadline - this.ctx.currentTime) * 1000);
        await Promise.race([this.judged, new Promise((r) => setTimeout(r, wait))]);
      }
      if (this.stopped) return;
      let buffer: AudioBuffer;
      try {
        buffer = await this.fetchSegment(i);
      } catch {
        // 中途失败：后面的不说了，时间轴按已有的收尾
        break;
      }
      if (this.stopped) return;
      this.place(i, buffer, Math.max(startAt, this.ctx.currentTime + 0.02));
    }
    this.finished = true;
    this.onUpdate?.();
  }

  private place(index: number, buffer: AudioBuffer, at: number) {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.out);
    source.start(at);
    this.sources.push(source);
    this.placed.push({ index, start: at, duration: buffer.duration, source });
    this.onUpdate?.();
  }

  private async fetchSegment(i: number, timeoutMs = 10000): Promise<AudioBuffer> {
    const seg = this.segments[i];
    const r = await fetch('/api/tts/synth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: seg.text, instruct: this.tones[i] ?? this.fallback, speaker: this.speaker }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return await this.ctx.decodeAudioData(await r.arrayBuffer());
  }
}
