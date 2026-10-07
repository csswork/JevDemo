import * as THREE from 'three';
import { VRMExpressionMorphTargetBind, type VRM } from '@pixiv/three-vrm';
import type { Emotion } from '../act/schema';
import { damp } from './pose';

/**
 * 漫符层 —— 二次元观众读情绪靠的那套固定符号，挂在角色身上。
 *
 * 半身景别下，"明显但克制"的表情（Jev 对日常聊天的判断大多在这一档）靠肌肉的细微变化很难一眼看出来；
 * 漫画 / 动画的做法是加符号：脸红、阴影竖线、眼泪、头上冒青筋、飘音符、一个感叹号、一滴汗。
 * 这些符号的意思是固定的，不用看清脸也读得出来。
 *
 *   贴在脸上（跟着头走，被头发挡住时照样被挡）：
 *     脸红      害羞（Jev 的 shy；开心 + 惊讶的混合也会淡淡地红一点）、很强的开心、气得很厉害
 *     阴影竖线  很强的难过：额头到眼睛那一片罩一层往下淡的竖线
 *     眼泪      很强的难过：从下眼角沿着脸颊往下滑
 *   挂在头边（永远画在最上面，不被头发挡）：
 *     💢        生气，一跳一跳
 *     ♪         开心（放松时少一些），一个个往上飘
 *     ！        惊讶的那一下，弹出来就收
 *     汗滴      慌（惊讶 + 难过 / 生气）、苦笑（难过 + 放松），滑一下停住
 *     ？        困惑，蹦出来之后挂着轻轻晃
 *     ✦        得意（ドヤ），头边一闪一闪的四角星（试过鼻息：在 3D 脸上停在嘴角，像沾了牛奶）
 *   贴在脸上：
 *     发青竖线  嫌弃（ドン引き），两眼之间、刘海里面，几道很细的线
 *
 * **情绪是什么、多强全部来自 Jev**：这里只读表情层此刻的语义情绪（weightOf，已经带着峰值回落、
 * 余韵和心情惯性），按阈值换算成符号，不多问 Jev 一个问题。
 *
 * 位置按模型现量：载入时（静止姿势）从脸前面往脸上打射线，找到脸颊、下眼角、额头前面、头顶、
 * 头发两侧，记在头骨的局部坐标里，之后整个挂在头骨上跟着动。所以换模型不用标定。
 * 图案都是 canvas 现画的，每个模型上风格一致。
 */

type Feeling = Exclude<Emotion, 'neutral'>;
export type Levels = Record<Feeling, number>;

/** 一次性的符号，预览 / 调试用：__jev.character.manpu.trigger('exclaim') */
export type ManpuKind = 'exclaim' | 'sweat' | 'note' | 'tear' | 'question' | 'sparkle';

const smooth = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(x, a, b);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** 回弹（easeOutBack）：先冲过头一点再回来，漫画里符号"蹦"出来的样子 */
const backOut = (u: number) => {
  const x = clamp01(u) - 1;
  return 1 + 2.7 * x * x * x + 1.7 * x * x;
};

// ---------------------------------------------------------------------------
// 图案（canvas 现画）
// ---------------------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 💢：四段朝中心鼓的弧，深色描边 + 红色 */
const drawVein = (g: CanvasRenderingContext2D) => {
  const c = 128;
  const R = 50;
  const arcs = () => {
    g.beginPath();
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const cx = c + sx * R;
      const cy = c + sy * R;
      // 对着中心的那四分之一圆
      const mid = Math.atan2(-sy, -sx);
      // 弧短一点（±32°），四段之间留出十字形的缺口
      const r = R * 0.72;
      g.moveTo(cx + Math.cos(mid - 0.56) * r, cy + Math.sin(mid - 0.56) * r);
      g.arc(cx, cy, r, mid - 0.56, mid + 0.56);
    }
  };
  g.lineCap = 'round';
  arcs();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 28;
  g.stroke();
  arcs();
  g.strokeStyle = '#7a0c1c';
  g.lineWidth = 19;
  g.stroke();
  arcs();
  g.strokeStyle = '#ef2f45';
  g.lineWidth = 10;
  g.stroke();
};

/** ♪ / ♫ */
const drawNote = (color: string, double: boolean) => (g: CanvasRenderingContext2D) => {
  const shape = () => {
    g.beginPath();
    const heads = double ? [70, 170] : [100];
    for (const x of heads) {
      g.ellipse(x, 196, 34, 24, -0.35, 0, Math.PI * 2);
      g.rect(x + 22, 60, 12, 136);
    }
    if (double) {
      // 横梁
      g.moveTo(92, 52);
      g.lineTo(204, 30);
      g.lineTo(204, 64);
      g.lineTo(92, 86);
      g.closePath();
    } else {
      // 旗
      g.moveTo(122, 60);
      g.bezierCurveTo(170, 80, 196, 110, 170, 160);
      g.bezierCurveTo(176, 120, 156, 104, 122, 98);
      g.closePath();
    }
  };
  g.lineJoin = 'round';
  shape();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 18;
  g.stroke();
  shape();
  g.fillStyle = color;
  g.fill();
};

/** ！加三道放射线 */
const drawExclaim = (g: CanvasRenderingContext2D) => {
  const bang = () => {
    g.beginPath();
    g.moveTo(104, 34);
    g.lineTo(152, 34);
    g.lineTo(138, 164);
    g.lineTo(118, 164);
    g.closePath();
    g.moveTo(148, 206);
    g.arc(128, 206, 20, 0, Math.PI * 2);
  };
  g.lineJoin = 'round';
  bang();
  g.strokeStyle = '#3a2410';
  g.lineWidth = 22;
  g.stroke();
  bang();
  g.fillStyle = '#ffd23a';
  g.fill();
  g.lineCap = 'round';
  for (const [x1, y1, x2, y2] of [
    [60, 70, 36, 50],
    [196, 70, 220, 50],
    [56, 128, 26, 128],
    [200, 128, 230, 128],
  ]) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.strokeStyle = '#3a2410';
    g.lineWidth = 14;
    g.stroke();
    g.strokeStyle = '#ffd23a';
    g.lineWidth = 6;
    g.stroke();
  }
};

/** 水滴（尖朝上）。汗滴大、描边深；泪滴小、更透 */
const drawDrop = (tear: boolean) => (g: CanvasRenderingContext2D) => {
  const drop = () => {
    g.beginPath();
    g.moveTo(128, 20);
    g.bezierCurveTo(150, 80, 200, 120, 200, 168);
    g.arc(128, 168, 72, 0, Math.PI);
    g.bezierCurveTo(56, 120, 106, 80, 128, 20);
    g.closePath();
  };
  drop();
  const grad = g.createLinearGradient(0, 20, 0, 240);
  grad.addColorStop(0, tear ? 'rgba(215,240,255,0.75)' : '#dff3ff');
  grad.addColorStop(1, tear ? 'rgba(120,195,245,0.9)' : '#62b6f2');
  g.fillStyle = grad;
  g.fill();
  drop();
  g.strokeStyle = tear ? 'rgba(60,130,200,0.9)' : '#24639e';
  g.lineWidth = tear ? 10 : 14;
  g.stroke();
  g.beginPath();
  g.ellipse(150, 170, 16, 28, -0.4, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fill();
};

/** 脸红：粉色的椭圆晕 + 几道斜线 */
const drawBlush = (g: CanvasRenderingContext2D) => {
  const grad = g.createRadialGradient(128, 64, 4, 128, 64, 120);
  grad.addColorStop(0, 'rgba(255,92,128,0.62)');
  grad.addColorStop(0.55, 'rgba(255,110,140,0.38)');
  grad.addColorStop(1, 'rgba(255,120,150,0)');
  g.save();
  g.scale(1, 0.5);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.restore();
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(214,40,80,0.75)';
  g.lineWidth = 7;
  for (const x of [78, 112, 146, 180]) {
    g.beginPath();
    g.moveTo(x - 14, 86);
    g.lineTo(x + 14, 40);
    g.stroke();
  }
};

/**
 * 阴影竖线：上浓下淡，四边都是软的（贴在刘海前面，硬边会像一块色板）。
 * rgb 是色调：难过偏紫（默认），嫌弃偏青
 */
const drawLines = (rgb: [number, number, number], line: [number, number, number]) => (g: CanvasRenderingContext2D) => {
  const c = (v: [number, number, number], a: number) => `rgba(${v[0]},${v[1]},${v[2]},${a})`;
  const tint = g.createLinearGradient(0, 0, 0, 256);
  tint.addColorStop(0, c(rgb, 0));
  tint.addColorStop(0.18, c(rgb, 0.3));
  tint.addColorStop(1, c(rgb, 0));
  g.fillStyle = tint;
  g.fillRect(0, 0, 256, 256);
  const n = 9;
  for (let i = 0; i < n; i++) {
    const x = 34 + (i * (256 - 68)) / (n - 1);
    const y0 = 10 + ((i * 37) % 30);
    const len = 120 + ((i * 53) % 80);
    const stroke = g.createLinearGradient(0, y0, 0, y0 + len);
    stroke.addColorStop(0, c(line, 0));
    stroke.addColorStop(0.15, c(line, 0.85));
    stroke.addColorStop(1, c(line, 0));
    g.strokeStyle = stroke;
    g.lineWidth = i % 2 ? 3 : 4.5;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x, y0 + len);
    g.stroke();
  }
  // 两侧淡出
  g.globalCompositeOperation = 'destination-in';
  const side = g.createLinearGradient(0, 0, 256, 0);
  side.addColorStop(0, 'rgba(0,0,0,0)');
  side.addColorStop(0.2, 'rgba(0,0,0,1)');
  side.addColorStop(0.8, 'rgba(0,0,0,1)');
  side.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = side;
  g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'source-over';
};
const drawGloom = drawLines([58, 40, 120], [40, 24, 96]);
/**
 * 嫌弃（ドン引き）的发青细竖线：一排很细、很密的线，上浓下淡，没有底色（底色一铺就像脸脏了）。
 * 只画在两眼之间、鼻梁上面那一小片，刘海挡住的部分就挡住
 */
const drawShade = (g: CanvasRenderingContext2D) => {
  const n = 21;
  for (let i = 0; i < n; i++) {
    const x = 30 + (i * (256 - 60)) / (n - 1);
    // 中间的长、两边的短
    const mid = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    const y0 = 6 + ((i * 29) % 22);
    const len = 110 + 120 * mid + ((i * 41) % 30);
    const stroke = g.createLinearGradient(0, y0, 0, y0 + len);
    stroke.addColorStop(0, 'rgba(40,70,160,0)');
    stroke.addColorStop(0.1, 'rgba(40,70,160,1)');
    stroke.addColorStop(0.7, 'rgba(40,70,160,0.6)');
    stroke.addColorStop(1, 'rgba(40,70,160,0)');
    g.strokeStyle = stroke;
    g.lineWidth = i % 2 ? 3 : 4;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x, y0 + len);
    g.stroke();
  }
};

/** ？：蓝色、白描边，略带一点倾斜 */
const drawQuestion = (g: CanvasRenderingContext2D) => {
  const mark = () => {
    g.beginPath();
    g.moveTo(78, 86);
    g.bezierCurveTo(78, 36, 178, 26, 182, 84);
    g.bezierCurveTo(184, 122, 138, 128, 136, 164);
    g.moveTo(152, 208);
    g.arc(136, 208, 16, 0, Math.PI * 2);
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  mark();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 50;
  g.stroke();
  mark();
  g.strokeStyle = '#1f3f8f';
  g.lineWidth = 34;
  g.stroke();
  mark();
  g.strokeStyle = '#5b8cff';
  g.lineWidth = 20;
  g.stroke();
  // 点要实心
  g.beginPath();
  g.arc(136, 208, 14, 0, Math.PI * 2);
  g.fillStyle = '#5b8cff';
  g.fill();
};

/** ✦：四角星，金色、白描边，中间亮 */
const drawSparkle = (g: CanvasRenderingContext2D) => {
  const star = () => {
    g.beginPath();
    g.moveTo(128, 14);
    g.quadraticCurveTo(140, 116, 242, 128);
    g.quadraticCurveTo(140, 140, 128, 242);
    g.quadraticCurveTo(116, 140, 14, 128);
    g.quadraticCurveTo(116, 116, 128, 14);
    g.closePath();
  };
  g.lineJoin = 'round';
  star();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 18;
  g.stroke();
  star();
  const grad = g.createRadialGradient(128, 128, 4, 128, 128, 110);
  grad.addColorStop(0, '#fffbe0');
  grad.addColorStop(0.35, '#ffd84a');
  grad.addColorStop(1, '#f0a400');
  g.fillStyle = grad;
  g.fill();
};

// ---------------------------------------------------------------------------

interface Anchors {
  /** 头骨的世界缩放：头骨下的子节点用局部单位，尺寸要除掉它 */
  scale: number;
  /** 所有尺寸的单位（米）：脸半宽的 0.49 倍 */
  unit: number;
  vein: THREE.Vector3;
  exclaim: THREE.Vector3;
  sweat: THREE.Vector3;
  noteFrom: THREE.Vector3;
  question: THREE.Vector3;
  /** 得意的闪光在哪一片闪：头的画面右侧、眼睛高度往上 */
  sparkle: THREE.Vector3;
  /** 局部坐标里的"上""角色左侧" */
  up: THREE.Vector3;
  left: THREE.Vector3;
}

interface Floating {
  obj: THREE.Sprite;
  age: number;
  life: number;
  from: THREE.Vector3;
  drift: THREE.Vector3;
  size: number;
  sway: number;
}

interface Tear {
  obj: THREE.Mesh;
  age: number;
  life: number;
  path: THREE.Vector3[];
}

export class ManpuLayer {
  /** 调试开关：__jev.character.manpu.enabled = false 对比 */
  enabled = true;

  private root = new THREE.Group();
  private a: Anchors | null = null;
  private textures: THREE.Texture[] = [];

  private blush: THREE.Mesh[] = [];
  private gloom: THREE.Mesh | null = null;
  private vein: THREE.Sprite | null = null;
  private exclaim: THREE.Sprite | null = null;
  private sweat: THREE.Sprite | null = null;
  private question: THREE.Sprite | null = null;
  /** 嫌弃的发青竖线（和阴影竖线同一个位置、换一张图） */
  private shade: THREE.Mesh | null = null;
  private sparklePool: THREE.Sprite[] = [];
  private notePool: THREE.Sprite[] = [];
  private noteTextures: THREE.Texture[] = [];
  private tearPool: THREE.Mesh[] = [];
  /** 两侧的泪痕路径（头骨局部坐标）：下眼角 → 脸颊 */
  private tearPaths: THREE.Vector3[][] = [];

  private t = 0;
  private blushW = 0;
  private gloomW = 0;
  private veinW = 0;
  private veinPop = 1;
  private shadeW = 0;
  private questionW = 0;
  private questionPop = 1;
  private sparkles: Floating[] = [];
  private nextSparkle = 0;
  private notes: Floating[] = [];
  private tears: Tear[] = [];
  private nextNote = 0;
  private nextTear = 0;
  private tearSide = 0;
  private exclaimAge = Infinity;
  private exclaimArmed = true;
  private sweatAge = Infinity;
  private sweatHold = false;
  private sweatArmed = true;
  /** 跨轮心情（act/mood.ts）：不说话时也留着符号，说话时符号更勤 */
  private mood = { joy: 0, anger: 0, gloom: 0 };
  private nextIdleNote = 6;

  /** 跨轮心情。开心 → 隔一阵冒个 ♪、说话时音符更密；生气 → 💢 一直挂着直到哄好；低落 → 阴影竖线 */
  setMood(m: { joy: number; anger: number; gloom: number }) {
    this.mood = { ...m };
  }

  bind(vrm: VRM) {
    this.dispose();
    const H = vrm.humanoid;
    const head = H.getRawBoneNode('head');
    if (!head) return;
    const a = this.build(vrm, head);
    if (!a) return;
    this.a = a;
    this.vein!.position.copy(a.vein);
    // 漫符挂在头骨下面，别的层往模型上打射线（掩嘴笑找嘴、穿模检测）时会递归扫到它们：
    // Sprite 没给相机会直接抛错，脸上的贴片也会被当成脸表面。一律不参与射线检测
    this.root.traverse((o) => {
      o.raycast = () => {};
    });
    head.add(this.root);
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.root.clear();
    for (const t of this.textures) t.dispose();
    this.textures = [];
    this.blush = [];
    this.gloom = this.vein = this.exclaim = this.sweat = this.question = this.shade = null;
    this.notePool = [];
    this.sparklePool = [];
    this.sparkles = [];
    this.noteTextures = [];
    this.tearPool = [];
    this.tearPaths = [];
    this.notes = [];
    this.tears = [];
    this.a = null;
  }

  /** 立刻清掉所有符号（截图 / 预览用，和 ExpressionLayer.reset 配套） */
  reset() {
    this.blushW = this.gloomW = this.veinW = this.shadeW = this.questionW = 0;
    this.nextSparkle = 0;
    for (const p of this.sparkles) p.obj.visible = false;
    this.sparkles = [];
    if (this.question) this.question.visible = false;
    this.exclaimAge = this.sweatAge = Infinity;
    this.exclaimArmed = this.sweatArmed = true;
    this.nextNote = this.nextTear = 0;
    for (const n of this.notes) n.obj.visible = false;
    for (const t of this.tears) t.obj.visible = false;
    this.notes = [];
    this.tears = [];
  }

  /** 预览 / 调试：手动放一个一次性的符号 */
  trigger(kind: ManpuKind) {
    if (kind === 'exclaim') this.exclaimAge = 0;
    else if (kind === 'sweat') {
      this.sweatAge = 0;
      this.sweatHold = false;
    } else if (kind === 'note') this.spawnNote(1);
    else if (kind === 'tear') this.spawnTear(1);
    else if (kind === 'sparkle') this.spawnSparkles(1);
    else if (kind === 'question') {
      this.questionPop = 0;
      this.questionW = 1;
    }
  }

  /** 每帧：levels 是 Jev 给的情绪此刻的语义强度（0..1） */
  update(dt: number, levels: Levels) {
    const a = this.a;
    if (!a) return;
    this.t += dt;
    const on = this.enabled ? 1 : 0;
    const { happy, angry, sad, relaxed, surprised, shy, smug, confused, disgusted } = levels;
    const negative = sad + angry + disgusted;

    // ---- 持续的：脸红、阴影竖线、青筋 ----
    // 害羞一上来就红（脸红是害羞最主要的信号，阈值放低）；惊喜的混合、很强的开心淡淡地红一点
    const flush = Math.max(
      smooth(shy, 0.08, 0.35),
      0.6 * smooth(Math.min(happy, surprised), 0.1, 0.32),
      0.55 * smooth(happy, 0.6, 0.9),
    );
    // 负面情绪压掉脸红；但气得很厉害时脸是气红的（单独算，不被压）
    const angerFlush = 0.6 * smooth(angry, 0.5, 0.85);
    this.blushW = damp(this.blushW, on * Math.max(flush * (1 - smooth(negative, 0.3, 0.6)), angerFlush), 3, dt);
    const M = this.mood;
    this.gloomW = damp(this.gloomW, on * Math.max(smooth(sad, 0.45, 0.8), 0.55 * smooth(M.gloom, 0.3, 0.8)), 2, dt);
    const veinGoal = on * Math.max(smooth(angry, 0.3, 0.65), 0.75 * smooth(M.anger, 0.35, 0.8));
    if (veinGoal > 0.05 && this.veinW < 0.05) this.veinPop = 0;
    this.veinW = damp(this.veinW, veinGoal, 6, dt);
    this.veinPop += dt;

    // 嫌弃：发青竖线
    this.shadeW = damp(this.shadeW, on * smooth(disgusted, 0.3, 0.65), 3, dt);
    if (this.shade) {
      (this.shade.material as THREE.MeshBasicMaterial).opacity = this.shadeW;
      this.shade.visible = this.shadeW > 0.01;
    }

    for (const m of this.blush) {
      (m.material as THREE.MeshBasicMaterial).opacity = this.blushW;
      m.visible = this.blushW > 0.01;
    }
    if (this.gloom) {
      (this.gloom.material as THREE.MeshBasicMaterial).opacity = this.gloomW;
      this.gloom.visible = this.gloomW > 0.01;
    }
    if (this.vein) {
      // 一跳一跳：快收慢放的心跳节奏
      const beat = Math.pow(Math.max(0, Math.sin(this.t * Math.PI * 2 * 1.4)), 6);
      const s = a.unit * 2.3 * backOut(this.veinPop / 0.35) * (1 + 0.16 * beat) / a.scale;
      this.vein.scale.set(s, s, 1);
      this.vein.material.opacity = this.veinW;
      this.vein.visible = this.veinW > 0.01;
    }

    // ---- 惊讶的那一下：！----
    if (surprised > 0.4 && this.exclaimArmed && on) {
      this.exclaimAge = 0;
      this.exclaimArmed = false;
    }
    if (surprised < 0.2) this.exclaimArmed = true;
    this.updateExclaim(dt, a);

    // ---- 汗滴：慌（惊讶 + 负面）、苦笑（难过 + 放松） ----
    const flustered = Math.min(surprised, negative) > 0.22 || Math.min(sad, relaxed) > 0.2;
    if (flustered && this.sweatArmed && on) {
      this.sweatAge = 0;
      this.sweatArmed = false;
    }
    this.sweatHold = flustered && !!on;
    if (!flustered) this.sweatArmed = true;
    this.updateSweat(dt, a);

    // ---- 音符：开心（放松时少一些）----
    const joy = on * Math.max(smooth(happy, 0.42, 0.85), 0.5 * smooth(relaxed, 0.55, 0.9)) * (1 - smooth(negative, 0.2, 0.5));
    // 间隔按此刻的强度算：刚过阈值时放出的第一个音符间隔很长，强度上来之后要能马上跟上
    const noteGap = THREE.MathUtils.lerp(2.4, 0.8, joy) * (1 - 0.35 * M.joy);
    this.nextNote = Math.min(this.nextNote - dt, noteGap);
    if (joy > 0.05 && this.nextNote <= 0) {
      this.spawnNote(joy);
      this.nextNote = noteGap * (0.8 + 0.4 * Math.random());
    }
    // 心情好的时候，闲着也隔一阵冒一个
    const glad = on * smooth(M.joy, 0.3, 0.85) * (1 - smooth(M.anger + M.gloom, 0.2, 0.5));
    this.nextIdleNote -= dt;
    if (glad > 0.05 && joy < 0.05 && this.nextIdleNote <= 0) {
      this.spawnNote(0.4 + 0.4 * glad);
      this.nextIdleNote = THREE.MathUtils.lerp(10, 4, glad) * (0.8 + 0.4 * Math.random());
    }
    this.updateNotes(dt, a);

    // ---- 得意：头边闪一下，隔一两秒一次 ----
    const doya = on * smooth(smug, 0.3, 0.7);
    this.nextSparkle -= dt;
    if (doya > 0.05 && this.nextSparkle <= 0) {
      this.spawnSparkles(doya);
      this.nextSparkle = THREE.MathUtils.lerp(2.2, 1.1, doya) * (0.85 + 0.3 * Math.random());
    }
    this.updateSparkles(dt, a);

    // ---- 困惑：？ ----
    const q = on * smooth(confused, 0.3, 0.6);
    if (q > 0.05 && this.questionW < 0.05) this.questionPop = 0;
    this.questionW = damp(this.questionW, q, 6, dt);
    this.updateQuestion(dt, a);

    // ---- 眼泪：很强的难过 ----
    const cry = on * smooth(sad, 0.55, 0.85);
    const tearGap = THREE.MathUtils.lerp(3, 1.1, cry);
    this.nextTear = Math.min(this.nextTear - dt, tearGap);
    if (cry > 0.05 && this.nextTear <= 0) {
      this.spawnTear(cry);
      this.nextTear = tearGap * (0.8 + 0.4 * Math.random());
    }
    this.updateTears(dt);
  }

  // ---- 一次性符号 ----

  private updateQuestion(dt: number, a: Anchors) {
    const q = this.question;
    if (!q) return;
    this.questionPop += dt;
    q.visible = this.questionW > 0.01;
    if (!q.visible) return;
    const s = (a.unit * 1.8 * backOut(this.questionPop / 0.3)) / a.scale;
    q.scale.set(s * 0.85, s, 1);
    // 挂着的时候左右轻轻晃，像在歪头想
    q.material.rotation = -0.18 + Math.sin(this.t * 2.2) * 0.12;
    const bob = Math.sin(this.t * 1.7) * a.unit * 0.06;
    q.position.copy(a.question).addScaledVector(a.up, bob / a.scale);
    q.material.opacity = Math.min(1, this.questionW * 1.4);
  }

  /** 一大一小两颗，前后差一点点亮起来 */
  private spawnSparkles(strength: number) {
    const a = this.a;
    if (!a) return;
    const spots: Array<[number, number, number, number]> = [
      // [往外, 往上, 大小, 晚多久]
      [0, 0, 1, 0],
      [0.55 + 0.3 * Math.random(), -0.7 - 0.3 * Math.random(), 0.6, 0.12],
    ];
    for (const [dx, dy, k, delay] of spots) {
      const obj = this.sparklePool.find((p) => !p.visible);
      if (!obj) return;
      obj.visible = true;
      obj.material.opacity = 0;
      const from = a.sparkle
        .clone()
        .addScaledVector(a.left, (dx * a.unit) / a.scale)
        .addScaledVector(a.up, (dy * a.unit) / a.scale);
      this.sparkles.push({
        obj,
        age: -delay,
        life: 0.7,
        from,
        drift: new THREE.Vector3(),
        size: a.unit * (1.2 + 0.5 * strength) * k,
        sway: Math.random() * Math.PI,
      });
    }
  }

  private updateSparkles(dt: number, a: Anchors) {
    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      const p = this.sparkles[i];
      p.age += dt;
      if (p.age < 0) continue;
      const u = p.age / p.life;
      if (u >= 1) {
        p.obj.visible = false;
        this.sparkles.splice(i, 1);
        continue;
      }
      // 一下子亮到最大（带回弹），再缩回去；转小半圈
      const grow = u < 0.35 ? backOut(u / 0.35) : 1 - smooth(u, 0.35, 1);
      const s = (p.size * Math.max(0, grow)) / a.scale;
      p.obj.position.copy(p.from);
      p.obj.scale.set(s, s, 1);
      p.obj.material.rotation = p.sway + u * 0.8;
      p.obj.material.opacity = Math.min(1, u / 0.08);
    }
  }

  private updateExclaim(dt: number, a: Anchors) {
    const e = this.exclaim;
    if (!e) return;
    this.exclaimAge += dt;
    const life = 1.15;
    const u = this.exclaimAge;
    if (u >= life) {
      e.visible = false;
      return;
    }
    e.visible = true;
    const s = (a.unit * 1.9 * backOut(u / 0.22)) / a.scale;
    e.scale.set(s * 0.9, s, 1);
    // 往上一跳
    const hop = Math.sin(Math.min(1, u / 0.3) * Math.PI) * a.unit * 0.25;
    e.position.copy(a.exclaim).addScaledVector(a.up, hop / a.scale);
    e.material.opacity = 1 - smooth(u, life - 0.3, life);
  }

  private updateSweat(dt: number, a: Anchors) {
    const s = this.sweat;
    if (!s) return;
    this.sweatAge += dt;
    const u = this.sweatAge;
    // 冒出来、往下滑一点停住；条件还在就一直挂着（最多 4 秒），之后淡掉
    const hold = this.sweatHold && u < 4 ? Infinity : 0;
    const fadeStart = Math.max(1.3, Math.min(u, hold));
    const alpha = u < 1.3 ? 1 : 1 - smooth(u, fadeStart, fadeStart + 0.6);
    if (u === Infinity || alpha <= 0.001) {
      s.visible = false;
      return;
    }
    s.visible = true;
    const size = (a.unit * 1.6 * backOut(u / 0.25)) / a.scale;
    s.scale.set(size * 0.78, size, 1);
    const slide = smooth(u, 0.25, 1.2) * a.unit * 0.35;
    s.position.copy(a.sweat).addScaledVector(a.up, -slide / a.scale);
    s.material.opacity = alpha;
  }

  private spawnNote(strength: number) {
    const a = this.a;
    if (!a) return;
    const obj = this.notePool.find((n) => !n.visible);
    if (!obj) return;
    obj.visible = true;
    obj.material.map = this.noteTextures[Math.floor(Math.random() * this.noteTextures.length)];
    const from = a.noteFrom.clone().addScaledVector(a.up, ((Math.random() - 0.5) * a.unit * 0.8) / a.scale);
    const drift = a.up
      .clone()
      .multiplyScalar(a.unit * 1.9)
      .addScaledVector(a.left, a.unit * (0.4 + 0.5 * Math.random()))
      .divideScalar(a.scale);
    this.notes.push({ obj, age: 0, life: 1.9, from, drift, size: a.unit * (1.3 + 0.45 * strength), sway: Math.random() * 6 });
  }

  private updateNotes(dt: number, a: Anchors) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      n.age += dt;
      const u = n.age / n.life;
      if (u >= 1) {
        n.obj.visible = false;
        this.notes.splice(i, 1);
        continue;
      }
      const rise = 1 - (1 - u) * (1 - u);
      n.obj.position.copy(n.from).addScaledVector(n.drift, rise);
      n.obj.position.addScaledVector(a.left, (Math.sin(n.sway + n.age * 5) * a.unit * 0.12) / a.scale);
      const s = (n.size * backOut(u / 0.18)) / a.scale;
      n.obj.scale.set(s, s, 1);
      n.obj.material.rotation = Math.sin(n.sway + n.age * 4) * 0.25;
      n.obj.material.opacity = smooth(u, 0, 0.08) * (1 - smooth(u, 0.6, 1));
    }
  }

  private spawnTear(strength: number) {
    if (!this.tearPaths.length) return;
    const obj = this.tearPool.find((t) => !t.visible);
    if (!obj) return;
    const path = this.tearPaths[this.tearSide++ % this.tearPaths.length];
    obj.visible = true;
    obj.userData.size = 0.75 + 0.35 * strength;
    this.tears.push({ obj, age: 0, life: 1.8, path });
  }

  private updateTears(dt: number) {
    for (let i = this.tears.length - 1; i >= 0; i--) {
      const t = this.tears[i];
      t.age += dt;
      const u = t.age / t.life;
      if (u >= 1) {
        t.obj.visible = false;
        this.tears.splice(i, 1);
        continue;
      }
      // 先在眼角鼓出来（0.35），再加速滑下去
      const k = u < 0.35 ? 0 : Math.pow((u - 0.35) / 0.65, 1.6);
      const f = k * (t.path.length - 1);
      const j = Math.min(t.path.length - 2, Math.floor(f));
      t.obj.position.lerpVectors(t.path[j], t.path[j + 1], f - j);
      const grow = smooth(u, 0, 0.3);
      const s = (t.obj.userData.size as number) * grow;
      t.obj.scale.set(s * 0.8, s * (1 + 0.25 * k), 1);
      (t.obj.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - smooth(u, 0.75, 1));
    }
  }

  // ---- 载入时：量位置、搭网格 ----

  /** 在静止姿势下量出脸和头的位置（世界坐标），搭好所有符号，挂到头骨的局部坐标里 */
  private build(vrm: VRM, head: THREE.Object3D): Anchors | null {
    const H = vrm.humanoid;
    vrm.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    vrm.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) meshes.push(m);
    });
    // 蒙皮网格的射线检测读的是骨骼矩阵，还没渲染过一帧时得先算一次
    for (const m of meshes) (m as THREE.SkinnedMesh).skeleton?.update();

    // 脸：情绪表情绑定的那个网格（没有就退回全部网格）
    const face = new Set<THREE.Mesh>();
    const mgr = vrm.expressionManager;
    for (const name of ['happy', 'blink', 'aa']) {
      for (const b of mgr?.getExpression(name)?.binds ?? []) {
        if (b instanceof VRMExpressionMorphTargetBind) for (const m of b.primitives) face.add(m);
      }
      if (face.size) break;
    }
    const faceMeshes = face.size ? [...face] : meshes;

    // ---- 坐标系：角色左侧、上、前 ----
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const up = new THREE.Vector3(0, 1, 0);
    const le = H.getRawBoneNode('leftEye')?.getWorldPosition(new THREE.Vector3());
    const re = H.getRawBoneNode('rightEye')?.getWorldPosition(new THREE.Vector3());
    const left = new THREE.Vector3();
    if (le && re) left.subVectors(le, re);
    else {
      // 没有眼骨就用两肩
      const ls = H.getRawBoneNode('leftUpperArm')?.getWorldPosition(new THREE.Vector3());
      const rs = H.getRawBoneNode('rightUpperArm')?.getWorldPosition(new THREE.Vector3());
      if (!ls || !rs) return null;
      left.subVectors(ls, rs);
    }
    left.y = 0;
    left.normalize();
    const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
    const back = fwd.clone().negate();
    const eyes = le && re ? le.clone().add(re).multiplyScalar(0.5) : headPos.clone().addScaledVector(up, 0.065);
    const depth = (v: THREE.Vector3) => v.dot(fwd);

    const ray = new THREE.Raycaster();
    const cast = (targets: THREE.Mesh[], origin: THREE.Vector3, dir: THREE.Vector3) => {
      ray.set(origin, dir);
      ray.far = 1;
      return ray.intersectObjects(targets, false)[0]?.point ?? null;
    };

    // 尺度：脸部网格在眼睛高度的半宽（从两侧往里打）。眼骨靠不住 —— VRoid 的眼骨靠近鼻梁
    // （诗乃眼骨间距 4.1cm，脸半宽 8.5cm），MMD 转的模型眼骨在眼睛正中（梅娜贝尔 7.2cm / 7.5cm）。
    // 但看得见的眼睛中心在两种模型上都落在脸半宽的 0.48~0.51 处
    const faceSide = (s: number) => {
      const hit = cast(faceMeshes, eyes.clone().addScaledVector(left, s * 0.4), left.clone().multiplyScalar(-s));
      return hit ? Math.abs(hit.clone().sub(eyes).dot(left)) : 0;
    };
    const faceHalf = Math.min(faceSide(1), faceSide(-1)) || (le && re ? le.distanceTo(re) * 2 : 0.08);
    /** 所有尺寸的单位（米）：约为脸半宽的一半，量级和眼距相当 */
    const unit = faceHalf * 0.49;
    /** 看得见的眼睛中心离脸中线多远 */
    const eyeX = faceHalf * 0.5;
    /** 从脸前面往回打，打到的脸表面 */
    const onFace = (q: THREE.Vector3) => cast(faceMeshes, q.clone().addScaledVector(fwd, 0.4), back);

    // 嘴：两眼中点往下（和 gestures.ts 的 findMouth 同一个猜法）
    const eyeH = Math.max(0.03, eyes.clone().sub(headPos).dot(up));
    const mouthGuess = eyes.clone().addScaledVector(up, -0.7 * eyeH);
    const mouth = onFace(mouthGuess) ?? mouthGuess;
    const eyeToMouth = Math.max(0.02, eyes.clone().sub(mouth).dot(up));

    // 下眼睑在哪（相对两眼中点往上的坐标）：眨眼形状动到的顶点就是眼睑，闭上之后最低的那一圈就是下眼睑。
    // 各模型眼睛大小差很多（MMD 转的眼睛大得多），按眼到嘴的固定比例放脸红，大眼睛的模型会红在眼睛上
    const lowerLid = (() => {
      let low = Infinity;
      const v = new THREE.Vector3();
      const d = new THREE.Vector3();
      for (const b of mgr?.getExpression('blink')?.binds ?? []) {
        if (!(b instanceof VRMExpressionMorphTargetBind)) continue;
        for (const m of b.primitives) {
          const morph = m.geometry.morphAttributes.position?.[b.index];
          if (!morph) continue;
          const rel = m.geometry.morphTargetsRelative;
          const base = m.geometry.attributes.position;
          const nm = new THREE.Matrix3().setFromMatrix4(m.matrixWorld);
          for (let i = 0; i < morph.count; i++) {
            d.fromBufferAttribute(morph, i);
            if (!rel) d.sub(v.fromBufferAttribute(base, i));
            if (d.lengthSq() < 1e-6) continue;
            // 只看眼睛附近（左右各一个眼宽以内）
            m.getVertexPosition(i, v);
            v.applyMatrix4(m.matrixWorld).add(d.applyMatrix3(nm));
            const rel2 = v.sub(eyes);
            if (Math.abs(Math.abs(rel2.dot(left)) - eyeX) > unit * 1.2) continue;
            low = Math.min(low, rel2.dot(up));
          }
        }
      }
      return low;
    })();

    // 头的外轮廓（含头发）：头顶、两侧、刘海最前面
    const topY =
      (cast(meshes, headPos.clone().addScaledVector(up, 0.6), up.clone().negate())?.dot(up) ?? eyes.dot(up) + unit * 2.2) -
      eyes.dot(up);
    const sideAt = (s: number) => {
      const hit = cast(
        meshes,
        eyes.clone().addScaledVector(up, unit * 0.6).addScaledVector(left, s * 0.6),
        left.clone().multiplyScalar(-s),
      );
      return hit ? Math.abs(hit.clone().sub(eyes).dot(left)) : unit * 1.9;
    };
    const halfW = Math.min(sideAt(1), sideAt(-1));
    let front = depth(onFace(eyes) ?? eyes.clone().addScaledVector(fwd, 0.04));
    for (const dx of [-0.6, 0, 0.6]) {
      for (const dy of [0.25, 0.7, 1.1]) {
        const hit = cast(
          meshes,
          eyes.clone().addScaledVector(left, dx * unit).addScaledVector(up, dy * unit).addScaledVector(fwd, 0.4),
          back,
        );
        if (hit) front = Math.max(front, depth(hit));
      }
    }

    /** 以两眼中点为原点：x 往角色左、y 往上、z = 绝对深度 */
    const at = (x: number, y: number, z: number) =>
      eyes.clone().addScaledVector(left, x).addScaledVector(up, y).addScaledVector(fwd, z - depth(eyes));
    const toLocal = (v: THREE.Vector3) => head.worldToLocal(v.clone());
    const headQInv = head.getWorldQuaternion(new THREE.Quaternion()).invert();
    const scale = head.getWorldScale(new THREE.Vector3()).x || 1;
    // 平面朝前（+Z 对着角色前方）在头骨局部坐标里的朝向
    const facing = headQInv
      .clone()
      .multiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, fwd)));

    // ---- 图案 ----
    const tex = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
      const t = canvasTexture(w, h, draw);
      this.textures.push(t);
      return t;
    };
    const T = {
      vein: tex(256, 256, drawVein),
      exclaim: tex(256, 256, drawExclaim),
      notes: [tex(256, 256, drawNote('#ff6f9c', false)), tex(256, 256, drawNote('#ffb42e', true)), tex(256, 256, drawNote('#55b8ff', false))],
      sweat: tex(256, 256, drawDrop(false)),
      tear: tex(256, 256, drawDrop(true)),
      blush: tex(256, 128, drawBlush),
      gloom: tex(256, 256, drawGloom),
      shade: tex(256, 256, drawShade),
      question: tex(256, 256, drawQuestion),
      sparkle: tex(256, 256, drawSparkle),
    };
    this.noteTextures = T.notes;

    // ---- 头边的符号：Sprite，永远画在最上面 ----
    const sprite = (map: THREE.Texture) => {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }),
      );
      s.renderOrder = 1000;
      s.visible = false;
      this.root.add(s);
      return s;
    };
    this.vein = sprite(T.vein);
    this.exclaim = sprite(T.exclaim);
    this.sweat = sprite(T.sweat);
    for (let i = 0; i < 5; i++) this.notePool.push(sprite(T.notes[0]));
    this.question = sprite(T.question);
    for (let i = 0; i < 6; i++) this.sparklePool.push(sprite(T.sparkle));

    // ---- 贴在脸上的：跟脸一起被头发挡 ----
    const faceMat = (map: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        opacity: 0,
      });
    const add = (m: THREE.Mesh, order: number) => {
      m.renderOrder = order;
      m.visible = false;
      m.frustumCulled = false;
      this.root.add(m);
      return m;
    };

    /** 贴着脸的一小片：网格上每个点都投到脸上，再往外浮一点 */
    const patch = (center: THREE.Vector3, w: number, h: number, lift: number, map: THREE.Texture, nx = 8, ny = 5) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const fallback = depth(onFace(center) ?? center);
      for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) {
          const u = i / nx;
          const v = j / ny;
          const q = center
            .clone()
            .addScaledVector(left, (0.5 - u) * w)
            .addScaledVector(up, (v - 0.5) * h);
          const hit = onFace(q);
          q.addScaledVector(fwd, (hit ? depth(hit) : fallback) + lift - depth(q));
          const l = toLocal(q);
          pos.push(l.x, l.y, l.z);
          uv.push(u, v);
          if (i < nx && j < ny) {
            const k = j * (nx + 1) + i;
            idx.push(k, k + 1, k + nx + 1, k + 1, k + nx + 2, k + nx + 1);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      return add(new THREE.Mesh(g, faceMat(map)), 10);
    };
    /** 朝前的一块平面（尺寸按世界米，换到头骨局部） */
    const card = (w: number, h: number, map: THREE.Texture, order: number) => {
      const m = add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), faceMat(map)), order);
      m.quaternion.copy(facing);
      m.scale.setScalar(1 / scale);
      return m;
    };

    // 脸红：眼睛正下方偏外的颧骨上，宽约 1.1 个眼距。上沿在下眼睑下面留一点空；
    // 量不到下眼睑（没有眨眼形状）就按眼到嘴的 0.6
    const blushH = unit * 0.52;
    const blushY = Number.isFinite(lowerLid)
      ? Math.max(-eyeToMouth * 0.8, lowerLid - unit * 0.12 - blushH / 2)
      : -eyeToMouth * 0.6;
    for (const s of [1, -1]) {
      this.blush.push(patch(at(s * eyeX * 1.05, blushY, 0), unit * 1.1, blushH, 0.0025, T.blush));
    }
    // 阴影竖线：眼睛到额头，压在刘海前面
    this.gloom = card(unit * 3.6, unit * 1.9, T.gloom, 11);
    this.gloom.position.copy(toLocal(at(0, unit * 0.45, front + 0.004)));
    // 嫌弃的竖线画在脸上、刘海**里面**（贴着脸的一片，和脸红一样被头发挡住）：两眼之间、鼻梁上面那一小片，
    // 从刘海底下垂到眼睛中间。挂在刘海前面那一版像挑染；铺满额头又像脸脏了
    // 下沿到眼睛下面一点（鼻梁两侧）：刘海长的模型（夏夏、梅娜贝尔）只有这一截露在外面。
    // 竖着只分一格：每根线是一条直线（分很多格时线会顺着额头、眼窝的起伏弯）；横着分几格，两侧还是贴着脸往后收
    this.shade = patch(at(0, unit * 0.1, 0), unit * 3.0, unit * 1.6, 0.003, T.shade, 6, 1);
    // 眼泪：下眼角偏外 → 脸颊，两侧各一条路径
    for (const s of [1, -1]) {
      const path: THREE.Vector3[] = [];
      for (let k = 0; k <= 5; k++) {
        const v = k / 5;
        // 下眼角偏外 → 脸颊外侧。高度按眼到嘴的距离算（和脸红一样）：眼睛大小各模型差很多
        const q = at(s * eyeX * (1.22 + 0.1 * v), -eyeToMouth * (0.5 + 0.45 * v), 0);
        const hit = onFace(q) ?? q;
        path.push(toLocal(hit.addScaledVector(fwd, 0.004)));
      }
      this.tearPaths.push(path);
    }
    for (let i = 0; i < 4; i++) this.tearPool.push(card(unit * 0.5, unit * 0.64, T.tear, 12));

    return {
      scale,
      unit,
      // 青筋：头顶靠角色左侧（画面右侧），压在头发前面
      vein: toLocal(at(halfW * 0.5, topY * 0.55, front + 0.01)),
      // 感叹号：头顶右上（画面左上）
      exclaim: toLocal(at(-halfW * 0.75, topY + unit * 0.15, front)),
      // 汗滴：太阳穴外侧（画面左侧）
      sweat: toLocal(at(-(halfW + unit * 0.15), topY * 0.4, front)),
      // 音符：从头的画面右侧往上飘
      noteFrom: toLocal(at(halfW + unit * 0.35, topY * 0.25, front)),
      // 问号：头的画面左侧、偏上（头顶上方会被头发高的模型顶出画面）
      question: toLocal(at(-(halfW + unit * 0.45), topY * 0.7, front)),
      // 闪光：头的画面右侧（角色左侧）、眼睛往上一点，贴着头发外沿
      sparkle: toLocal(at(halfW + unit * 0.5, unit * 0.9, front)),
      up: up.clone().applyQuaternion(headQInv),
      left: left.clone().applyQuaternion(headQInv),
    };
  }
}
