import type { Emotion } from './schema';

/**
 * 跨轮的心情。
 *
 * 表情层自己有一个"情绪惯性"（expressions.ts），但它只管一句话之内、十几秒的事。
 * 这里管的是几轮对话的事：夸她，她会连着开心好几轮；惹她生气，要哄一阵才好。
 *
 * 三个量，都是 0..1：
 *   joy   开心 —— 来得快，每轮自然回落四成，几轮之后就平了
 *   anger 生气 —— 来得快，**光靠时间几乎不消**（一轮只回落一成），要靠正面的轮次"哄"下来；
 *                 生着气的时候被夸，开心也只涨一点点（先消气，再开心）
 *   gloom 低落 —— 介于两者之间，被安慰（正面的轮次）也会好一些
 *
 * 输入只有 Jev 给的情绪（和表情同一份判断，这里不另外判断情绪）：
 *   倾听反应 —— 只看用户那句话，"对方说的话让她怎样"，权重 1
 *   整句判断 —— 她自己说这句话时的情绪，权重 0.4（有倾听反应时）/ 1（没有时）
 *
 * 渲染无关：Runtime 喂数据、读结果，具体怎么表现（待机脸、姿态、漫符、给输入层的提示）在别处。
 */

export interface MoodState {
  joy: number;
  anger: number;
  gloom: number;
}

type Probs = Partial<Record<Emotion, number>>;

/** 每轮自然回落多少（乘上去的系数） */
const TURN_KEEP = { joy: 0.6, anger: 0.9, gloom: 0.75 };
/** 一轮能涨多少（乘以这一轮的情绪强度，再乘剩余空间） */
const GAIN = { joy: 0.55, anger: 0.7, gloom: 0.5 };
/** 正面的轮次能把生气 / 低落哄掉多少（比例） */
const SOOTHE = { anger: 0.35, gloom: 0.3 };
/** 隔着时间的回落：半衰期（秒）。人走开一会儿再回来，气也会消一些 */
const HALF_LIFE = { joy: 240, anger: 900, gloom: 420 };

export class Mood {
  joy = 0;
  anger = 0;
  gloom = 0;
  private at = 0;

  constructor(now = 0) {
    this.at = now;
  }

  get state(): MoodState {
    return { joy: this.joy, anger: this.anger, gloom: this.gloom };
  }

  reset(now = this.at) {
    this.joy = this.anger = this.gloom = 0;
    this.at = now;
  }

  /** 按经过的时间回落（now：秒） */
  decay(now: number) {
    const dt = Math.max(0, now - this.at);
    this.at = now;
    if (dt <= 0) return;
    this.joy *= Math.pow(0.5, dt / HALF_LIFE.joy);
    this.anger *= Math.pow(0.5, dt / HALF_LIFE.anger);
    this.gloom *= Math.pow(0.5, dt / HALF_LIFE.gloom);
  }

  /**
   * 一轮里的一份情绪判断。weight：这份判断算多少（倾听反应 1，整句判断 0.4 或 1）。
   * 每轮的"自然回落"只在第一份判断时做一次（turnStart = true）
   */
  feed(probs: Probs, weight: number, turnStart: boolean) {
    const p = (e: Emotion) => Math.max(0, Math.min(1, probs[e] ?? 0)) * weight;
    // 害羞、放松算半个开心：被夸得不好意思，心情也是好的
    const pos = Math.min(1, p('happy') + 0.6 * p('relaxed') + 0.7 * p('shy'));
    const ang = p('angry');
    const sad = p('sad');

    if (turnStart) {
      this.joy *= TURN_KEEP.joy;
      this.anger *= TURN_KEEP.anger;
      this.gloom *= TURN_KEEP.gloom;
    }

    // 先哄：正面的一轮让气消一些、让低落好一些
    this.anger *= 1 - SOOTHE.anger * pos;
    this.gloom *= 1 - SOOTHE.gloom * pos;

    // 再涨。生着气时开心涨得很慢；又惹她了，开心直接被冲掉一部分
    this.joy += GAIN.joy * pos * (1 - this.joy) * (1 - 0.75 * this.anger);
    this.joy *= 1 - 0.8 * ang;
    this.anger += GAIN.anger * ang * (1 - this.anger);
    this.gloom += GAIN.gloom * sad * (1 - this.gloom);
    this.clamp();
  }

  private clamp() {
    this.joy = Math.max(0, Math.min(1, this.joy));
    this.anger = Math.max(0, Math.min(1, this.anger));
    this.gloom = Math.max(0, Math.min(1, this.gloom));
  }
}

/**
 * 心情 → 待机姿态（idle.ts 的四种）。心情不明显时返回 null（保留这一句话 Jev 选的姿态）
 */
export function moodPosture(m: MoodState): 'idle_cheerful' | 'idle_low' | 'idle_alert' | null {
  const top = Math.max(m.joy, m.anger, m.gloom);
  if (top < 0.3) return null;
  if (m.anger === top) return 'idle_alert';
  if (m.gloom === top) return 'idle_low';
  return 'idle_cheerful';
}

/** 心情 → 待机时的节奏（idle 层的 arousal）。null = 不改 */
export function moodArousal(m: MoodState): number | null {
  const top = Math.max(m.joy, m.anger, m.gloom);
  if (top < 0.3) return null;
  if (m.anger === top) return 0.45 + 0.35 * m.anger;
  if (m.gloom === top) return 0.2 - 0.15 * m.gloom;
  return 0.35 + 0.3 * m.joy;
}

/** 心情 → 不说话时脸上留着的那点情绪（表情层的 setResting），语义强度 */
export function moodFace(m: MoodState): Probs {
  const out: Probs = {};
  // 赌气要看得出来：0.45 时在 Vivi 上只是眉毛微微一压，几乎看不出
  if (m.anger > 0.15) out.angry = 0.65 * m.anger;
  if (m.joy > 0.15) {
    out.happy = 0.22 * m.joy;
    out.relaxed = 0.2 * m.joy;
  }
  if (m.gloom > 0.15) out.sad = 0.4 * m.gloom;
  return out;
}
