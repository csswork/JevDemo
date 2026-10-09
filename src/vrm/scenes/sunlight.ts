import * as THREE from 'three';

/** Park sunlight helpers. The reusable light-shaft shader lives in lightShafts.ts.
 * Dust remains a separate Points draw so scenes can opt into either effect.
 */

/**
 * 滤色（screen）混合：结果 = 底色 + 光 ×（1 − 底色）。衬着暗绿的树叶时几乎全加上去，衬着亮的雾和天空时
 * 只加一点 —— 加色混合在亮处会一路叠到发白（宽屏转到太阳那一侧时，雾 + 天空光晕 + 几根光柱叠成一片乳白）
 */
const SCREEN = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneMinusDstColorFactor,
  blendDst: THREE.OneFactor,
} as const;

export { createLightShafts, type Shaft, type LightShaftSystem, type LightShaftParameters } from './lightShafts';

const DUST_VERT = /* glsl */ `
  attribute vec4 aSeed; // 三个相位 + 亮度
  uniform float uTime;
  uniform float uSize;   // 尘埃的直径（米）
  uniform float uViewH;  // 画面高度（像素）
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime;
    // 在原地附近慢慢漂：几个不同频率的正弦叠起来，再加一点很慢的上下沉浮
    p.x += sin(t * 0.21 + aSeed.x * 6.283) * 0.22 + sin(t * 0.13 + aSeed.y * 17.0) * 0.1;
    p.y += sin(t * 0.17 + aSeed.y * 6.283) * 0.16 + (fract(aSeed.z + t * 0.012) - 0.5) * 0.35;
    p.z += cos(t * 0.19 + aSeed.z * 6.283) * 0.22;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(0.1, -mv.z);
    gl_PointSize = clamp(uSize * projectionMatrix[1][1] * 0.5 * uViewH / dist, 1.5, 18.0);
    // 一闪一闪：转到亮面时反光
    float twinkle = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(t * (0.9 + aSeed.x * 1.6) + aSeed.w * 37.0), 2.0);
    vAlpha = aSeed.w * twinkle * smoothstep(0.8, 2.0, dist) * (1.0 - smoothstep(12.0, 20.0, dist));
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    // 亮核 + 一圈柔光
    float a = exp(-d * d * 7.0) + 0.25 * smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(uColor * a * vAlpha, 1.0);
  }
`;

/**
 * 光里的尘埃。points：位置；brightness：每颗的亮度（落在光柱里的亮，光柱外的暗一些）
 */
export function createDust(points: THREE.Vector3[], brightness: number[], color = new THREE.Color(1, 0.92, 0.75)) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(points.length * 3);
  const seed = new Float32Array(points.length * 4);
  let s = 12345;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  points.forEach((p, i) => {
    pos.set([p.x, p.y, p.z], i * 3);
    seed.set([rand(), rand(), rand(), brightness[i]], i * 4);
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: 0.02 },
      uViewH: { value: 800 },
      uColor: { value: color },
    },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    ...SCREEN,
  });
  const dust = new THREE.Points(geo, mat);
  dust.frustumCulled = false;
  dust.renderOrder = 3;
  dust.name = 'dust';
  const size = new THREE.Vector2();
  dust.onBeforeRender = (renderer) => {
    mat.uniforms.uViewH.value = renderer.getDrawingBufferSize(size).y;
  };
  return {
    points: dust,
    update(time: number) {
      mat.uniforms.uTime.value = time;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
