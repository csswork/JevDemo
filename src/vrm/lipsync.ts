import type { VRM } from '@pixiv/three-vrm';
import { damp } from './pose';

/**
 * 口型层。
 *
 * 一期不做音素对齐 —— 中文要做准需要先出拼音再映射到 viseme，投入产出比不划算。
 * 这里用两个小技巧拿到"够用"的观感：
 *   1. viseme 由字符码哈希决定，因此口型和台词一一绑定、可复现，而不是随机抖动；
 *   2. 标点处强制闭口并留出停顿，这是让口型显得"在说话"而非"在嚼东西"的关键。
 *
 * 接真实 TTS 后：如果 TTS 能给 viseme/音素时间戳（Azure、ElevenLabs 都可以），
 * 把 setVisemeStream 接上即可替换掉整段启发式，其余层不用动。
 */

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
type Viseme = (typeof VISEMES)[number];

const PUNCT = /[，,、。！？!?；;：:\s—…·]/;

export class LipSyncLayer {
  private text = '';
  private duration = 0;
  private t = 0;
  private active = false;
  private weights = new Map<Viseme, number>();
  /** 0..1，情绪表情留给口型的余量，由 Character 每帧喂进来 */
  private mouthRoom = 1;
  private resolved = new Map<Viseme, string | null>();

  bind(vrm: VRM) {
    this.resolved.clear();
    const mgr = vrm.expressionManager;
    if (!mgr) return;
    const names = mgr.expressions.map((e) => e.expressionName);
    for (const v of VISEMES) {
      this.resolved.set(
        v,
        names.find((n) => n === v) ?? names.find((n) => n.toLowerCase() === v) ?? null,
      );
    }
  }

  start(text: string, duration: number) {
    this.text = text;
    this.duration = Math.max(0.2, duration);
    this.t = 0;
    this.active = true;
  }

  stop() {
    this.active = false;
  }

  setMouthRoom(room: number) {
    this.mouthRoom = Math.max(0.15, Math.min(1, room));
  }

  get isActive() {
    return this.active;
  }

  /**
   * 嘴此刻张开的程度（0..1，按口型的最大幅度归一）。
   * 表情层用它决定张嘴类嘴形让出多少：发音节时让出来，字与字之间、标点处回来。
   */
  get openness(): number {
    let max = 0;
    for (const w of this.weights.values()) max = Math.max(max, w);
    return Math.min(1, max / 0.44);
  }

  update(dt: number, vrm: VRM) {
    const mgr = vrm.expressionManager;
    if (!mgr) return;

    let targetV: Viseme | null = null;
    let targetW = 0;

    if (this.active) {
      this.t += dt;
      if (this.t >= this.duration) {
        this.active = false;
      } else {
        const chars = Math.max(1, this.text.length);
        const pos = (this.t / this.duration) * chars;
        const idx = Math.min(chars - 1, Math.floor(pos));
        const ch = this.text[idx] ?? '';

        if (PUNCT.test(ch)) {
          targetW = 0;
        } else {
          const code = ch.charCodeAt(0) || 0;
          targetV = VISEMES[code % VISEMES.length];
          // 每个字内做一次开合，字与字之间自然有闭合点
          const frac = pos - idx;
          const open = Math.sin(frac * Math.PI);
          // 幅度刻意压得很低：VRM 的 aa 给到 1 是"张到最大"，
          // 再叠上笑脸表情就成了打哈欠。人说话时嘴其实开得很小。
          targetW = (0.10 + open * 0.34) * this.mouthRoom;
        }
      }
    }

    for (const v of VISEMES) {
      const key = this.resolved.get(v);
      if (!key) continue;
      const want = v === targetV ? targetW : 0;
      const cur = damp(this.weights.get(v) ?? 0, want, 22, dt);
      this.weights.set(v, cur);
      if (cur > 0.001) mgr.setValue(key, cur);
      else mgr.setValue(key, 0);
    }
  }
}
