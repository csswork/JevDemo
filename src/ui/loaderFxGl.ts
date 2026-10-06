/**
 * 载入画面的粒子：原生 WebGL，一次 drawArrays(POINTS)，位置全在顶点着色器里算。
 *
 * 不用 three.js：粒子是在 Web Worker 里画的（loaderFx.worker.ts），worker 要单独打包一份依赖 ——
 * 带上 three 就是几百 KB，偏偏在载入的时候多下载一份。这点效果原生写一百来行就够了。
 * 不支持 OffscreenCanvas 的浏览器在主线程里用同一份（LoaderFx.tsx）。
 *
 *   平时    粒子在她头像周围慢慢打旋（越靠里转得越快），远近有景深、会闪；少数是大而虚的光斑
 *   进度    粒子一段一段被收到头像外面那一圈，最后聚成发光的光环（每颗到位的时机不一样）
 *   载完    光环往外炸开、同时朝镜头冲过来
 *
 * 1 个世界单位 = 屏幕上 PX 个 CSS 像素，光环正好套在 DOM 的头像圈外面；光环中心由调用方给（对准 .boot-ring）。
 */

export const N = 1800;
/** 1 个世界单位在屏幕上多少 CSS 像素 */
export const PX = 68;
const FOV = (40 * Math.PI) / 180;

const VERT = `
  precision highp float;
  attribute vec4 aRand;
  attribute vec3 aOrbit;
  uniform float uTime, uProg, uOut, uScale, uCamZ, uF, uAspect;
  uniform vec2 uOffset;
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
    vec3 p = vec3( cos( a ) * r + uOffset.x, sin( a ) * r + uOffset.y, z );
    // 透视投影（相机在 z = uCamZ 往 -z 看）
    float w = uCamZ - p.z;
    gl_Position = vec4( p.x * uF / uAspect, p.y * uF, 0.0, w );
    float bokeh = pow( aRand.w, 4.0 );
    // 大多是细小的光点，少数是大而虚的光斑（散景）
    gl_PointSize = ( 0.045 + bokeh * 0.34 ) * uScale / w * ( 1.0 + o * 1.4 );
    float twinkle = 0.55 + 0.45 * sin( uTime * ( 1.4 + aRand.x * 3.0 ) + aRand.z * 20.0 );
    // 开场一颗一颗亮起来
    float fadeIn = smoothstep( 0.0, 0.8, uTime * 0.9 - aRand.y * 0.6 );
    vAlpha = twinkle * ( 0.55 + 0.45 * k ) * ( 1.0 - uOut ) * fadeIn * mix( 1.0, 0.35, bokeh );
    // 暖 / 冷两种（和背景两团柔光一个色），收到光环上的偏白
    vColor = mix( mix( vec3( 1.0, 0.76, 0.62 ), vec3( 0.64, 0.68, 1.0 ), aRand.z ), vec3( 1.0 ), k * 0.4 );
  }
`;

const FRAG = `
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length( gl_PointCoord - 0.5 );
    float a = smoothstep( 0.5, 0.0, d );
    a = a * a * 1.4 * vAlpha;
    // 预乘 alpha（画布是预乘的），配合下面的叠加混合
    gl_FragColor = vec4( vColor * a, a );
  }
`;

export interface ParticleFx {
  /** 画布的 CSS 尺寸、像素比、光环中心离画布中心多少 CSS 像素（x 向右、y 向下） */
  resize(w: number, h: number, pr: number, offX: number, offY: number): void;
  set(progress: number, leaving: boolean): void;
  /** 往前推 dt 秒并画一帧 */
  frame(dt: number): void;
  dispose(): void;
}

export function createParticles(canvas: HTMLCanvasElement | OffscreenCanvas, reduce: boolean): ParticleFx | null {
  const opts = { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' as const };
  const gl = (canvas.getContext('webgl2', opts) ?? canvas.getContext('webgl', opts)) as WebGLRenderingContext | null;
  if (!gl) return null;

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  // 每颗粒子 7 个数：aRand(4) + aOrbit(3)
  const data = new Float32Array(N * 7);
  for (let i = 0; i < N; i++) {
    const o = i * 7;
    for (let j = 0; j < 4; j++) data[o + j] = Math.random();
    // 越靠近她越密
    data[o + 4] = 1.35 + Math.pow(Math.random(), 1.6) * 5.5;
    data[o + 5] = Math.random() * Math.PI * 2;
    data[o + 6] = (Math.random() - 0.5) * 4;
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const aRand = gl.getAttribLocation(prog, 'aRand');
  const aOrbit = gl.getAttribLocation(prog, 'aOrbit');
  gl.enableVertexAttribArray(aRand);
  gl.vertexAttribPointer(aRand, 4, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(aOrbit);
  gl.vertexAttribPointer(aOrbit, 3, gl.FLOAT, false, 28, 16);

  const u = (name: string) => gl.getUniformLocation(prog, name);
  const U = {
    time: u('uTime'),
    prog: u('uProg'),
    out: u('uOut'),
    scale: u('uScale'),
    camZ: u('uCamZ'),
    f: u('uF'),
    aspect: u('uAspect'),
    offset: u('uOffset'),
  };
  gl.enable(gl.BLEND);
  // 叠加：颜色越叠越亮，alpha 也累加（预乘）
  gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
  gl.clearColor(0, 0, 0, 0);
  const f = 1 / Math.tan(FOV / 2);
  gl.uniform1f(U.f, f);

  let time = 0;
  let progShown = 0;
  let out = 0;
  let target = { progress: 0, leaving: false };

  return {
    resize(w, h, pr, offX, offY) {
      if (!w || !h) return;
      canvas.width = Math.round(w * pr);
      canvas.height = Math.round(h * pr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      // 相机放多远：让 1 单位 = PX 个像素
      gl.uniform1f(U.camZ, (h * f) / (2 * PX));
      gl.uniform1f(U.aspect, w / h);
      gl.uniform1f(U.scale, (h * pr * f) / 2);
      gl.uniform2f(U.offset, offX / PX, -offY / PX);
    },
    set(progress, leaving) {
      target = { progress, leaving };
    },
    frame(dt) {
      time += dt * (reduce ? 0.3 : 1);
      // 进度平滑地追上去（下载进度是一跳一跳的）
      progShown += (target.progress - progShown) * (1 - Math.exp(-dt * 3));
      out = target.leaving ? Math.min(1, out + dt / 0.8) : 0;
      gl.uniform1f(U.time, time);
      gl.uniform1f(U.prog, progShown);
      gl.uniform1f(U.out, out);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, N);
    },
    dispose() {
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
