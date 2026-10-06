/**
 * 载入画面的粒子，在 Web Worker 里画（OffscreenCanvas）。
 *
 * 为什么放 worker：载入的时候主线程一直在干重活（解析 VRM、解码贴图、编译着色器、生成场景），
 * 一段一段几百毫秒地占着 —— 粒子要是也在主线程上跑，每一段都会停住，看起来就是一卡一卡的。
 * worker 有自己的帧循环，主线程忙不忙都不影响它。
 *
 * 消息：
 *   init    { canvas: OffscreenCanvas, reduce, w, h, pr, offX, offY }
 *   resize  { w, h, pr, offX, offY }
 *   state   { progress, leaving }
 *   step    { secs }      开发用：页面隐藏时帧循环不跑，手动往前推
 *   dispose
 */
import { createParticles, type ParticleFx } from './loaderFxGl';

interface Scope {
  onmessage: ((e: MessageEvent) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  close(): void;
}
const scope = self as unknown as Scope;

let fx: ParticleFx | null = null;
let raf = 0;
let last = 0;

// worker 里的 requestAnimationFrame（跟着屏幕刷新走）；没有就退回定时器
const nextFrame = (cb: (t: number) => void) =>
  scope.requestAnimationFrame ? scope.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), 16) as unknown as number);
const cancelFrame = (id: number) => (scope.cancelAnimationFrame ? scope.cancelAnimationFrame(id) : clearTimeout(id));

const tick = (now: number) => {
  raf = nextFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fx?.frame(dt);
};

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      fx = createParticles(m.canvas as OffscreenCanvas, m.reduce);
      if (!fx) return;
      fx.resize(m.w, m.h, m.pr, m.offX, m.offY);
      last = performance.now();
      raf = nextFrame(tick);
      break;
    case 'resize':
      fx?.resize(m.w, m.h, m.pr, m.offX, m.offY);
      break;
    case 'state':
      fx?.set(m.progress, m.leaving);
      break;
    case 'step':
      for (let t = 0; t < m.secs; t += 1 / 60) fx?.frame(1 / 60);
      break;
    case 'dispose':
      cancelFrame(raf);
      fx?.dispose();
      fx = null;
      scope.close();
      break;
  }
};
