import * as THREE from 'three';

/**
 * 高空的卷云（街景、公园共用）：一缕缕顺着风拉长的细丝，着色器里用噪声画在一个半球上（只在天空的上半部分），随风慢慢移动。
 *
 *   形状  天上一层平面（方向 d 投到 d.xz / d.y）：离地平线越近看到的越远、越密。先用低频噪声分出一片一片
 *         （不是满天都有），片里再用顺着风向拉长的分形噪声画丝缕
 *   颜色  很薄，几乎全是被照亮的颜色（主光色和背光色七三开），朝着光源的那边更亮；贴着地平线的融进地平线的颜色
 *   月亮  月亮附近的薄一些
 *
 * 颜色由场景每帧给（uniforms），线性空间；不吃雾，不做色调映射（和天空一样）。
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

export interface CirrusOptions {
  /** 画在多远：要在天空球前面（远景、山都在它前面） */
  dist: number;
  /** 不透明度 */
  opacity: number;
}

export function cirrusUniforms() {
  return {
    uTime: { value: 0 },
    /** 风：在"天上那一层平面"上每秒移多少 */
    uWind: { value: new THREE.Vector2(0.0016, 0.0007) },
    uCirrus: { value: 0 },
    /** 主光（白天太阳、夜里月亮）的方向、照亮那一面的颜色 */
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uKeyCol: { value: new THREE.Color(1, 1, 1) },
    /** 背光面（天光）的颜色 */
    uShade: { value: new THREE.Color(0xb7c7e2) },
    /** 贴着地平线的往这个颜色里融多少 */
    uHaze: { value: new THREE.Color(0xd3e8f5) },
    uHazeAmt: { value: 0.3 },
    /** 月亮在哪、在天上显不显（0..1）：月亮附近的薄一些 */
    uMoonDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    uMoonGlow: { value: 0 },
  };
}
export type CirrusUniforms = ReturnType<typeof cirrusUniforms>;

const VERT = /* glsl */ `
  varying vec3 vDir, vView;
  void main() {
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vDir = normalize( position );
    vView = world.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime, uCirrus, uHazeAmt, uMoonGlow;
  uniform vec2 uWind;
  uniform vec3 uKeyDir, uKeyCol, uShade, uHaze, uMoonDir;
  varying vec3 vDir, vView;
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
    float alpha = pat * smoothstep( 0.42, 0.78, st ) * smoothstep( 0.06, 0.3, d.y ) * uCirrus;
    if ( alpha < 0.004 ) discard;
    vec3 v = normalize( vView );
    // 很薄：几乎全是被照亮的颜色，朝着光源那边更亮
    vec3 c = mix( uShade, uKeyCol, 0.7 ) + uKeyCol * pow( max( dot( v, uKeyDir ), 0.0 ), 8.0 ) * 0.6;
    float md = max( dot( v, uMoonDir ), 0.0 );
    alpha *= 1.0 - 0.5 * uMoonGlow * smoothstep( 0.9975, 0.99994, md );
    c = mix( c, uHaze, uHazeAmt * ( 1.0 - smoothstep( 0.06, 0.35, d.y ) ) );
    gl_FragColor = vec4( c, alpha );
    #include <colorspace_fragment>
  }
`;

export function createCirrus(keep: Keep, opts: CirrusOptions) {
  const u = cirrusUniforms();
  u.uCirrus.value = opts.opacity;
  const mesh = new THREE.Mesh(
    keep(new THREE.SphereGeometry(opts.dist, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
    keep(new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.BackSide })),
  );
  mesh.name = 'cirrus';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1.5;
  return {
    mesh,
    uniforms: u,
    update(dt: number) {
      u.uTime.value += dt;
    },
  };
}
