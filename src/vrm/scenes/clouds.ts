import * as THREE from 'three';

/**
 * 天上的积云（街景、公园共用）：Blender 里做的体积云（scripts/blender/clouds.py），从六个方向各打一次光渲染成贴图，
 * 这里按太阳 / 月亮的方向把六张光照混起来（游戏里常用的"六向光照"云片），再乘上调色表的颜色。
 *
 * 贴图（public/scene/clouds/）：8 朵云，一格 1024×512，2 列 4 行。三张 RGB（浏览器解码带透明通道的图会预乘、
 * 透明处的颜色全丢，所以不用透明通道），存的是开方后的值：
 *   a = 光从右 / 左 / 上来    b = 光从下 / 前（看的人这边）/ 后（云背后）来    c = 天光、不透明度
 * 都是预乘过透明度的（Cycles 透明背景渲出来的），按预乘混合画（premultipliedAlpha）。
 *
 * 光照：光的方向换到云片自己的坐标里（x 向右、y 向上、z 朝着看的人），每个轴按分量的平方分给正 / 负那一张
 * （三个分量平方和是 1，混出来的亮度守恒）。光在云背后时用"后"那张 —— 薄的边缘透光变亮（金边 / 银边）是渲染里真的算出来的。
 * 颜色 = 主光色 × 方向光 + 背光色（天光）× 天光那张 + 云底被地上映亮（夜里小镇的灯，用"下"那张）。
 *
 * 移动：每一组（band）的云绕着场景中心往同一个方向漂（近的云角速度大一点）。组的方位角范围不满一圈时，
 * 飘到尽头的云从薄的地方开始慢慢消散、从另一头重新长出来。
 * 月亮附近的云薄一些、透出月光，月亮不会被整块挡死。所有云一个实例化网格、一次绘制。
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

const BASE_URL = `${import.meta.env.BASE_URL}scene/clouds/`;

export type CloudKind = 'tall' | 'mid' | 'flat';

export interface CloudBand {
  /** 方位角范围（弧度，atan2(z, x)）；to - from ≥ 2π 时首尾相接，云不消散 */
  from: number;
  to: number;
  count: number;
  /** 云片底边的高度角（度） */
  elev: [number, number];
  /** 云片的宽，按离中心的距离算的比例（云本身大约占云片宽的七成） */
  width: [number, number];
  /** 用哪几种云（贴图集里按 clouds.json 的 kinds 挑） */
  kinds: CloudKind[];
  opacity?: [number, number];
}

export interface CloudOptions {
  /** 云离中心多远（各朵在 0.96~1 倍之间错开，近的画在前面）。要比远山远，不然会盖到山前面 */
  dist: number;
  bands: CloudBand[];
  seed?: number;
  /** 风：每秒绕中心走多少度（正数 = 方位角变大的方向） */
  drift?: number;
}

export function cloudUniforms() {
  return {
    uTime: { value: 0 },
    uDrift: { value: 0 },
    /** 主光（白天太阳、夜里月亮）的方向、照亮那一面的颜色 */
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uKeyCol: { value: new THREE.Color(1, 1, 1) },
    /** 天光（背光面）的颜色 */
    uShade: { value: new THREE.Color(0xb7c7e2) },
    /** 云底被地上映亮的颜色（夜里小镇的灯） */
    uBelow: { value: new THREE.Color(0, 0, 0) },
    /** 贴着地平线的云往这个颜色里融多少 */
    uHaze: { value: new THREE.Color(0xd3e8f5) },
    uHazeAmt: { value: 0.3 },
    /** 月亮在哪、在天上显不显（0..1）：月亮附近的云变薄、透出一团光 */
    uMoonDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    uMoonGlow: { value: 0 },
    /** 整体的云量（不透明度的倍数） */
    uCoverage: { value: 1 },
    /** 方向光、天光乘多少（贴图里是按最亮的千分之一归一化的：正面受光的云面只有 0.45 左右） */
    uKeyGain: { value: 3.0 },
    uSkyGain: { value: 0.3 },
    uA: { value: null as THREE.Texture | null },
    uB: { value: null as THREE.Texture | null },
    uC: { value: null as THREE.Texture | null },
    uGrid: { value: new THREE.Vector2(2, 4) },
  };
}
export type CloudUniforms = ReturnType<typeof cloudUniforms>;

const VERT = /* glsl */ `
  uniform float uTime, uDrift;
  uniform vec3 uKeyDir;
  uniform vec2 uGrid;
  attribute vec4 aPlace; // 起始方位角、底边的高度角（弧度）、宽（负数 = 左右翻过来）、离中心多远
  attribute vec4 aBand;  // 组的起始方位角、方位角范围（≥ 2π = 一整圈）、角速度的倍数
  attribute vec4 aLook;  // 第几格、不透明度
  varying vec2 vUv;
  varying vec3 vDir, vL;
  varying float vLife, vOpacity;
  void main() {
    float span = aBand.y;
    float u = mod( aPlace.x - aBand.x + uDrift * aBand.z * uTime, span );
    float a = aBand.x + u;
    vLife = span >= 6.28 ? 1.0 : smoothstep( 0.0, 0.1, u / span ) * smoothstep( 1.0, 0.9, u / span );
    float w = aPlace.z;
    vec3 out_ = vec3( cos( a ), 0.0, sin( a ) );
    vec3 right = vec3( -sin( a ), 0.0, cos( a ) ) * sign( w );
    vec3 C = vec3( out_.x * cos( aPlace.y ), sin( aPlace.y ), out_.z * cos( aPlace.y ) ) * aPlace.w;
    vec3 wp = C + ( right * position.x + vec3( 0.0, position.y, 0.0 ) ) * abs( w ) * 0.5;
    float cell = aLook.x;
    float col = mod( cell, uGrid.x );
    float row = floor( cell / uGrid.x );
    vUv = vec2( ( col + position.x * 0.5 + 0.5 ) / uGrid.x, 1.0 - ( row + 1.0 - position.y ) / uGrid.y );
    vOpacity = aLook.y;
    vec4 world = modelMatrix * vec4( wp, 1.0 );
    vDir = world.xyz - cameraPosition;
    // 光的方向换到云片的坐标里（x 向右、y 向上、z 朝着看的人）
    vL = vec3( dot( uKeyDir, right ), uKeyDir.y, -dot( uKeyDir, out_ ) );
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uA, uB, uC;
  uniform vec3 uKeyDir, uKeyCol, uShade, uBelow, uHaze, uMoonDir;
  uniform float uHazeAmt, uMoonGlow, uCoverage, uKeyGain, uSkyGain;
  varying vec2 vUv;
  varying vec3 vDir, vL;
  varying float vLife, vOpacity;
  void main() {
    vec3 a = texture2D( uA, vUv ).rgb;
    vec3 b = texture2D( uB, vUv ).rgb;
    vec2 c2 = texture2D( uC, vUv ).rg;
    a *= a;
    b *= b;
    c2 *= c2;
    float alpha = c2.y;
    if ( alpha < 0.002 ) discard;
    // 预乘的颜色不能比不透明度大（Cycles 的降噪会把颜色往透明的地方抹出去一点）
    a = min( a, vec3( alpha ) );
    b = min( b, vec3( alpha ) );
    c2.x = min( c2.x, alpha );
    // 六向光照：每个轴按分量的平方分给正 / 负那一张。
    // "后"那张是光正好在云背后渲的（透过来的光最多）：真的云往前散射得很集中，离光源远的云银边弱得多
    vec3 v = normalize( vDir );
    vec3 L = normalize( vL );
    vec3 L2 = L * L;
    float back = b.b * mix( 0.1, 0.3, pow( max( dot( v, uKeyDir ), 0.0 ), 12.0 ) );
    float lit = L2.x * ( L.x > 0.0 ? a.r : a.g ) + L2.y * ( L.y > 0.0 ? a.b : b.r ) + L2.z * ( L.z > 0.0 ? b.g : back );
    vec3 col = uKeyCol * lit * uKeyGain + uShade * c2.x * uSkyGain + uBelow * b.r;
    // 刚长出来 / 快消散的云：薄的地方先没
    float k = smoothstep( ( 1.0 - vLife ) * 0.9, ( 1.0 - vLife ) * 0.9 + 0.2, alpha ) * vOpacity * uCoverage;
    // 月亮附近的云薄一些（最多薄一半），再加一团透出来的光
    float md = max( dot( v, uMoonDir ), 0.0 );
    k *= 1.0 - 0.5 * uMoonGlow * smoothstep( 0.9975, 0.99994, md );
    col *= k;
    alpha *= k;
    col += vec3( 0.75, 0.82, 1.0 ) * ( pow( md, 3000.0 ) * 1.0 + pow( md, 250.0 ) * 0.3 ) * uMoonGlow * alpha;
    // 贴着地平线的融进天色（预乘：雾色也乘不透明度）
    col = mix( col, uHaze * alpha, uHazeAmt * ( 1.0 - smoothstep( 0.02, 0.25, v.y ) ) );
    // 颜色空间转换（线性 → sRGB）不是线性的：要先除掉不透明度、转完再乘回去，
    // 直接转预乘的颜色，半透明的边上会亮出一圈
    gl_FragColor = vec4( col / max( alpha, 1e-4 ), alpha );
    #include <colorspace_fragment>
    gl_FragColor.rgb *= alpha;
  }
`;

interface Meta {
  cols: number;
  rows: number;
  count: number;
  kinds: CloudKind[];
}

export function createClouds(keep: Keep, opts: CloudOptions, alive: () => boolean = () => true) {
  const u = cloudUniforms();
  u.uDrift.value = THREE.MathUtils.degToRad(opts.drift ?? 0.1);
  let s = opts.seed ?? 91;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const group = new THREE.Group();
  group.name = 'clouds';

  const mat = keep(
    new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );

  // 贴图和 clouds.json 都到了再建网格（哪一格是什么云要看 json）
  const loader = new THREE.TextureLoader();
  const load = (name: string) =>
    loader.loadAsync(`${BASE_URL}${name}`).then((t) => {
      keep(t);
      t.anisotropy = 4;
      return t;
    });
  Promise.all([fetch(`${BASE_URL}clouds.json`).then((x) => x.json() as Promise<Meta>), load('clouds_a.webp'), load('clouds_b.webp'), load('clouds_c.webp')])
    .then(([meta, ta, tb, tc]) => {
      if (!alive()) return;
      u.uA.value = ta;
      u.uB.value = tb;
      u.uC.value = tc;
      u.uGrid.value.set(meta.cols, meta.rows);
      group.add(build(meta));
    })
    .catch((e) => console.warn('云的贴图没载入：', e));

  function build(meta: Meta) {
    const byKind = (k: CloudKind) => meta.kinds.flatMap((x, i) => (x === k ? [i] : []));
    const all: Array<{ place: number[]; band: number[]; look: number[]; dist: number }> = [];
    for (const b of opts.bands) {
      const span = Math.min(b.to - b.from, Math.PI * 2);
      const cells = b.kinds.flatMap(byKind);
      for (let k = 0; k < b.count; k++) {
        const pick = ([lo, hi]: [number, number]) => lo + (hi - lo) * r();
        const d = opts.dist * (0.96 + 0.04 * r());
        const a = b.from + ((k + 0.5) / b.count) * span + (r() - 0.5) * (span / b.count) * 0.6;
        all.push({
          place: [a, THREE.MathUtils.degToRad(pick(b.elev)), pick(b.width) * d * (r() < 0.5 ? -1 : 1), d],
          // 近的云角速度大一点（同样的风速，离得近看起来走得快）
          band: [b.from, span >= Math.PI * 2 - 1e-3 ? 6.3 : span, opts.dist / d, 0],
          look: [cells[(k + Math.floor(r() * cells.length)) % cells.length], pick(b.opacity ?? [0.95, 1]), 0, 0],
          dist: d,
        });
      }
    }
    // 远的先画（云片都朝着中心，离中心的距离不随漂移变，这个顺序一直对）
    all.sort((x, y) => y.dist - x.dist);
    const base = keep(new THREE.PlaneGeometry(2, 1));
    base.translate(0, 0.5, 0);
    const geo = keep(new THREE.InstancedBufferGeometry());
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const attr = (k: 'place' | 'band' | 'look') => new THREE.InstancedBufferAttribute(new Float32Array(all.flatMap((c) => c[k])), 4);
    geo.setAttribute('aPlace', attr('place'));
    geo.setAttribute('aBand', attr('band'));
    geo.setAttribute('aLook', attr('look'));
    geo.instanceCount = all.length;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'cumulus';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    // 后加进来的：要和组里其它东西一样进海面反射那一层
    mesh.layers.mask = group.layers.mask;
    return mesh;
  }

  return {
    group,
    uniforms: u,
    update(dt: number) {
      u.uTime.value += dt;
    },
  };
}
