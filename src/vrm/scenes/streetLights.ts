import * as THREE from 'three';

/**
 * 街景夜里的灯（路灯、店门口、窗户透出来的光、售货机、船灯、灯塔、对岸的灯点……）。
 * 所有光源登记成一个列表（LightAnchor），分三档画：
 *
 *   1. 真实的点光源：固定 4 盏（Backdrop.lights，数量永远不变 —— 增删灯会让所有材质重新编译、卡一下），
 *      每帧分给离角色最近、最亮的几个光源，白天强度是 0。只有这一档照得到角色（MToon 认点光源）
 *   2. 街道材质里的轻量灯：往立面、路面、人行道、混凝土、木件、铁件……的着色器里注入一段循环（lampLit），
 *      算离角色最近的 32 个光源的漫反射（和 three 的点光源同一个衰减公式），路面上的光斑、墙上被照亮的那一圈都是它
 *   3. 光晕：每个光源一张朝着相机的柔和光斑，全部在一个 InstancedMesh 里（加法混合，跟着雾淡掉），
 *      也加进海面的反射层 —— 海面上拉长的倒影光柱就是它
 *
 * 灯的亮法：天黑到一定程度（lightsOn 过了这盏的 onAt）就亮，每盏的 onAt 错开一点（一盏一盏陆续亮起来），
 * 亮的那一下闪几下；店里的灯还按营业时间（hours）开关；航行灯、航空灯按节奏闪（blink）
 */

export interface LightAnchor {
  /** 世界坐标（follow 了某个物体就是它的局部坐标） */
  pos: THREE.Vector3;
  /** 线性空间的颜色 */
  color: THREE.Color;
  /** 发光强度（坎德拉，和 three 的点光源一样：照度 = 强度 / 距离²） */
  intensity: number;
  /** 照多远（米）；0 = 只有光晕，不照东西 */
  radius: number;
  /** 光晕多大（米）；0 = 没有光晕 */
  glow: number;
  /** 光晕的亮度（默认 1） */
  glowGain?: number;
  /** 天黑到多少（0..1 的 lightsOn）才亮；默认 0.3 */
  onAt?: number;
  /** 只在这段钟点里亮（太阳时，[开, 关)，可以跨过午夜：[17, 1]） */
  hours?: [number, number];
  /** 跟着某个物体动（船） */
  follow?: THREE.Object3D;
  /** 闪：周期（秒）、亮的比例、相位 */
  blink?: [number, number, number];
}

interface Live {
  a: LightAnchor;
  on: boolean;
  /** 刚亮起来过了多久（秒）：前 0.6 秒闪几下 */
  t: number;
  /** 这一帧的亮度 0..1 */
  f: number;
  world: THREE.Vector3;
  id: number;
}

/** 轻量灯最多几个（着色器里的循环上限） */
export const LAMP_MAX = 32;
/** 真实点光源几盏 */
const REAL = 4;
const GLOW_CAP = 1024;

export type LampUniforms = ReturnType<typeof lampUniforms>;
function lampUniforms() {
  return {
    uLampPos: { value: Array.from({ length: LAMP_MAX }, () => new THREE.Vector4()) },
    uLampCol: { value: Array.from({ length: LAMP_MAX }, () => new THREE.Vector3()) },
    uLampCount: { value: 0 },
  };
}

/**
 * 给一个材质加上轻量灯（第 2 档）。要在材质自己的 onBeforeCompile 设好之后调：接在它后面，
 * 缓存键也接在它原来的键后面（不能用默认的键：默认是 onBeforeCompile 的源码，换成这里的包装以后所有材质都一样，会共用错的程序）
 */
export function lampLit(mat: THREE.Material, u: LampUniforms) {
  const prev = mat.onBeforeCompile;
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.uLampPos = u.uLampPos;
    shader.uniforms.uLampCol = u.uLampCol;
    shader.uniforms.uLampCount = u.uLampCount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLampW;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 lw = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            lw = instanceMatrix * lw;
          #endif
          vLampW = ( modelMatrix * lw ).xyz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLampW;
        uniform vec4 uLampPos[ ${LAMP_MAX} ];
        uniform vec3 uLampCol[ ${LAMP_MAX} ];
        uniform int uLampCount;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // 轻量灯：只算漫反射，衰减和 three 的点光源一样（1/d²，到 radius 平滑地收到 0）
          vec3 nW = inverseTransformDirection( normal, viewMatrix );
          for ( int i = 0; i < ${LAMP_MAX}; i ++ ) {
            if ( i >= uLampCount ) break;
            vec4 lp = uLampPos[ i ];
            vec3 L = lp.xyz - vLampW;
            float d = length( L );
            if ( d >= lp.w ) continue;
            float att = pow2( saturate( 1.0 - pow4( d / lp.w ) ) ) / max( d * d, 0.01 );
            reflectedLight.directDiffuse += BRDF_Lambert( material.diffuseColor ) * uLampCol[ i ] * ( saturate( dot( nW, L / d ) ) * att );
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => `${key}|lamps`;
}

const GLOW_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute vec4 aGlow;
  uniform float uPixel;
  varying vec3 vCol;
  varying vec2 vUv;
  void main() {
    vec3 center = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    vec4 mvPosition = viewMatrix * vec4( center, 1.0 );
    float dist = max( -mvPosition.z, 0.01 );
    // 远处的灯至少 7 个像素（不然一个亮点时有时无地闪）；放大了就按面积摊薄一点
    float size = max( aGlow.a, uPixel * dist * 7.0 );
    vCol = aGlow.rgb * mix( 1.0, aGlow.a / size, 0.6 );
    // 往相机那边挪一点：别插进灯罩、墙里
    mvPosition.xyz += normalize( -mvPosition.xyz ) * min( aGlow.a * 0.5, 0.8 );
    mvPosition.xy += position.xy * size;
    vUv = position.xy * 2.0;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const GLOW_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  varying vec3 vCol;
  varying vec2 vUv;
  void main() {
    float r2 = dot( vUv, vUv );
    if ( r2 > 1.0 ) discard;
    float shape = exp( -r2 * 16.0 ) + exp( -r2 * 4.0 ) * 0.28;
    vec3 c = vCol * shape * ( 1.0 - r2 );
    #ifdef USE_FOG
      c *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor = vec4( c, 1.0 );
    #include <colorspace_fragment>
  }
`;

const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};
/** 钟点 h 在不在 [a, b) 里（可以跨过午夜） */
const inHours = (h: number, [a, b]: [number, number]) => (a <= b ? h >= a && h < b : h >= a || h < b);

export function createLights(keep: <T extends { dispose(): void }>(x: T) => T, opts: { focus: THREE.Vector3; reflectLayer: number }) {
  const lives: Live[] = [];
  const uniforms = lampUniforms();
  const real = Array.from({ length: REAL }, () => {
    const l = new THREE.PointLight(0xffffff, 0, 10, 2);
    l.castShadow = false;
    return l;
  });

  // ---- 光晕 ----
  const quad = keep(new THREE.PlaneGeometry(1, 1));
  const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAP * 4), 4);
  glowAttr.setUsage(THREE.DynamicDrawUsage);
  quad.setAttribute('aGlow', glowAttr);
  const glowUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixel: { value: 0.001 } }]);
  const glowMat = keep(
    new THREE.ShaderMaterial({
      uniforms: glowUniforms,
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }),
  );
  const glow = keep(new THREE.InstancedMesh(quad, glowMat, GLOW_CAP));
  glow.count = 0;
  glow.frustumCulled = false;
  glow.renderOrder = 2;
  glow.layers.enable(opts.reflectLayer);
  glow.name = 'light-glows';
  const m4 = new THREE.Matrix4();
  let glowDirty = true;

  const add = (a: LightAnchor) => {
    if (lives.length >= GLOW_CAP) return;
    const id = lives.length;
    lives.push({ a, on: false, t: 0, f: 0, world: a.pos.clone(), id });
    glowDirty = true;
  };

  /** 每帧：lightsOn = 天黑了多少（0..1），hour = 几点，time = 秒（闪烁用），jump = 时间是跳过去的（截图）—— 不闪 */
  const pick: Live[] = [];
  const update = (lightsOn: number, hour: number, time: number, dt: number, jump: boolean) => {
    for (const L of lives) {
      const a = L.a;
      const want = lightsOn > (a.onAt ?? 0.3) && (!a.hours || inHours(hour, a.hours));
      if (want && !L.on) {
        L.on = true;
        L.t = jump ? 1 : 0;
      } else if (!want) L.on = false;
      L.t += dt;
      let f = L.on ? 1 : 0;
      // 刚亮的 0.6 秒：闪几下（荧光灯、老路灯启动的样子）
      if (L.on && L.t < 0.6) f = hash(Math.floor(time * 22) + L.id * 7.3) > 0.45 ? Math.min(1, L.t * 6) : 0.15;
      if (a.blink) {
        const [period, duty, ph] = a.blink;
        const k = (((time + ph) % period) + period) % period;
        f *= k < period * duty ? 1 : 0.04;
      }
      L.f = f;
      if (a.follow) L.world.copy(a.pos).applyMatrix4(a.follow.matrixWorld);
    }

    // 第 1 档：离角色最近、最亮的 4 个
    pick.length = 0;
    for (const L of lives) if (L.f > 0.01 && L.a.radius > 0) pick.push(L);
    const score = (L: Live) => (L.a.intensity * L.f) / Math.max(1, L.world.distanceToSquared(opts.focus));
    pick.sort((x, y) => score(y) - score(x));
    for (let i = 0; i < REAL; i++) {
      const l = real[i];
      const L = pick[i];
      if (!L) {
        l.intensity = 0;
        continue;
      }
      l.position.copy(L.world);
      l.color.copy(L.a.color);
      l.intensity = L.a.intensity * L.f;
      l.distance = L.a.radius;
    }
    // 第 2 档：接下来的 32 个（真实点光源照过的不再算）
    let n = 0;
    for (let i = REAL; i < pick.length && n < LAMP_MAX; i++) {
      const L = pick[i];
      uniforms.uLampPos.value[n].set(L.world.x, L.world.y, L.world.z, L.a.radius);
      uniforms.uLampCol.value[n].set(L.a.color.r, L.a.color.g, L.a.color.b).multiplyScalar(L.a.intensity * L.f);
      n++;
    }
    uniforms.uLampCount.value = n;

    // 第 3 档：光晕
    const arr = glowAttr.array as Float32Array;
    for (const L of lives) {
      const a = L.a;
      const g = a.glow > 0 ? L.f * (a.glowGain ?? 1) : 0;
      arr[L.id * 4] = a.color.r * g;
      arr[L.id * 4 + 1] = a.color.g * g;
      arr[L.id * 4 + 2] = a.color.b * g;
      arr[L.id * 4 + 3] = a.glow;
      if (a.follow || glowDirty) glow.setMatrixAt(L.id, m4.makeTranslation(L.world));
    }
    glow.count = lives.length;
    glow.visible = lightsOn > 0.001;
    glow.instanceMatrix.needsUpdate = true;
    glowAttr.needsUpdate = true;
    glowDirty = false;
  };

  return {
    add,
    uniforms,
    /** 4 盏真实点光源：交给 Backdrop.lights */
    real,
    glow,
    update,
    /** 每次渲染前：1 个像素在 1m 远处多大（光晕的最小尺寸），按这次的相机 */
    setPixel(fovDeg: number, heightPx: number) {
      glowUniforms.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) / Math.max(1, heightPx);
    },
    get count() {
      return lives.length;
    },
  };
}
