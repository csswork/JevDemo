import { assetUrl } from '../assets';
/**
 * 场景背景音（环境音）。
 *
 * 素材是 CC0 的循环录音，一条场景一条（见 public/audio/ 和 public/scene/CREDITS.md）。
 *
 * 两个关键决定：
 *
 * 1. **无缝循环靠 Web Audio，不靠文件本身。** 整段解码成 AudioBuffer 之后
 *    `source.loop = true`，浏览器在**样本级**绕回开头；而 `<audio loop>` + MP3
 *    会被编码器的补零影响，接缝处每圈"咔"一下。所以素材一律用 OGG（Opus/Vorbis），不用 MP3。
 *    解码以后再把首尾交叉淡入淡出一下（seamless），录音本身接缝没处理好的也不会"咔"一下。
 * 2. **复用 Runtime 那一个 AudioContext。** 它在用户手势里创建（unlockAudio），
 *    浏览器的自动播放策略才放行；另开一个 ctx 会和语音合成的时序打架。
 *
 * 说话时压低（ducking）由 speech_start / speech_end 驱动，见 runtime.ts。
 * 文件不在或解码失败就静默跳过 —— 和 .vrma 动作素材一个处理方式，其余一切照常。
 */

/**
 * 环境音的默认音量（线性增益）。咖啡店的人声在这个音量下正好；
 * 场景可以用 Backdrop.ambienceVolume 覆盖它 —— 公园的鸟鸣是远处录的，默认音量下偏小。
 */
export const AMBIENCE_VOLUME = 0.3;

export class AmbiencePlayer {
  private readonly ctx: AudioContext;
  /** 总音量：切换场景时淡入淡出 */
  private readonly master: GainNode;
  /** 说话时压低用 */
  private readonly duck: GainNode;
  private src: AudioBufferSourceNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  /** 场景想要的背景音。可能在音频解锁之前就设好了，先记着 */
  private want: string | null = null;
  /** 这个场景要的音量。null = 用默认的 volume */
  private wantVolume: number | null = null;
  /** 正在播的那条（调试面板显示用） */
  private playing: string | null = null;
  /** 音频已解锁（拿到用户手势） */
  private unlocked = false;
  /** 每次切换自增：过期的异步加载靠它丢弃 */
  private seq = 0;
  private ducked = false;
  private disposed = false;

  /** 基础音量。环境音是垫在语音下面的，不需要大声。场景可以覆盖，见 setScene */
  volume = AMBIENCE_VOLUME;

  /** 说话时压到多少（线性）。0.3 ≈ -10dB */
  private readonly duckGain = 0.3;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.duck.connect(this.master);
    this.master.connect(ctx.destination);
  }

  get current(): string | null {
    return this.playing;
  }

  /**
   * 换个场景要的背景音；null = 这个场景安静。解锁之前只记下来。
   * volume 省略就用默认的 volume（场景不指定时）。
   */
  setScene(url: string | null, volume?: number) {
    const vol = volume ?? null;
    const urlChanged = url !== this.want;
    const volChanged = vol !== this.wantVolume;
    if (!urlChanged && !volChanged) return;
    this.want = url;
    this.wantVolume = vol;
    if (!this.unlocked) return;
    // 同一段素材只是改了音量：就地推一下增益，不用重头播一遍
    if (urlChanged) void this.switchTo(url);
    else if (this.src) this.rampTo(this.effectiveVolume(), 0.4);
  }

  /** 这个场景实际用的音量 */
  private effectiveVolume(): number {
    return this.wantVolume ?? this.volume;
  }

  /** 拿到用户手势之后调一次：真正开始出声 */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    void this.switchTo(this.want);
  }

  /** 角色开口：把背景音压下去；说完再回来 */
  setDucked(on: boolean) {
    if (on === this.ducked) return;
    this.ducked = on;
    const t = this.ctx.currentTime;
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    // 降低要快（别盖住开口那几个字），抬回来慢一点（不然像有人在拧旋钮）
    g.linearRampToValueAtTime(on ? this.duckGain : 1, t + (on ? 0.3 : 0.8));
  }

  /** 完全停下（用户关掉背景音） */
  stop() {
    this.seq++;
    this.want = null;
    this.stopSource(0.4);
    this.rampTo(0, 0.4);
  }

  dispose() {
    this.disposed = true;
    this.seq++;
    this.stopSource(0);
    this.duck.disconnect();
    this.master.disconnect();
  }

  // ---- 内部 ----

  private rampTo(v: number, seconds: number) {
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v, t + Math.max(0.01, seconds));
  }

  /** 从 0 淡到某个音量（新起一条源时用）。和 rampTo 的区别是先归零 */
  private fadeInTo(v: number, seconds: number) {
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(v, t + Math.max(0.01, seconds));
  }

  private stopSource(after: number) {
    const s = this.src;
    this.src = null;
    this.playing = null;
    if (!s) return;
    s.onended = () => s.disconnect();
    try {
      s.stop(this.ctx.currentTime + Math.max(0, after));
    } catch {
      // 已经停过了
    }
  }

  private async switchTo(url: string | null) {
    const seq = ++this.seq;
    this.stopSource(0.6);
    this.rampTo(0, 0.5);
    if (!url || this.disposed) return;

    const buf = await this.load(url);
    if (!buf || seq !== this.seq || this.disposed) return;
    this.startSource(buf, url, 1.2);
  }

  /**
   * 页面回到前台时调：确认环境音还在出声。
   *
   * 为什么不能只靠 ctx.resume()：系统休眠 / 切换音频输出设备之后，浏览器可能已经把整条
   * 音频图丢掉，而 **AudioBufferSourceNode 不能 start 第二次** —— 旧的循环源一旦被丢就是
   * 永久静音，resume 也救不回来。缓冲区还在缓存里，重起一条是毫秒级的。
   */
  resumeFromBackground() {
    if (!this.unlocked || !this.want || this.disposed) return;
    const buf = this.buffers.get(this.want);
    if (!buf) {
      // 上一次加载没成功（切场景时断网之类），此时 master 已经被拉到 0：
      // 不重试的话回来就是永久静音
      void this.switchTo(this.want);
      return;
    }
    this.stopSource(0);
    this.startSource(buf, this.want, 0.35);
  }

  private startSource(buf: AudioBuffer, url: string, fadeIn: number) {
    // 正常路径上调用方已经停过了（switchTo 是淡出后停）。这里再兜一次：
    // 万一"回到前台重起"正好撞上一次还在加载的 switchTo，不会留下两条同时在放的源
    this.stopSource(0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.duck);
    src.start();
    this.src = src;
    this.playing = url;
    // 从 0 淡入：旧的那条可能刚被停掉，直接给满音量会"啪"一下
    this.fadeInTo(this.effectiveVolume(), fadeIn);
  }

  /** 取一次、解码一次就缓存住。文件不在 / 解码失败都返回 null，静默跳过 */
  private async load(url: string): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(url);
    if (hit) return hit;
    try {
      const res = await fetch(assetUrl(url));
      // Vite 对不存在的路径会回退成 index.html（状态码还是 200），所以光看 res.ok 不够 ——
      // 和 models.ts 的 probeModels 一样看类型
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
      const buf = seamless(this.ctx, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      this.buffers.set(url, buf);
      return buf;
    } catch {
      return null;
    }
  }
}

/**
 * 把一段录音修成首尾接得上的循环：裁掉结尾 10ms（编码器在最后补出来的几个样本会突然跳一下），
 * 再把剩下的最后 0.25 秒和开头交叉淡入淡出（等功率），绕回开头那一下前后是连续的波形。
 * 作者录成无缝循环的素材也照样过一遍，听不出差别；接缝没处理好的（海边那条：结尾几乎是静音、开头一下子有声音）不会"咔"了
 */
function seamless(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const sr = buf.sampleRate;
  const trim = Math.round(sr * 0.01);
  const fade = Math.round(sr * 0.25);
  const len = buf.length - trim - fade;
  if (len < sr * 2) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, len, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, len));
    // 开头这 0.25 秒：原来的开头淡入、被裁掉的最后 0.25 秒淡出叠上去 —— 循环到结尾时接着的正是它
    for (let i = 0; i < fade; i++) {
      const t = (i / fade) * (Math.PI / 2);
      dst[i] = src[i] * Math.sin(t) + src[len + i] * Math.cos(t);
    }
  }
  return out;
}
