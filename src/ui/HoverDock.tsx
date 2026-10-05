import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

/**
 * 悬浮的小胶囊 → 卡片（左上的角色、左下的场景都用它）：平时只是一颗小胶囊（和右上角「调试」一样高），
 * 鼠标移上去从胶囊"长"成整张卡片（clip-path 从胶囊的大小展开，里面的内容依次浮上来）。
 *
 * 什么时候收回去：
 *   - 只是路过（没在卡片里点过）：鼠标移出就收（稍等 0.22 秒，免得擦边就闪）
 *   - 在卡片里点过（换音色、换背景、开了下拉框……）：说明在用，移出也不收；点卡片外面任何地方才收
 *   - 按 Esc 也收
 * 没有鼠标的设备（触屏）：点胶囊打开，点外面收。
 */
export function HoverDock({
  pill,
  children,
  label,
  className = '',
  from = 'top',
}: {
  pill: ReactNode;
  children: ReactNode;
  label: string;
  /** 放在哪由这个 class 定（.dock-char 左上、.dock-scene 左下） */
  className?: string;
  /** 卡片往哪边长：top = 胶囊在上、往下铺开；bottom = 胶囊在下、往上铺开 */
  from?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  // 展开的动画走完之后去掉 clip-path：卡片里的下拉菜单要伸出卡片外面
  const [settled, setSettled] = useState(false);
  const engaged = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const leaveTimer = useRef(0);

  const show = () => {
    clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(leaveTimer.current);
    engaged.current = false;
    // 先把 clip-path 装回来，并让浏览器先算一遍样式（"不裁"→"裁成胶囊"之间没有过渡，
    // 得先落在"裁成整张卡片"上），然后再收。不用 rAF：后台 / 隐藏的页面里 rAF 会被节流，卡片就收不回去
    flushSync(() => setSettled(false));
    if (card.current) void getComputedStyle(card.current).clipPath;
    setOpen(false);
  };

  // 胶囊多大，卡片就从多大开始长（换了角色名字长短不一，每次量）
  useLayoutEffect(() => {
    const p = pillRef.current;
    const r = root.current;
    if (!p || !r) return;
    r.style.setProperty('--pill-w', `${p.offsetWidth}px`);
    r.style.setProperty('--pill-h', `${p.offsetHeight}px`);
  });

  // 点过之后：点外面任何地方才收；Esc 随时收
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) hide();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  // 兜底：动画结束的事件没来（减弱动画、后台标签页），到点也算铺开了，免得下拉菜单一直被裁
  useEffect(() => {
    if (!open || settled) return;
    const t = window.setTimeout(() => setSettled(true), 600);
    return () => clearTimeout(t);
  }, [open, settled]);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  return (
    <div
      ref={root}
      className={`dock ${className} ${open ? 'open' : ''} ${settled ? 'settled' : ''}`}
      data-from={from}
      data-bubble-avoid
      onPointerEnter={(e) => e.pointerType === 'mouse' && show()}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse' || engaged.current) return;
        leaveTimer.current = window.setTimeout(hide, 220);
      }}
      onPointerDownCapture={() => {
        engaged.current = true;
      }}
    >
      <button
        ref={pillRef}
        type="button"
        className="dock-pill glass"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          engaged.current = true;
          show();
        }}
      >
        {pill}
      </button>
      <section
        ref={card}
        className="dock-card glass"
        aria-hidden={!open}
        inert={!open}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === 'clip-path' && open) setSettled(true);
        }}
      >
        {children}
      </section>
    </div>
  );
}
