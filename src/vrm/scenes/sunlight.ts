import * as THREE from 'three';

/**
 * 林间的阳光：光柱（丁达尔效应）+ 光里飘的尘埃。
 *
 * 不用路径追踪 / 体积光渲染：角色是动的（呼吸、头发弹簧、风里的草），逐帧累积的路径追踪
 * 一动就满屏噪点，MToon 也进不了路径追踪器；屏幕空间的体积光要太阳在画面里（这里太阳在相机右后方）。
 * 所以做成二次元插画里常见的画法：沿着阳光方向的一根根半透明光柱，加色混合、边缘柔和，
 * 里面有一点缓慢流动的明暗（光里的尘埃）。每根光柱是一张始终侧对相机的长条面片（绕光柱轴的柱面公告板），
 * 从任何角度看都像一束体积光；全部光柱一个 InstancedMesh、尘埃一个 Points，各一次绘制。
 * 两者都用滤色混合（见 SCREEN），不会把亮的背景叠成一片白。
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

export interface Shaft {
  /** 光柱落到地面的那一点（世界坐标） */
  ground: [number, number, number];
  /** 从地面往太阳方向延伸多长（米），顶端埋在树冠里 */
  length: number;
  /** 宽度（米，底部会再宽一点） */
  width: number;
  /** 亮度（0..1 左右） */
  intensity: number;
}

const SHAFT_VERT = /* glsl */ `
  attribute vec3 iGround;
  attribute vec4 iParams; // length, width, intensity, phase
  uniform vec3 uSunDir;
  varying vec2 vUv;
  varying float vIntensity;
  varying float vPhase;
  varying float vDist;
  varying float vSide;
  void main() {
    // position.y：0 = 地面，1 = 顶端；position.x：横向 -0.5..0.5
    vec3 base = (modelMatrix * vec4(iGround, 1.0)).xyz;
    vec3 p = base + uSunDir * (position.y * iParams.x);
    vec3 toCam = normalize(cameraPosition - p);
    vec3 side = normalize(cross(uSunDir, toCam));
    // 底部宽一点：光从树冠的缝里漏下来，越往下越散
    float w = iParams.y * mix(1.25, 0.65, position.y);
    p += side * position.x * w;
    vUv = vec2(position.x + 0.5, position.y);
    vIntensity = iParams.z;
    vPhase = iParams.w;
    // 视线和光柱平行时面片退化成一条线，淡掉（sin 夹角）
    vSide = length(cross(uSunDir, toCam));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHAFT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  varying float vIntensity;
  varying float vPhase;
  varying float vDist;
  varying float vSide;
  void main() {
    float x = vUv.x * 2.0 - 1.0;
    float envelope = exp(-x * x * 5.0) * (1.0 - x * x);
    // 一束光里分成几道细光（叶子缝漏下来的不是一整片）：横向的明暗条，宽度和位置每根不同
    float rays = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(x * (5.0 + 3.0 * vPhase) + vPhase * 19.0), 3.0);
    float across = envelope * rays;
    // 从地面往上慢慢变亮，最亮的一段在离地 3~6m（衬着暗绿的树叶最显；贴地那段叠在亮的雾上只会糊成一团白），
    // 再往上钻进树冠里收掉
    float along = smoothstep(0.0, 0.3, vUv.y) * (1.0 - smoothstep(0.5, 0.95, vUv.y));
    // 光里的尘埃：沿着光柱缓慢流动的明暗纹，每根相位不同
    float t = uTime + vPhase * 40.0;
    float flow = 0.72
      + 0.18 * sin(vUv.y * 11.0 - t * 0.32 + x * 1.7)
      + 0.10 * sin(vUv.y * 27.0 + t * 0.21 - x * 3.1);
    // 离相机太近不画（不然一整块糊在镜头上），太远被雾吃掉
    float dist = smoothstep(1.2, 4.0, vDist) * (1.0 - smoothstep(35.0, 80.0, vDist));
    float a = across * along * flow * vIntensity * dist * smoothstep(0.2, 0.7, vSide);
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

/** sunDir：从地面指向太阳的单位向量 */
export function createLightShafts(shafts: Shaft[], sunDir: THREE.Vector3, color = new THREE.Color(1, 0.86, 0.6)) {
  // 横向 4 段、纵向 12 段：纵向分段让宽度渐变平滑
  const geo = new THREE.PlaneGeometry(1, 1, 4, 12);
  geo.translate(0, 0.5, 0);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = geo.index;
  inst.setAttribute('position', geo.getAttribute('position'));
  const ground = new Float32Array(shafts.length * 3);
  const params = new Float32Array(shafts.length * 4);
  shafts.forEach((s, i) => {
    ground.set(s.ground, i * 3);
    params.set([s.length, s.width, s.intensity, (i * 0.618) % 1], i * 4);
  });
  inst.setAttribute('iGround', new THREE.InstancedBufferAttribute(ground, 3));
  inst.setAttribute('iParams', new THREE.InstancedBufferAttribute(params, 4));
  inst.instanceCount = shafts.length;
  geo.dispose();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir.clone().normalize() },
      uColor: { value: color },
      uTime: { value: 0 },
    },
    vertexShader: SHAFT_VERT,
    fragmentShader: SHAFT_FRAG,
    ...SCREEN,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(inst, mat);
  mesh.frustumCulled = false;
  // 在其他透明物体（草、花的 alphaTest 不算）之后画
  mesh.renderOrder = 2;
  mesh.name = 'light-shafts';
  return {
    mesh,
    update(time: number) {
      mat.uniforms.uTime.value = time;
    },
    dispose() {
      inst.dispose();
      mat.dispose();
    },
  };
}

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
