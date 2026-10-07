import * as THREE from 'three';
import { smoothstep } from './pose';

/**
 * 镜头和画面配合情绪（漫画 / 动画的演出手法，不是真人摄影）：
 *
 *   推镜 —— 情绪到顶时镜头轻轻推近（视角收窄几度），回落时慢慢拉回
 *   一震 —— 惊讶的那一下画面短促地抖一抖（0.35s 衰减完）
 *   偏冷 —— 难过时画面褪一点色、蒙一层冷蓝，四周压暗
 *
 * **不挪主相机**：视线层把主相机的位置当成"对话的人"站的地方，鼠标转镜也绑在它上面。
 * 这里只在渲染那一刻复制一台替身相机，收窄视角、叠上抖动，画完就扔。
 * 偏冷是盖在画布上的一层 CSS（褪色用画布的 filter），不进渲染管线，开销可以忽略。
 *
 * 信号全部来自表情层（Jev 定的情绪和强度）：这里只决定"画面怎么配合"，不判断情绪。
 */

export interface FxSignals {
  /** 各情绪当前的语义强度（0..1，已还原 ceiling） */
  levels: { happy: number; angry: number; sad: number; surprised: number; shy: number; relaxed: number };
  /** 这一帧新来的"冲过头"（换情绪 / 猛地变强），见 ExpressionLayer.takeAccents */
  accents: Array<{ emo: string; strength: number }>;
}

/** 推镜：强度从多少开始推、推满时视角收窄多少（比例） */
const PUSH_FROM = 0.62;
const PUSH_SPAN = 0.3;
const PUSH_MAX = 0.1;
/** 推进去快一点、拉回来慢 */
const PUSH_IN_TAU = 0.55;
const PUSH_OUT_TAU = 1.6;

/** 一震：最大转角（度）、衰减（每秒剩多少）、抖动频率 */
const SHAKE_DEG = 0.55;
const SHAKE_DECAY = 7;
const SHAKE_HZ = 17;

/** 偏冷：难过强度从多少开始、多少时满 */
const COLD_FROM = 0.3;
const COLD_SPAN = 0.45;
const COLD_IN_TAU = 0.9;
const COLD_OUT_TAU = 2.5;

export class CameraFx {
  enabled = true;
  private push = 0;
  private trauma = 0;
  private cold = 0;
  private t = 0;
  private readonly fxCam = new THREE.PerspectiveCamera();
  private readonly overlay: HTMLDivElement | null = null;
  private readonly canvas: HTMLCanvasElement | null = null;
  private lastCold = -1;
  private readonly reduceMotion: boolean;

  constructor(canvas?: HTMLCanvasElement) {
    this.reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!canvas) return;
    this.canvas = canvas;
    const el = document.createElement('div');
    // 冷蓝用 soft-light 叠：亮处偏蓝灰、暗处更沉，肤色不会被整片染蓝；四周再压暗一圈
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      opacity: '0',
      mixBlendMode: 'soft-light',
      background:
        'radial-gradient(ellipse 75% 70% at 50% 42%, rgba(95,125,170,0.4) 0%, rgba(45,65,110,0.75) 70%, rgba(15,25,50,0.9) 100%)',
    });
    canvas.insertAdjacentElement('afterend', el);
    this.overlay = el;
  }

  /** 当前的状态（调试面板 / 测试用） */
  get state() {
    return { push: this.push, shake: this.trauma, cold: this.cold };
  }

  update(dt: number, s: FxSignals) {
    this.t += dt;
    const on = this.enabled;
    const L = s.levels;

    // 推镜：看最强的那个"带劲"的情绪。放松不推（推镜是强调，平静的满足不需要）
    const strongest = Math.max(L.happy, L.angry, L.sad, L.surprised, L.shy);
    const pushGoal = on ? smoothstep((strongest - PUSH_FROM) / PUSH_SPAN) : 0;
    const tau = pushGoal > this.push ? PUSH_IN_TAU : PUSH_OUT_TAU;
    this.push += (pushGoal - this.push) * (1 - Math.exp(-dt / tau));

    // 一震：只认惊讶的"那一下"
    for (const a of s.accents) {
      if (a.emo === 'surprised' && a.strength >= 0.45) this.trauma = Math.max(this.trauma, Math.min(1, a.strength));
    }
    this.trauma *= Math.exp(-SHAKE_DECAY * dt);
    // 系统设了"减少动态效果"就不抖
    if (this.trauma < 1e-3 || !on || this.reduceMotion) this.trauma = 0;

    // 偏冷
    const coldGoal = on ? smoothstep((L.sad - COLD_FROM) / COLD_SPAN) : 0;
    const ct = coldGoal > this.cold ? COLD_IN_TAU : COLD_OUT_TAU;
    this.cold += (coldGoal - this.cold) * (1 - Math.exp(-dt / ct));
    this.applyGrade();
  }

  /** 每帧刷 CSS 太浪费：变化超过 0.5% 才写 */
  private applyGrade() {
    const c = this.cold < 0.003 ? 0 : this.cold;
    if (Math.abs(c - this.lastCold) < 0.005 && !(c === 0 && this.lastCold !== 0)) return;
    this.lastCold = c;
    if (this.overlay) this.overlay.style.opacity = c.toFixed(3);
    if (this.canvas) this.canvas.style.filter = c > 0 ? `saturate(${(1 - 0.3 * c).toFixed(3)}) brightness(${(1 - 0.05 * c).toFixed(3)})` : '';
  }

  /**
   * 渲染用的相机：没有推镜、没有抖动时原样返回；否则复制一台替身，收窄视角、叠上抖动
   */
  camera(base: THREE.Camera): THREE.Camera {
    if (!(base instanceof THREE.PerspectiveCamera)) return base;
    if (this.push < 1e-3 && this.trauma < 1e-3) return base;
    const cam = this.fxCam;
    cam.copy(base);
    cam.fov = base.fov * (1 - PUSH_MAX * this.push);
    if (this.trauma > 1e-3) {
      // 几组不成倍数的正弦叠在一起当噪声：不重复、也不需要随机数
      const k = THREE.MathUtils.degToRad(SHAKE_DEG) * this.trauma * this.trauma;
      const w = this.t * SHAKE_HZ * Math.PI * 2;
      cam.rotateY(k * (Math.sin(w) * 0.6 + Math.sin(w * 1.73 + 1.1) * 0.4));
      cam.rotateX(k * (Math.sin(w * 1.31 + 2.3) * 0.6 + Math.sin(w * 2.11 + 0.4) * 0.4));
      cam.rotateZ(k * 0.5 * Math.sin(w * 0.87 + 4.2));
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }

  reset() {
    this.push = 0;
    this.trauma = 0;
    this.cold = 0;
    this.applyGrade();
  }

  dispose() {
    this.overlay?.remove();
    if (this.canvas) this.canvas.style.filter = '';
  }
}
