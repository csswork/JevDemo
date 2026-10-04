import * as THREE from 'three';
import { rng } from './common';

/**
 * 天上的云（街景、公园共用）：一圈积云 + 高空一层卷云，全在着色器里画，会动。
 *
 * 积云：每朵是一个竖着的面片（朝着场景中心），所有积云一个实例化网格、一次绘制。
 *   - 形状：每朵由二三十个"棉花球"拼成（底下一排扁的，中间往上堆一两座"塔"，和原来 canvas 画的一个路数），
 *     球的位置、大小在 JS 里按种子生成，存进一张浮点贴图（一朵一行）。片元里找最靠前的那个球，
 *     按球面算出法线 —— 插画里那种"上面亮白、下面一层层灰蓝阴影"的体积感就是这么来的。
 *     轮廓按流动的噪声扭一扭、边缘再被噪声侵蚀成絮状，噪声随时间慢慢流动，云在缓缓翻涌
 *   - 光：太阳、月亮各算一次（亮面和阴影之间分界清楚一点，插画的画法）；光在云背后时，
 *     薄的边缘透光变亮（金边 / 银边）；云底平、偏暗，夜里被地上的灯映成暖色（below）
 *   - 透明：边缘、薄的地方是半透明的；月亮附近的云再薄一些、透出一团朦胧的光，月亮不会被整块挡死
 *   - 移动：每一组（band）的云绕着场景中心往同一个方向漂（近的云角速度大一点）。
 *     组的方位角范围不满一圈时，飘到尽头的云慢慢消散、从另一头重新长出来（不会突然出现、消失）
 *
 * 卷云：高处一层薄薄的、顺着风向拉长的丝缕，画在一个半球上（只在天空的上半部分），也随风慢慢移动。
 *
 * 颜色由场景每帧给（uniforms）：亮面色（太阳 / 月亮各一个，乘上强度）、阴影色、云底的映光、地平线的雾色。
 * 颜色都是线性空间的；不吃雾，不做色调映射（和天空一样）。
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

export interface CloudBand {
  /** 方位角范围（弧度，atan2(z, x)）；to - from ≥ 2π 时首尾相接，云不消散 */
  from: number;
  to: number;
  count: number;
  /** 云底的高度角（度） */
  elev: [number, number];
  /** 宽度，按离中心的距离算的比例（0.5 = 宽是距离的一半） */
  width: [number, number];
  /** 高矮：0.5 扁平 … 1.25 高耸 */
  tall: [number, number];
  /** 不透明度 */
  opacity?: [number, number];
}

export interface CloudOptions {
  /** 积云离中心多远（各朵在 0.9~1 倍之间错开，近的画在前面） */
  dist: number;
  bands: CloudBand[];
  seed?: number;
  /** 风：积云每秒绕中心走多少度（正数 = 方位角变大的方向） */
  drift?: number;
  /** 卷云：不透明度（0 = 不要），画在多远 */
  cirrus?: { opacity: number; dist: number };
}

export function cloudUniforms() {
  return {
    uTime: { value: 0 },
    /** 风：积云每秒绕中心走多少弧度；卷云在"天上那一层平面"上每秒移多少 */
    uDrift: { value: 0 },
    uWind: { value: new THREE.Vector2(0.0016, 0.0007) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    /** 太阳照到的那一面的颜色、太阳照得多亮（0..1：0 = 太阳不照云） */
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSun: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    uMoonCol: { value: new THREE.Color(0.5, 0.56, 0.72) },
    uMoon: { value: 0 },
    /** 月亮从云后面透出来的那团光（0..1，跟着月亮在天上显不显） */
    uMoonGlow: { value: 0 },
    /** 背光面（阴影）的颜色 */
    uShade: { value: new THREE.Color(0xb7c7e2) },
    /** 云底被地上照亮的颜色（夜里小镇的灯），加上去的 */
    uBelow: { value: new THREE.Color(0, 0, 0) },
    /** 贴着地平线的云往雾色里融多少 */
    uHaze: { value: new THREE.Color(0xd3e8f5) },
    uHazeAmt: { value: 0.25 },
    /** 整体的云量（不透明度的倍数） */
    uCoverage: { value: 1 },
    uCirrus: { value: 0 },
    uPuffs: { value: null as THREE.DataTexture | null },
  };
}
export type CloudUniforms = ReturnType<typeof cloudUniforms>;

/** 一朵云最多几个棉花球（贴图一行的宽度） */
const MAXP = 32;
/** 云底在云的局部坐标里的高度（局部坐标：x -1..1，y 0..1，1 个单位 = 宽度的一半） */
const BASE = 0.12;

/** 一朵积云的棉花球：[x, y, 半径, 前后（越大越靠前）] */
function cumulusPuffs(r: () => number, tall: number) {
  const P: Array<[number, number, number, number]> = [];
  // 底下一排扁的（两头小、中间大）
  const n = 9;
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    const mid = 1 - Math.abs(t - 0.5) * 2;
    const rad = (0.07 + 0.06 * mid + r() * 0.04) * (0.85 + 0.2 * tall);
    P.push([-0.82 + t * 1.64 + (r() - 0.5) * 0.08, BASE + rad * (0.45 + r() * 0.2), rad, 0.06 + (r() - 0.5) * 0.06]);
  }
  // 中间往上堆一到三座"塔"：越往上越窄、越靠后（下面的一层层压在前面）
  const towers = 1 + Math.floor(r() * (1.4 + tall));
  for (let k = 0; k < towers && P.length < MAXP - 1; k++) {
    const cx = -0.5 + r() * 1.0;
    const top = BASE + (0.25 + r() * 0.35) * tall;
    const m = 6 + Math.floor(r() * 2);
    for (let i = 0; i < m && P.length < MAXP - 1; i++) {
      const t = i / (m - 1);
      const spread = (1 - t * 0.55) * (0.2 + r() * 0.08);
      const rad = (0.13 - t * 0.045) * (0.8 + r() * 0.4) * (0.75 + 0.35 * tall);
      const y = Math.min(BASE + 0.06 + (top - BASE - 0.06) * t, 0.97 - rad);
      P.push([cx + (r() - 0.5) * spread * 1.6, y, rad, -t * 0.12 + (r() - 0.5) * 0.06]);
    }
  }
  return P;
}

const NOISE_GLSL = /* glsl */ `
  float cHash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float cNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( cHash( i ), cHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( cHash( i + vec2( 0.0, 1.0 ) ), cHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
  float cFbm( vec2 p ) {
    return ( cNoise( p ) * 0.5 + cNoise( p * 2.03 + 17.1 ) * 0.25 + cNoise( p * 4.07 - 9.3 ) * 0.125 ) / 0.875;
  }
`;

const LIGHT_GLSL = /* glsl */ `
  uniform vec3 uSunDir, uSunCol, uMoonDir, uMoonCol, uShade, uBelow, uHaze;
  uniform float uSun, uMoon, uMoonGlow, uHazeAmt;
  // 月亮从云后面透出来：一团朦胧的光；离月亮 4° 以内的云薄一些（最多薄一半）
  vec3 moonThrough( vec3 v, inout float alpha ) {
    float md = max( dot( v, uMoonDir ), 0.0 );
    alpha *= 1.0 - 0.5 * uMoonGlow * smoothstep( 0.9975, 0.99994, md );
    return vec3( 0.75, 0.82, 1.0 ) * ( pow( md, 3000.0 ) * 1.2 + pow( md, 250.0 ) * 0.35 ) * uMoonGlow;
  }
`;

const CUMULUS_VERT = /* glsl */ `
  uniform float uTime, uDrift;
  uniform vec3 uSunDir, uMoonDir;
  attribute vec4 aPlace; // 起始方位角、云底的高度角（弧度）、宽（负数 = 左右翻过来）、离中心多远
  attribute vec4 aBand;  // 组的起始方位角、方位角范围（≥ 2π = 一整圈）、角速度的倍数、-
  attribute vec4 aShape; // 贴图的第几行、种子、不透明度、-
  attribute vec4 aRect;  // 棉花球占的范围：x 最小、x 最大、y 最大（面片只盖这一块）
  varying vec2 vQ;
  varying vec3 vDir, vLs, vLm;
  varying vec4 vInfo; // 第几行、种子、不透明度、长出来多少（0..1）
  void main() {
    float span = aBand.y;
    float u = mod( aPlace.x - aBand.x + uDrift * aBand.z * uTime, span );
    float a = aBand.x + u;
    float life = span >= 6.28 ? 1.0 : smoothstep( 0.0, 0.12, u / span ) * smoothstep( 1.0, 0.88, u / span );
    float w = aPlace.z;
    vec3 out_ = vec3( cos( a ), 0.0, sin( a ) );
    vec3 right = vec3( -sin( a ), 0.0, cos( a ) ) * sign( w );
    vec3 C = vec3( out_.x * cos( aPlace.y ), sin( aPlace.y ), out_.z * cos( aPlace.y ) ) * aPlace.w;
    vec2 q = vec2( mix( aRect.x, aRect.y, position.x * 0.5 + 0.5 ), position.y * aRect.z );
    vec3 wp = C + ( right * q.x + vec3( 0.0, q.y, 0.0 ) ) * abs( w ) * 0.5;
    vQ = q;
    vec4 world = modelMatrix * vec4( wp, 1.0 );
    vDir = world.xyz - cameraPosition;
    // 光的方向换到云自己的坐标里（x 向右、y 向上、z 朝着看的人）
    vLs = vec3( dot( uSunDir, right ), uSunDir.y, -dot( uSunDir, out_ ) );
    vLm = vec3( dot( uMoonDir, right ), uMoonDir.y, -dot( uMoonDir, out_ ) );
    vInfo = vec4( aShape.x, aShape.y, aShape.z, life );
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CUMULUS_FRAG = /* glsl */ `
  uniform float uTime, uCoverage;
  uniform highp sampler2D uPuffs;
  varying vec2 vQ;
  varying vec3 vDir, vLs, vLm;
  varying vec4 vInfo;
  ${NOISE_GLSL}
  ${LIGHT_GLSL}
  const float BASE = ${BASE.toFixed(3)};
  void main() {
    float seed = vInfo.y;
    float life = vInfo.w;
    float t = uTime;
    // 慢慢翻涌：轮廓按流动的噪声扭一扭
    vec2 q = vQ;
    vec2 warp = vec2( cFbm( q * 3.2 + vec2( seed, t * 0.012 ) ), cFbm( q * 3.2 + vec2( t * 0.01, seed + 5.7 ) ) ) - 0.5;
    q += warp * 0.1;
    // 找最靠前的那个棉花球：它的球面法线就是这一点的法线
    float field = 0.0;
    float best = -1e3;
    vec3 n = vec3( 0.0, 0.0, 1.0 );
    int row = int( vInfo.x + 0.5 );
    for ( int i = 0; i < ${MAXP}; i++ ) {
      vec4 P = texelFetch( uPuffs, ivec2( i, row ), 0 );
      if ( P.z <= 0.0 ) break;
      vec2 dp = q - P.xy;
      float f = 1.0 - dot( dp, dp ) / ( P.z * P.z );
      field = max( field, f );
      if ( f > 0.0 ) {
        float h = sqrt( f ) * P.z + P.w;
        if ( h > best ) {
          best = h;
          n = vec3( dp / P.z, sqrt( f ) );
        }
      }
    }
    // 边缘被侵蚀成絮状；刚长出来 / 快消散的云整体被"吃"掉一圈
    float ero = cFbm( vQ * 9.0 + vec2( seed * 3.1, -t * 0.02 ) );
    float dens = field - ( ero - 0.4 ) * 0.4 - ( 1.0 - life ) * 1.1;
    float alpha = smoothstep( 0.0, 0.22, dens );
    // 云底平：底边也带一点噪声
    float bottom = smoothstep( BASE - 0.015, BASE + 0.05, q.y + ( ero - 0.5 ) * 0.05 );
    alpha *= bottom;
    if ( alpha < 0.004 ) discard;
    // 小的鼓包：法线按细噪声的梯度歪一点
    vec2 bq = q * 16.0 + seed * 7.0 + vec2( 0.0, t * 0.01 );
    float b0 = cNoise( bq );
    n.xy -= vec2( cNoise( bq + vec2( 0.2, 0.0 ) ) - b0, cNoise( bq + vec2( 0.0, 0.2 ) ) - b0 ) * 1.6;
    // 云底那一圈法线朝下（黄昏太阳在云底下面时，云底被照成橙红）
    n.y = mix( -0.7, n.y, smoothstep( BASE, BASE + 0.1, q.y ) );
    n = normalize( n );
    // 越往下越暗（底下的被上面挡着），球和球之间的缝也暗一点
    float ao = mix( 0.62, 1.0, smoothstep( BASE, BASE + 0.45, q.y ) ) * mix( 0.82, 1.0, n.z );
    float ls = smoothstep( -0.2, 0.5, dot( n, normalize( vLs ) ) );
    float lm = smoothstep( -0.2, 0.5, dot( n, normalize( vLm ) ) );
    vec3 c = uShade * ao;
    c = mix( c, uSunCol * mix( 0.85, 1.0, ao ), ls * uSun );
    c = mix( c, uMoonCol * mix( 0.85, 1.0, ao ), lm * uMoon );
    // 光在云背后：薄的边缘透光（往光那边看得越正越亮）
    vec3 v = normalize( vDir );
    float thin = 1.0 - smoothstep( 0.0, 0.45, dens * bottom );
    float rim = thin + pow( 1.0 - n.z, 3.0 ) * 0.4;
    c += uSunCol * uSun * pow( max( dot( v, uSunDir ), 0.0 ), 8.0 ) * rim * 1.4;
    c += uMoonCol * uMoon * pow( max( dot( v, uMoonDir ), 0.0 ), 40.0 ) * rim * 2.2;
    // 云底被地上的灯映亮
    c += uBelow * ( 1.0 - smoothstep( BASE, BASE + 0.35, q.y ) );
    c += moonThrough( v, alpha );
    c = mix( c, uHaze, uHazeAmt * ( 1.0 - smoothstep( 0.02, 0.2, v.y ) ) );
    gl_FragColor = vec4( c, alpha * vInfo.z * uCoverage );
    #include <colorspace_fragment>
  }
`;

const CIRRUS_VERT = /* glsl */ `
  varying vec3 vDir, vView;
  void main() {
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vDir = normalize( position );
    vView = world.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const CIRRUS_FRAG = /* glsl */ `
  uniform float uTime, uCirrus, uCoverage;
  uniform vec2 uWind;
  varying vec3 vDir, vView;
  ${NOISE_GLSL}
  ${LIGHT_GLSL}
  void main() {
    vec3 d = normalize( vDir );
    if ( d.y < 0.06 ) discard;
    // 天上一层平面：离地平线越近，看到的越远、越密
    vec2 p = d.xz / ( d.y + 0.12 ) + uWind * uTime;
    // 一片一片的（不是满天都有）
    float pat = smoothstep( 0.52, 0.78, cNoise( p * 0.45 + 3.0 ) * 0.7 + cNoise( p * 1.1 - 7.0 ) * 0.3 );
    if ( pat <= 0.0 ) discard;
    // 丝缕：顺着风拉长
    vec2 wd = normalize( uWind );
    vec2 s = vec2( dot( p, wd ), dot( p, vec2( -wd.y, wd.x ) ) );
    float st = cFbm( s * vec2( 1.3, 7.0 ) + cNoise( s * 2.0 ) * 0.8 );
    float alpha = pat * smoothstep( 0.42, 0.78, st ) * smoothstep( 0.06, 0.3, d.y ) * uCirrus * uCoverage;
    if ( alpha < 0.004 ) discard;
    vec3 v = normalize( vView );
    vec3 c = mix( uShade, uSunCol, 0.7 * uSun );
    c = mix( c, uMoonCol, 0.45 * uMoon );
    c += uSunCol * uSun * pow( max( dot( v, uSunDir ), 0.0 ), 6.0 ) * 0.8;
    c += uMoonCol * uMoon * pow( max( dot( v, uMoonDir ), 0.0 ), 30.0 ) * 1.5;
    c += moonThrough( v, alpha );
    c = mix( c, uHaze, uHazeAmt * ( 1.0 - smoothstep( 0.06, 0.35, d.y ) ) );
    gl_FragColor = vec4( c, alpha );
    #include <colorspace_fragment>
  }
`;

export function createClouds(keep: Keep, opts: CloudOptions) {
  const u = cloudUniforms();
  u.uDrift.value = THREE.MathUtils.degToRad(opts.drift ?? 0.1);
  const r = rng(opts.seed ?? 91);
  const group = new THREE.Group();
  group.name = 'clouds';

  // ---- 积云 ----
  interface One {
    a: number;
    elev: number;
    w: number;
    dist: number;
    band: CloudBand;
    puffs: Array<[number, number, number, number]>;
    opacity: number;
  }
  const all: One[] = [];
  for (const band of opts.bands) {
    const span = Math.min(band.to - band.from, Math.PI * 2);
    for (let k = 0; k < band.count; k++) {
      const pick = ([lo, hi]: [number, number]) => lo + (hi - lo) * r();
      const dist = opts.dist * (0.9 + 0.1 * r());
      all.push({
        a: band.from + ((k + 0.5) / band.count) * span + (r() - 0.5) * (span / band.count) * 0.6,
        elev: THREE.MathUtils.degToRad(pick(band.elev)),
        // 宽度按这朵自己的距离换算：看上去的大小只看比例
        w: pick(band.width) * dist * (r() < 0.5 ? -1 : 1),
        dist,
        band,
        puffs: cumulusPuffs(r, pick(band.tall)),
        opacity: pick(band.opacity ?? [0.95, 1]),
      });
    }
  }
  // 远的先画（面片都朝着中心，离中心的距离不随漂移变，这个顺序一直对）
  all.sort((x, y) => y.dist - x.dist);
  const n = all.length;
  const tex = new Float32Array(MAXP * n * 4);
  const place = new Float32Array(n * 4);
  const bandA = new Float32Array(n * 4);
  const shape = new Float32Array(n * 4);
  const rect = new Float32Array(n * 4);
  all.forEach((c, i) => {
    let x0 = 1e3;
    let x1 = -1e3;
    let y1 = 0;
    c.puffs.forEach(([x, y, rad, z], j) => {
      tex.set([x, y, rad, z], (i * MAXP + j) * 4);
      x0 = Math.min(x0, x - rad);
      x1 = Math.max(x1, x + rad);
      y1 = Math.max(y1, y + rad);
    });
    const span = Math.min(c.band.to - c.band.from, Math.PI * 2);
    place.set([c.a, c.elev, c.w, c.dist], i * 4);
    // 近的云角速度大一点（同样的风速，离得近看起来走得快）
    bandA.set([c.band.from, span >= Math.PI * 2 - 1e-3 ? 6.3 : span, opts.dist / c.dist, 0], i * 4);
    shape.set([i, (i * 0.618) % 1 * 10, c.opacity, 0], i * 4);
    // 轮廓会被噪声往外推一点，面片留一圈余量
    rect.set([x0 - 0.08, x1 + 0.08, Math.min(y1 + 0.08, 1.1), 0], i * 4);
  });
  const puffTex = keep(new THREE.DataTexture(tex, MAXP, n, THREE.RGBAFormat, THREE.FloatType));
  puffTex.needsUpdate = true;
  u.uPuffs.value = puffTex;

  const base = keep(new THREE.PlaneGeometry(2, 1));
  base.translate(0, 0.5, 0);
  const geo = keep(new THREE.InstancedBufferGeometry());
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('aPlace', new THREE.InstancedBufferAttribute(place, 4));
  geo.setAttribute('aBand', new THREE.InstancedBufferAttribute(bandA, 4));
  geo.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4));
  geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4));
  geo.instanceCount = n;
  const mat = keep(
    new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: CUMULUS_VERT,
      fragmentShader: CUMULUS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const cumulus = new THREE.Mesh(geo, mat);
  cumulus.name = 'cumulus';
  cumulus.frustumCulled = false;
  cumulus.renderOrder = -1;
  group.add(cumulus);

  // ---- 卷云 ----
  if (opts.cirrus && opts.cirrus.opacity > 0) {
    u.uCirrus.value = opts.cirrus.opacity;
    const dome = new THREE.Mesh(
      keep(new THREE.SphereGeometry(opts.cirrus.dist, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
      keep(
        new THREE.ShaderMaterial({
          uniforms: u,
          vertexShader: CIRRUS_VERT,
          fragmentShader: CIRRUS_FRAG,
          transparent: true,
          depthWrite: false,
          side: THREE.BackSide,
        }),
      ),
    );
    dome.name = 'cirrus';
    dome.frustumCulled = false;
    dome.renderOrder = -1.5;
    group.add(dome);
  }

  return {
    group,
    uniforms: u,
    update(dt: number) {
      u.uTime.value += dt;
    },
  };
}
