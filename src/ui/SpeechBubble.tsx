import { useEffect, useRef, type RefObject } from 'react';
import type { Runtime } from '../runtime';

/**
 * 漫画式的对话气泡：挂在角色头边上，跟着镜头转、跟着人动（每帧把头的位置投到屏幕上）。
 *
 *  - 说到哪个字，哪个字"蹦"出来（没说到的字先淡淡地占着位置，气泡大小从一开始就定了，不会边说边变形）；
 *    感叹号、问号蹦得更大一点。字少的句子字大（"诶？！"这种），字多的字小
 *  - 描边是手画的、微微在"抖"（漫画 / 动画里的 boiling line：每 0.14 秒换一次噪声），说话时一直轻轻浮着
 *  - 名牌像一张歪着贴的小贴纸，说话的时候旁边有三根跳动的声波
 *  - 气泡的样子跟着脸上的情绪变：开心会轻轻跳、有小音符；惊讶抖一下、冒出惊叹线；生气是红边加青筋；
 *    难过是冷色、往下沉一点；放松是淡绿、慢慢晃；害羞是粉色、往里缩一下，冒一颗小心；
 *    得意是金色、往上挺一下，冒一颗闪光；困惑是淡蓝、歪一下，冒一个问号；嫌弃是灰青、往后缩，冒三条竖线
 *  - 等台词的时候是一朵真的"云"（三个点在冒），从头边冒出两个小泡泡连过去
 *  - 出现是弹性的（压扁 → 拉长 → 回弹），消失是缩回嘴边
 *  - 说完停 3 秒淡出
 *  - 放在哪：脸的右边 / 左边 / 头顶上，哪个不挡面板和输入框就放哪（右边优先，换位置有"惯性"，免得来回跳）；
 *    贴着画面边被推回来之后，尾巴重新瞄准脸
 *
 * 位置、逐字点亮都在 rAF 里直接改 DOM，不走 React 状态 —— 一秒 60 次的 re-render 会拖慢渲染
 */

type Place = 'r' | 'l' | 't';
type Mood = 'calm' | 'happy' | 'surprised' | 'angry' | 'sad' | 'relaxed' | 'shy' | 'smug' | 'confused' | 'disgusted';
const MOODS: Mood[] = ['happy', 'surprised', 'angry', 'sad', 'relaxed', 'shy', 'smug', 'confused', 'disgusted'];

/** 说完多久淡出（秒）：3 秒起，每个字多 0.05 秒，最多 6 秒 */
const LINGER = 3;
const LINGER_MAX = 6;
/** 尾巴尖到气泡身体的距离 */
const TAIL = 34;
const MARGIN = 12;
/** 气泡最宽多少（窗口窄时再收） */
const MAX_W = 330;
/** 描边"抖"的节奏（秒）：手绘动画一拍三 ≈ 8 帧每秒 */
const BOIL = 0.14;
/** 蹦得更大的字 */
const BANG = /[！？!?…]/;

/** 一句台词拆成一个个字的 span（按 UTF-16 下标记好位置，和 speechProgress 的字数对得上） */
function fillChars(box: HTMLElement, text: string) {
  box.textContent = '';
  let i = 0;
  for (const c of text) {
    const span = document.createElement('span');
    span.className = BANG.test(c) ? 'ch bang' : 'ch';
    span.textContent = c;
    span.dataset.i = String(i);
    box.appendChild(span);
    i += c.length;
  }
}

/** 字数 → 字号档：短句大字，长句小字 */
const sizeOf = (n: number) => (n <= 8 ? 'xl' : n <= 18 ? 'l' : n <= 60 ? 'm' : 's');

export function SpeechBubble({
  runtime,
  text,
  thinking,
  name,
}: {
  runtime: RefObject<Runtime | null>;
  /** 正在说的台词（空 = 没在说） */
  text: string;
  /** 在等台词 */
  thinking: boolean;
  name?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const turb = useRef<SVGFETurbulenceElement>(null);
  const textRef = useRef(text);
  const thinkingRef = useRef(thinking);
  useEffect(() => {
    textRef.current = text;
    thinkingRef.current = thinking;
  }, [text, thinking]);

  // 换了一句台词：重新弹出来
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (textBox.current) fillChars(textBox.current, text);
    el.dataset.size = sizeOf(text.length);
    el.classList.remove('pop');
    if (text || thinking) {
      void el.offsetWidth;
      el.classList.add('pop');
    }
  }, [text, thinking]);

  useEffect(() => {
    let raf = 0;
    let place: Place = 'r';
    let lastLeft = 0;
    let lastMaxW = 0;
    let fresh = true;
    let mood: Mood = 'calm';
    let pending: Mood = 'calm';
    let moodTimer = 0;
    let doneAt = -1;
    let shown = '';
    let lastN = 0;
    let boil = 0;
    let seed = 1;
    let last = performance.now();

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const el = root.current;
      const b = body.current;
      const rt = runtime.current;
      if (!el || !b || !rt) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;

      const txt = textRef.current;
      const think = thinkingRef.current && !txt;
      const prog = txt ? rt.speechProgress() : null;

      // ---- 显示 / 淡出 ----
      let visible = !!txt || think;
      if (txt) {
        if (prog && !prog.playing) {
          if (doneAt < 0) doneAt = now;
          // 字多就多留一会儿，来得及看完
          if (now - doneAt > Math.min(LINGER_MAX, LINGER + txt.length * 0.05) * 1000) visible = false;
        } else doneAt = -1;
      } else doneAt = -1;
      const mode = think ? 'thought' : 'speech';
      if (el.dataset.mode !== mode) el.dataset.mode = mode;
      el.classList.toggle('show', visible);

      // ---- 逐字蹦出来 ----
      const box = textBox.current;
      if (txt && prog && box) {
        if (txt !== shown) {
          shown = txt;
          lastN = 0;
          box.scrollTop = 0;
        }
        const n = Math.min(txt.length, Math.ceil(prog.chars));
        if (n > lastN) {
          let latest: HTMLElement | null = null;
          for (const ch of box.children as HTMLCollectionOf<HTMLElement>) {
            const i = Number(ch.dataset.i);
            if (i >= lastN && i < n) {
              ch.classList.add('on');
              latest = ch;
            }
          }
          lastN = n;
          // 长台词：让正在说的那一行留在气泡里
          if (latest) {
            const line = latest.offsetTop + latest.offsetHeight;
            if (line > box.clientHeight + box.scrollTop) box.scrollTo({ top: line - box.clientHeight + 4, behavior: 'smooth' });
          }
        }
      }
      el.classList.toggle('speaking', !!prog?.playing);

      // ---- 情绪 → 气泡的样子（每 0.15 秒看一次脸） ----
      moodTimer -= dt;
      if (moodTimer <= 0) {
        moodTimer = 0.15;
        const snap = rt.character?.expression.snapshot() ?? [];
        const top = snap.find(([k]) => (MOODS as string[]).includes(k));
        const next: Mood = top && top[1] > 0.28 ? (top[0] as Mood) : 'calm';
        // 连着两次都是新的情绪才换（表情过渡的半路上别来回闪）
        if (next !== mood && next === pending) {
          mood = next;
          el.dataset.mood = mood;
        }
        pending = next;
      }

      if (!visible) {
        // 下一句重新挑位置（不带上一句的"惯性"）
        fresh = true;
        return;
      }

      // ---- 描边在"抖"：换一下噪声的种子 ----
      boil -= dt;
      if (boil <= 0 && turb.current) {
        boil = BOIL;
        seed = (seed % 5) + 1;
        turb.current.setAttribute('seed', String(seed));
      }

      // ---- 跟着头走 ----
      const head = rt.headAnchor();
      const stage = el.parentElement!.getBoundingClientRect();
      if (!head) {
        el.classList.remove('show');
        return;
      }
      const r = Math.max(18, head.r);
      const obstacles = [...document.querySelectorAll<HTMLElement>('[data-bubble-avoid]')].map((o) => {
        const q = o.getBoundingClientRect();
        return { l: q.left - stage.left, t: q.top - stage.top, r: q.right - stage.left, b: q.bottom - stage.top };
      });

      // 窗口窄、两边的面板之间放不下的时候，气泡变窄一点（字多换几行）
      let gapL = 0;
      let gapR = stage.width;
      for (const o of obstacles) {
        if (o.b < head.y - 320 || o.t > head.y + r) continue;
        if (o.r <= head.x) gapL = Math.max(gapL, o.r);
        else if (o.l >= head.x) gapR = Math.min(gapR, o.l);
      }
      const maxW = Math.round(Math.max(200, Math.min(MAX_W, gapR - gapL - MARGIN * 2)) / 8) * 8;
      if (maxW !== lastMaxW) {
        lastMaxW = maxW;
        b.style.maxWidth = `${maxW}px`;
      }
      const w = b.offsetWidth;
      const h = b.offsetHeight;
      const cost = (left: number, top: number) => {
        let c = 0;
        // 出了画面
        c += (Math.max(0, MARGIN - left) + Math.max(0, left + w - (stage.width - MARGIN))) * h;
        c += (Math.max(0, MARGIN - top) + Math.max(0, top + h - (stage.height - MARGIN))) * w;
        for (const o of obstacles) {
          const ox = Math.max(0, Math.min(left + w, o.r) - Math.max(left, o.l));
          const oy = Math.max(0, Math.min(top + h, o.b) - Math.max(top, o.t));
          c += ox * oy;
        }
        return c;
      };

      // 三个候选：脸的右边、左边（尾巴指着脸颊），头顶上（尾巴往下指）。头顶那个左右滑着找最空的地方
      const tips: Record<Place, { x: number; y: number }> = {
        r: { x: head.x + r * 1.05, y: head.y + r * 0.15 },
        l: { x: head.x - r * 1.05, y: head.y + r * 0.15 },
        t: { x: head.x + r * 0.2, y: head.y - r * 1.25 },
      };
      const options: Array<{ place: Place; left: number; top: number; c: number }> = [];
      for (const pl of ['r', 'l', 't'] as Place[]) {
        const tip = tips[pl];
        const top = tip.y - TAIL - h;
        const lefts = pl === 'r' ? [tip.x + 10] : pl === 'l' ? [tip.x - 10 - w] : [0.2, 0.35, 0.5, 0.65, 0.8].map((k) => tip.x - w * k);
        for (const left of lefts) {
          // 偏好：右边 > 左边 > 头顶；现在在哪就再加一点"惯性"，免得来回跳
          const bias = (pl === 'r' ? 0 : pl === 'l' ? 600 : 1800) - (pl === place && !fresh ? 1000 : 0);
          options.push({ place: pl, left, top, c: cost(left, top) + bias });
        }
      }
      const best = options.reduce((a, o) => (o.c < a.c ? o : a));
      // 头顶的位置左右滑的时候也要稳：同一个位置里，离上一帧近的优先
      const same = options.filter((o) => o.place === best.place && o.c < best.c + 800);
      const pick = same.reduce((a, o) => (Math.abs(o.left - lastLeft) < Math.abs(a.left - lastLeft) ? o : a));
      place = pick.place;
      fresh = false;
      const left = Math.max(MARGIN, Math.min(stage.width - MARGIN - w, pick.left));
      const top = Math.max(MARGIN, Math.min(stage.height - MARGIN - h, pick.top));
      lastLeft = pick.left;
      el.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;

      // 尾巴：夹到画面里之后重新瞄准脸。左边的、或者头顶上脸偏右的，尾巴镜像
      const tip = tips[place];
      const local = tip.x - left;
      const flip = place === 'l' || (place === 't' && local > w * 0.55);
      const tailX = flip ? Math.max(62, Math.min(w + 10, local)) - 52 : Math.max(-10, Math.min(w - 62, local));
      el.style.setProperty('--tail-x', `${tailX.toFixed(1)}px`);
      el.style.setProperty('--tip-x', `${(flip ? tailX + 52 : tailX).toFixed(1)}px`);
      if (el.dataset.side !== (flip ? 'l' : 'r')) el.dataset.side = flip ? 'l' : 'r';
      // 被夹住了（贴着边）：尾巴就不一定指着脸了，压短一点免得指到别处
      el.classList.toggle('clamped', Math.abs(top - pick.top) > 24 || Math.abs(local - (flip ? tailX + 52 : tailX)) > 24);

    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [runtime]);

  return (
    <div className="bubble" ref={root} data-mood="calm" data-side="r" data-mode="speech" data-size="m" aria-live="polite">
      {/* 手绘描边用的滤镜：噪声把边缘推歪一点点 */}
      <svg className="bubble-defs" aria-hidden>
        <filter id="bubble-wobble" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence ref={turb} type="fractalNoise" baseFrequency="0.035" numOctaves={2} seed={1} />
          <feDisplacementMap in="SourceGraphic" scale={3.2} />
        </filter>
      </svg>
      <div className="bubble-inner">
        <div className="bubble-mood">
          {/* 尾巴分两层：描边在身体下面，填充盖在身体的描边上 —— 接口处就没有线了，像手画的 */}
          <svg className="bubble-tail under" viewBox="0 0 52 46" aria-hidden>
            <path d="M24 0C22 20 13 35 0 46C20 41 37 27 48 0Z" />
          </svg>
          <div className="bubble-body" ref={body}>
            {name && (
              <span className="bubble-name">
                {name}
                <span className="bubble-wave" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            )}
            <div className="bubble-text" ref={textBox} />
            <div className="bubble-dots" aria-label="思考中">
              <i />
              <i />
              <i />
            </div>
          </div>
          <svg className="bubble-tail over" viewBox="0 0 52 46" aria-hidden>
            <path d="M24 0C22 20 13 35 0 46C20 41 37 27 48 0Z" />
          </svg>
          {/* 思考云：几个圆叠起来，先画一层粗的描边、再盖一层白 —— 外轮廓就是云 */}
          <svg className="bubble-cloud" viewBox="0 0 104 64" aria-hidden>
            {[0, 1].map((layer) => (
              <g key={layer} className={layer ? 'fill' : 'line'}>
                <circle cx="26" cy="36" r="16" />
                <circle cx="44" cy="23" r="18" />
                <circle cx="65" cy="24" r="16" />
                <circle cx="81" cy="37" r="14" />
                <circle cx="58" cy="44" r="15" />
                <circle cx="36" cy="46" r="12" />
              </g>
            ))}
          </svg>
          {/* 思考云的小泡泡 */}
          <span className="thought-puff p1" />
          <span className="thought-puff p2" />
          {/* 漫画符号：跟着情绪换 */}
          <svg className="bubble-fx" viewBox="0 0 40 40" aria-hidden>
            <g className="fx-surprised">
              <path d="M8 22 2 18M12 13 8 5M21 10l1-9M29 13l6-6" />
            </g>
            <g className="fx-angry">
              <path d="M14 8c0 6 4 6 4 6s4 0 4-6M8 14c6 0 6 4 6 4s0 4-6 4M32 26c-6 0-6-4-6-4s0-4 6-4M26 32c0-6-4-6-4-6s-4 0-4 6" />
            </g>
            <g className="fx-happy">
              <path d="M14 26V10l12-3v15" />
              <ellipse cx="11" cy="26" rx="3.5" ry="2.6" />
              <ellipse cx="23" cy="22" rx="3.5" ry="2.6" />
            </g>
            <g className="fx-sad">
              <path d="M20 6c4 6 7 10 7 14a7 7 0 0 1-14 0c0-4 3-8 7-14z" />
            </g>
            <g className="fx-shy">
              <path d="M20 31C11 25 7 20 7 15a6 6 0 0 1 13-2 6 6 0 0 1 13 2c0 5-4 10-13 16z" />
            </g>
            <g className="fx-relaxed">
              <path d="M6 22c4-6 8-6 10 0s6 6 10 0M14 12c3-4 6-4 8 0s5 4 8 0" />
            </g>
            <g className="fx-smug">
              <path d="M20 4l3.5 11.5L35 19l-11.5 3.5L20 34l-3.5-11.5L5 19l11.5-3.5z" />
            </g>
            <g className="fx-confused">
              <path d="M13 13c0-5 4-8 8-8s7 3 7 7c0 5-7 6-7 11M21 31v1" />
            </g>
            <g className="fx-disgusted">
              <path d="M10 6v18M20 6v24M30 6v18" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
