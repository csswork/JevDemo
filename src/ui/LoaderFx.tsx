import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * 载入画面的粒子（three.js，单独一块小画布，载完就整个销毁）：
 *
 *   平时    两千多颗柔光粒子在她头像周围慢慢打旋（越靠里转得越快，像一个旋涡），远近有景深、会闪
 *   进度    下载进度一点点上去，粒子一段一段被"收"到头像外面那一圈，最后聚成一个发光的光环
 *           （每颗粒子到位的时机不一样，所以是陆续汇过去，不是整体缩）
 *   载完    光环往外炸开、同时朝镜头冲过来，和 DOM 那边"镜头推进场景里"的退场一起
 *
 * 1 个世界单位 = 屏幕上 PX 像素，光环正好套在 DOM 的头像圈外面；光环的中心对着 .boot-ring 的位置（每次缩放窗口都重新对）。
 * 一个 Points + 一个 ShaderMaterial，位置全在顶点着色器里算，每帧只更新几个 uniform。
 */

const N = 2600;
/** 1 个世界单位在屏幕上多少 CSS 像素 */
const PX = 68;
const FOV = 40;

const VERT = /* glsl */ `
  uniform float uTime, uProg, uOut, uScale;
  attribute vec4 aRand;
  attribute vec3 aOrbit;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    // 这颗粒子什么时候被收到光环上：进度走到它那一段（各不相同）才开始往里汇
    float k = smoothstep( aRand.y * 0.7, aRand.y * 0.7 + 0.3, uProg );
    float ring = 1.2 + ( aRand.x - 0.5 ) * 0.2;
    float r = mix( aOrbit.x, ring, k * 0.94 );
    r += sin( uTime * 0.7 + aRand.w * 30.0 ) * 0.04;
    // 旋涡：越靠里转得越快
    float a = aOrbit.y + uTime * ( 0.06 + 0.42 / ( r * r + 0.7 ) );
    float z = aOrbit.z * ( 1.0 - k * 0.9 );
    // 载完：往外炸开、朝镜头冲过来
    float o = uOut * uOut;
    r *= 1.0 + o * 3.2 * ( 0.4 + aRand.x );
    z += o * 5.5 * aRand.y;
    vec4 mv = modelViewMatrix * vec4( cos( a ) * r, sin( a ) * r, z, 1.0 );
    gl_Position = projectionMatrix * mv;
    // 大多是细小的光点，少数是大而虚的光斑（散景）
    float size = 0.045 + pow( aRand.w, 4.0 ) * 0.34;
    gl_PointSize = size * uScale / -mv.z * ( 1.0 + o * 1.4 );
    float twinkle = 0.55 + 0.45 * sin( uTime * ( 1.4 + aRand.x * 3.0 ) + aRand.z * 20.0 );
    // 开场一颗一颗亮起来
    float fadeIn = smoothstep( 0.0, 0.8, uTime * 0.9 - aRand.y * 0.6 );
    // 大光斑淡一些，免得糊成一片
    vAlpha = twinkle * ( 0.55 + 0.45 * k ) * ( 1.0 - uOut ) * fadeIn * mix( 1.0, 0.35, pow( aRand.w, 4.0 ) );
    // 暖（左上那团光的颜色）/ 冷（右下）两种，收到光环上的偏白
    vColor = mix( mix( vec3( 1.0, 0.76, 0.62 ), vec3( 0.64, 0.68, 1.0 ), aRand.z ), vec3( 1.0 ), k * 0.4 );
  }
`;

const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length( gl_PointCoord - 0.5 );
    float a = smoothstep( 0.5, 0.0, d );
    a = a * a * 1.4;
    gl_FragColor = vec4( vColor, a * vAlpha );
  }
`;

export function LoaderFx({ progress, leaving }: { progress: number; leaving: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const target = useRef({ progress, leaving });
  useEffect(() => {
    target.current = { progress, leaving };
  }, [progress, leaving]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // 画布每次挂载都新建：卸载时会把 WebGL 上下文还回去（forceContextLoss），
    // 同一块画布上的上下文丢了就再也拿不回来 —— 开发时 StrictMode 挂两次，第二次就会建不起来
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch {
      // 没有 WebGL：只剩 DOM 那一层（头像、进度圈、柔光），照样能看
      canvas.remove();
      return;
    }
    const pr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(pr);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

    const rand = new Float32Array(N * 4);
    const orbit = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < 4; j++) rand[i * 4 + j] = Math.random();
      // 越靠近她越密
      orbit[i * 3] = 1.35 + Math.pow(Math.random(), 1.6) * 5.5;
      orbit[i * 3 + 1] = Math.random() * Math.PI * 2;
      orbit[i * 3 + 2] = (Math.random() - 0.5) * 4;
    }
    const geo = new THREE.BufferGeometry();
    // 位置在着色器里算；position 只是占位（three 要它来定点数）
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 3));
    const uniforms = {
      uTime: { value: 0 },
      uProg: { value: 0 },
      uOut: { value: 0 },
      uScale: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    // 窗口多大：相机放多远让 1 单位 = PX 像素；光环的中心对准 DOM 里头像圈的位置
    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      camera.position.z = h / (2 * tan * PX);
      camera.updateProjectionMatrix();
      uniforms.uScale.value = (h * pr) / (2 * tan);
      const ring = box.parentElement?.querySelector('.boot-ring')?.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      if (ring) {
        points.position.set((ring.left + ring.width / 2 - rect.left - w / 2) / PX, -(ring.top + ring.height / 2 - rect.top - h / 2) / PX, 0);
      }
    };
    resize();
    window.addEventListener('resize', resize);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    let first = true;
    const step = (dt: number) => {
      // DOM 的头像圈有入场动画，第一帧的位置不准：再对一次
      if (first) {
        first = false;
        resize();
      }
      uniforms.uTime.value += dt * (reduce ? 0.3 : 1);
      // 进度平滑地追上去（下载进度是一跳一跳的）
      uniforms.uProg.value += (target.current.progress - uniforms.uProg.value) * (1 - Math.exp(-dt * 3));
      uniforms.uOut.value = target.current.leaving ? Math.min(1, uniforms.uOut.value + dt / 0.8) : 0;
      renderer.render(scene, camera);
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt);
    };
    // 开发用：预览窗格隐藏时 rAF 不跑，手动往前推几秒看效果（__bootFx(3) = 推 3 秒）
    if (import.meta.env.DEV) {
      (window as unknown as { __bootFx?: (secs: number) => void }).__bootFx = (secs) => {
        for (let t = 0; t < secs; t += 1 / 60) step(1 / 60);
      };
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      // 主舞台还要用 WebGL：这块小画布的上下文立刻还回去
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  return <div className="boot-fx" ref={boxRef} aria-hidden />;
}
