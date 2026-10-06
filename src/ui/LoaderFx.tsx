import { useEffect, useRef } from 'react';
import { createParticles } from './loaderFxGl';

/**
 * 载入画面的粒子层（效果见 loaderFxGl.ts）。
 *
 * 优先在 Web Worker 里画（OffscreenCanvas，见 loaderFx.worker.ts）：载入时主线程被模型解析、场景生成一段一段占住，
 * 粒子放在主线程会跟着一卡一卡；放到 worker 里有自己的帧循环，不受影响。
 * 浏览器不支持 OffscreenCanvas 时退回主线程（照样能看，只是会跟着卡）。
 *
 * 光环要套在 DOM 的头像圈外面：中心位置在主线程量（.boot-ring），随尺寸一起发过去。
 */
export function LoaderFx({ progress, leaving }: { progress: number; leaving: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const sendState = useRef<(p: number, l: boolean) => void>(() => {});
  const latest = useRef({ progress, leaving });

  useEffect(() => {
    latest.current = { progress, leaving };
    sendState.current(progress, leaving);
  }, [progress, leaving]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // 画布每次挂载都新建（交给 worker 之后这块画布就不能再用了；StrictMode 会挂两次）
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pr = Math.min(window.devicePixelRatio, 1.5);

    const measure = () => {
      const r = canvas.getBoundingClientRect();
      const ring = box.parentElement?.querySelector('.boot-ring')?.getBoundingClientRect();
      const offX = ring ? ring.left + ring.width / 2 - (r.left + r.width / 2) : 0;
      const offY = ring ? ring.top + ring.height / 2 - (r.top + r.height / 2) : 0;
      return { w: r.width, h: r.height, pr, offX, offY };
    };

    let resize = () => {};
    let step: (secs: number) => void = () => {};
    let dispose = () => {};

    if ('transferControlToOffscreen' in canvas && typeof Worker !== 'undefined') {
      const worker = new Worker(new URL('./loaderFx.worker.ts', import.meta.url), { type: 'module' });
      const off = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: off, reduce, ...measure() }, [off]);
      sendState.current = (p, l) => worker.postMessage({ type: 'state', progress: p, leaving: l });
      resize = () => worker.postMessage({ type: 'resize', ...measure() });
      step = (secs) => {
        worker.postMessage({ type: 'step', secs });
      };
      dispose = () => {
        worker.postMessage({ type: 'dispose' });
        // 给它一点时间把 WebGL 上下文还回去，再强行结束
        setTimeout(() => worker.terminate(), 200);
      };
    } else {
      const fx = createParticles(canvas, reduce);
      if (!fx) {
        canvas.remove();
        return;
      }
      resize = () => {
        const m = measure();
        fx.resize(m.w, m.h, m.pr, m.offX, m.offY);
      };
      resize();
      let raf = 0;
      let last = performance.now();
      const frame = () => {
        raf = requestAnimationFrame(frame);
        const now = performance.now();
        fx.frame(Math.min(0.05, (now - last) / 1000));
        last = now;
      };
      raf = requestAnimationFrame(frame);
      sendState.current = (p, l) => fx.set(p, l);
      step = (secs) => {
        for (let t = 0; t < secs; t += 1 / 60) fx.frame(1 / 60);
      };
      dispose = () => {
        cancelAnimationFrame(raf);
        fx.dispose();
      };
    }
    sendState.current(latest.current.progress, latest.current.leaving);

    // 尺寸变了、头像圈的入场动画走完（第一次量的位置不准）都重新对一次
    const settle = window.setTimeout(resize, 900);
    window.addEventListener('resize', resize);

    // 开发用：预览窗格隐藏时帧循环不跑，手动往前推几秒看效果（__bootFx(3) = 推 3 秒）
    if (import.meta.env.DEV) (window as unknown as { __bootFx?: (secs: number) => void }).__bootFx = step;

    return () => {
      clearTimeout(settle);
      window.removeEventListener('resize', resize);
      sendState.current = () => {};
      dispose();
      canvas.remove();
    };
  }, []);

  return <div className="boot-fx" ref={boxRef} aria-hidden />;
}
