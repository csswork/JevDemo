import * as THREE from 'three';

/**
 * 海面（街景用）：专门的水面着色器。第一版是几道正弦波 + 圆点碎光，波纹规则重复、不反射天和山，颜色一整片均匀，
 * 和公园的实拍材质放在一起很假。现在：
 *
 *   波浪法线  启动时在 CPU 上生成一张可平铺的 256² 法线图（几十道顺着风向的波叠起来，波长越短越弱，近似海浪的频谱；
 *            alpha 存高度，给浪花用）。着色器里按三个尺度、三个方向滚动着采样再叠加：远看不重复，近看有细碎的涟漪。
 *            远处的细节交给 mipmap + 各向异性过滤（掠射角下解析的正弦波会闪成一片噪点），法线强度也随距离减弱
 *   平面反射  海面下面放一台镜像的相机，只渲染远景那一层（天空、云、对岸的山和小镇、灯塔、船、身后的山）到一张半分辨率的图，
 *            按波浪法线扭曲着采样（竖向扭得多：真实的倒影是竖着拉长的）。掠射角下海面倒映着山和白色小镇，最像真的就是这一步。
 *            斜裁剪平面（Lengyel 的 oblique near plane，和 three 的 Reflector 一样）把水面以下的东西裁掉
 *   菲涅耳    Schlick（F0 = 0.02）：低头看是海水本身的颜色，越往远处反射越多
 *   海水颜色  按离岸多远（启动时算一张"离护岸多远"的图）从浅处的青绿过渡到深处的蓝；迎着太阳的波面透一点光
 *   太阳高光  对着太阳的方向（转到太阳那一侧才看得到）一片碎光
 *   浪花      护岸脚下、防波堤和灯塔周围一圈白浪，随波起伏
 *
 * 反射在海面这个网格的 onBeforeRender 里渲染（和 Reflector 一样，嵌在主渲染里）。嵌套渲染也会触发场景的 beforeRender ——
 * 场景那边要看 reflecting 标记，反射那一趟不要按镜像相机去剔除合批的树（见 street.ts）
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

/** 反射只渲染这一层：远景的物体要 layers.enable(REFLECT_LAYER) */
export const REFLECT_LAYER = 1;

// ---- 波浪法线图 ----
const WAVE_N = 256;
let waveData: Uint8Array | null = null;
/**
 * 可平铺的波浪法线图（RGB = 法线，A = 高度）。波矢取整数（在 0..1 的 uv 里正好绕整数圈，四边接得上），
 * 方向集中在风向两边 ±50°，振幅 ∝ |k|^-1.6。cos(Au + Bv) 拆成 cos·cos − sin·sin，按行、按列预先算好，
 * 每个像素每道波只要两次乘法（直接算 6.5 万个像素 × 48 道波的三角函数要几十毫秒）。结果模块级缓存，换场景回来不重算
 */
function waveTexture(keep: Keep) {
  if (!waveData) {
    const N = WAVE_N;
    let seed = 20261003;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const waves: Array<{ kx: number; ky: number; a: number; ph: number }> = [];
    const wind = 0.35;
    while (waves.length < 48) {
      const len = 2 + Math.floor(rand() ** 1.6 * 26);
      const ang = wind + (rand() - 0.5) * 1.75;
      const kx = Math.round(Math.cos(ang) * len);
      const ky = Math.round(Math.sin(ang) * len);
      if (kx === 0 && ky === 0) continue;
      waves.push({ kx, ky, a: Math.hypot(kx, ky) ** -1.6, ph: rand() * Math.PI * 2 });
    }
    const h = new Float32Array(N * N);
    const gx = new Float32Array(N * N);
    const gy = new Float32Array(N * N);
    const cu = new Float32Array(N);
    const su = new Float32Array(N);
    const cv = new Float32Array(N);
    const sv = new Float32Array(N);
    for (const w of waves) {
      for (let i = 0; i < N; i++) {
        const A = (2 * Math.PI * w.kx * i) / N + w.ph;
        const B = (2 * Math.PI * w.ky * i) / N;
        cu[i] = Math.cos(A);
        su[i] = Math.sin(A);
        cv[i] = Math.cos(B);
        sv[i] = Math.sin(B);
      }
      const dx = w.a * 2 * Math.PI * w.kx;
      const dy = w.a * 2 * Math.PI * w.ky;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          // sin(A + B)、cos(A + B)
          const s = su[x] * cv[y] + cu[x] * sv[y];
          const c = cu[x] * cv[y] - su[x] * sv[y];
          const k = y * N + x;
          h[k] += w.a * s;
          gx[k] += dx * c;
          gy[k] += dy * c;
        }
      }
    }
    let hmin = Infinity;
    let hmax = -Infinity;
    for (let k = 0; k < N * N; k++) {
      hmin = Math.min(hmin, h[k]);
      hmax = Math.max(hmax, h[k]);
    }
    // 斜率换成法线：整张图的平均坡度约 0.25（再强就像碎玻璃），着色器里还会按距离再压
    const slope = 0.045;
    waveData = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) {
      const nx = -gx[k] * slope;
      const ny = -gy[k] * slope;
      const l = Math.hypot(nx, ny, 1);
      waveData[k * 4] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
      waveData[k * 4 + 1] = Math.round(((ny / l) * 0.5 + 0.5) * 255);
      waveData[k * 4 + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
      waveData[k * 4 + 3] = Math.round(((h[k] - hmin) / (hmax - hmin)) * 255);
    }
  }
  const t = keep(new THREE.DataTexture(waveData, WAVE_N, WAVE_N, THREE.RGBAFormat));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 16;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uWaves;
  uniform sampler2D uReflection;
  uniform mat4 uTextureMatrix;
  uniform sampler2D uShore;
  uniform vec4 uShoreBounds; // x0, z0, 1 / 宽, 1 / 深
  uniform float uShoreMax;
  uniform vec4 uBreakwater; // 防波堤两头的 xz
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uScatter;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>

  vec4 waves( vec2 p, float scale, vec2 dir, float speed ) {
    // 每层朝自己的方向滚动；采样坐标绕一个角度转一下，三层的格子不对齐
    vec2 uv = mat2( dir.x, -dir.y, dir.y, dir.x ) * p / scale + dir * uTime * speed;
    vec4 t = texture2D( uWaves, uv );
    return vec4( t.xyz * 2.0 - 1.0, t.a );
  }
  float segDist( vec2 p, vec2 a, vec2 b ) {
    vec2 ab = b - a;
    float t = clamp( dot( p - a, ab ) / dot( ab, ab ), 0.0, 1.0 );
    return length( p - a - ab * t );
  }

  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length( toCam );
    vec3 V = toCam / dist;
    vec2 p = vWorld.xz;

    // ---- 法线：三层叠起来（大的涌浪、中等的浪、细碎的涟漪），远处的细层衰减掉 ----
    vec4 w1 = waves( p, 31.0, normalize( vec2( 0.94, 0.34 ) ), 0.010 );
    vec4 w2 = waves( p, 11.0, normalize( vec2( 0.62, -0.78 ) ), 0.021 );
    vec4 w3 = waves( p, 3.7, normalize( vec2( -0.45, 0.89 ) ), 0.046 );
    float far = smoothstep( 25.0, 420.0, dist );
    vec2 slope = w1.xy * 1.0 + w2.xy * mix( 0.8, 0.35, far ) + w3.xy * ( 1.0 - smoothstep( 8.0, 90.0, dist ) ) * 0.55;
    slope *= mix( 1.0, 0.45, far );
    vec3 N = normalize( vec3( slope.x, 1.0, slope.y ) );
    float height = w1.a * 0.55 + w2.a * 0.3 + w3.a * 0.15;

    // ---- 菲涅耳（Schlick，F0 = 0.02）----
    // 掠射角下封顶（近处 0.82、远处 0.7）：起伏的海面不会变成一面完整的镜子（一部分微小的波面朝着别处），远处留一点海水的蓝，
    // 不然远处的海只是倒映地平线的薄雾和山脚，一片灰
    float NdotV = clamp( dot( N, V ), 0.0, 1.0 );
    float F = min( 0.02 + 0.98 * pow( 1.0 - NdotV, 5.0 ), mix( 0.82, 0.7, smoothstep( 40.0, 600.0, dist ) ) );

    // ---- 反射：镜像相机渲染的远景，按法线扭曲（竖向扭得多，倒影竖着拉长），远处扭得少 ----
    vec4 rc = uTextureMatrix * vec4( vWorld, 1.0 );
    vec2 ruv = rc.xy / rc.w;
    float k = mix( 0.035, 0.006, smoothstep( 10.0, 700.0, dist ) );
    ruv += vec2( N.x * 0.6, N.z * 1.6 ) * k;
    // 远处的波面多半斜着朝向看的人：倒影只往下（往近处）拉长，采到的是更高处的天 ——
    // 真实的海远看也是这样，倒影是竖着的长条，远处的海比"镜子里的地平线"蓝得多
    ruv.y -= length( slope ) * 0.6 * smoothstep( 20.0, 400.0, dist );
    // 倒影往蓝里推一点（水面会吸掉一点红光）
    vec3 refl = texture2D( uReflection, ruv ).rgb * vec3( 0.86, 0.95, 1.05 );

    // ---- 海水本身：离护岸越远越深；迎着太阳的波面透一点青绿的光 ----
    vec2 suv = ( p - uShoreBounds.xy ) * uShoreBounds.zw;
    float shore = ( suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0 ) ? 1.0 : texture2D( uShore, suv ).r;
    float shoreM = shore * uShoreMax;
    vec3 body = mix( uShallow, uDeep, smoothstep( 1.0, 9.0, shoreM ) );
    vec3 sunH = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) );
    float thru = pow( clamp( dot( V, -sunH ) * 0.5 + 0.5, 0.0, 1.0 ), 3.0 ) * clamp( height * 1.6 - 0.4, 0.0, 1.0 );
    body += uScatter * thru * 0.35;
    // 天光照着的水体：上半球的漫反射（不然背光那一侧发黑）
    body *= 0.75 + 0.35 * N.y;

    vec3 col = mix( body, refl, F );

    // ---- 太阳的高光：一大片柔的 + 很窄的碎光 ----
    vec3 H = normalize( uSunDir + V );
    float nh = max( dot( N, H ), 0.0 );
    col += uSunColor * ( pow( nh, 900.0 ) * 30.0 + pow( nh, 90.0 ) * 0.35 ) * smoothstep( 0.0, 0.1, uSunDir.y );

    // ---- 浪花：护岸脚下一圈、防波堤和灯塔四周一圈，按波高起伏，近处才有 ----
    float wall = shoreM;
    float bw = segDist( p, uBreakwater.xy, uBreakwater.zw ) - 1.7;
    float edge = min( wall, max( bw, 0.0 ) );
    // 一道 1~3m 宽、随浪涌进退的白浪，按细浪的高度碎成一块块；贴着墙的那 30cm 一直是白的
    float surge = 0.5 + 0.5 * sin( uTime * 0.9 + p.x * 0.11 + p.y * 0.07 );
    // 阈值收窄：碎成一块块、一缕缕（阈值宽的话是一整片平滑的发白，看上去只是水浅）
    float breakup = smoothstep( 0.56, 0.62, w3.a * 0.55 + w2.a * 0.3 + 0.25 * surge );
    float foam = ( 1.0 - smoothstep( 0.0, 1.2 + 1.8 * surge, edge ) ) * breakup;
    foam = max( foam, ( 1.0 - smoothstep( 0.0, 0.3, edge ) ) * 0.9 );
    foam *= 1.0 - smoothstep( 120.0, 380.0, dist );
    col = mix( col, vec3( 0.92, 0.95, 0.97 ), foam * 0.85 );

    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // 雾只按一半算：场景的雾是给山和对岸的小镇的，海面整片都在雾里的话远处发白，插画里的海一直到对岸都是饱和的蓝
    #ifdef USE_FOG
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth ) * 0.5;
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif
  }
`;

export interface WaterOptions {
  /** 海面高度（世界 y） */
  y: number;
  /** 高光按哪个方向的太阳算（指向太阳的单位向量） */
  sunDir: THREE.Vector3;
  sunColor?: THREE.Color;
  /** 离岸距离图：bounds = [x0, z0, x1, z1]，dist(x, z) = 这一点离护岸多远（米，陆地上 ≤ 0），最远存到 max 米 */
  shore: { bounds: [number, number, number, number]; resolution: number; max: number; dist: (x: number, z: number) => number };
  /** 防波堤两头（xz），四周有浪花 */
  breakwater: [[number, number], [number, number]];
  /** 反射图是画布的几分之一（默认 0.5） */
  reflectionScale?: number;
}

export function createWater(keep: Keep, o: WaterOptions) {
  // 离岸距离图：只算一次
  const R = o.shore.resolution;
  const [x0, z0, x1, z1] = o.shore.bounds;
  const sd = new Uint8Array(R * R);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const x = x0 + ((i + 0.5) / R) * (x1 - x0);
      const z = z0 + ((j + 0.5) / R) * (z1 - z0);
      sd[j * R + i] = Math.round(THREE.MathUtils.clamp(o.shore.dist(x, z) / o.shore.max, 0, 1) * 255);
    }
  }
  const shoreTex = keep(new THREE.DataTexture(sd, R, R, THREE.RedFormat));
  shoreTex.magFilter = THREE.LinearFilter;
  shoreTex.minFilter = THREE.LinearFilter;
  shoreTex.needsUpdate = true;

  const rt = keep(new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType }));
  const textureMatrix = new THREE.Matrix4();
  const mat = keep(
    new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uWaves: { value: null },
          uReflection: { value: null },
          uTextureMatrix: { value: new THREE.Matrix4() },
          uShore: { value: null },
          uShoreBounds: { value: new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)) },
          uShoreMax: { value: o.shore.max },
          uBreakwater: { value: new THREE.Vector4(o.breakwater[0][0], o.breakwater[0][1], o.breakwater[1][0], o.breakwater[1][1]) },
          uSunDir: { value: o.sunDir.clone().normalize() },
          uSunColor: { value: o.sunColor ?? new THREE.Color(1, 0.92, 0.78) },
          uDeep: { value: new THREE.Color(0x1d66a6) },
          uShallow: { value: new THREE.Color(0x17707c) },
          uScatter: { value: new THREE.Color(0x1f9a9a) },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
    }),
  );
  // merge 会克隆 uniform 的值：贴图、矩阵直接挂回同一个对象
  mat.uniforms.uWaves.value = waveTexture(keep);
  mat.uniforms.uReflection.value = rt.texture;
  mat.uniforms.uTextureMatrix.value = textureMatrix;
  mat.uniforms.uShore.value = shoreTex;

  const geo = keep(new THREE.PlaneGeometry(6000, 6000));
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = o.y;
  mesh.name = 'sea';

  // ---- 平面反射（照 three 的 Reflector 改的：只渲染远景那一层，嵌在主渲染里）----
  const state = { reflecting: false };
  const mirror = new THREE.PerspectiveCamera();
  mirror.layers.set(REFLECT_LAYER);
  const normal = new THREE.Vector3(0, 1, 0);
  const planePoint = new THREE.Vector3(0, o.y, 0);
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const target = new THREE.Vector3();
  const view = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const plane = new THREE.Plane();
  const clip = new THREE.Vector4();
  const q = new THREE.Vector4();
  const size = new THREE.Vector2();
  const scale = o.reflectionScale ?? 0.5;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    if (state.reflecting || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    const cam = camera as THREE.PerspectiveCamera;
    renderer.getDrawingBufferSize(size);
    const w = Math.max(16, Math.round(size.x * scale));
    const h = Math.max(16, Math.round(size.y * scale));
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    camPos.setFromMatrixPosition(cam.matrixWorld);
    // 相机在水面以下（不会发生，防穿墙挡着）就不画
    if (camPos.y <= o.y) return;
    // 镜像相机：位置、视线、上方向都按水面翻过去
    view.subVectors(planePoint, camPos).reflect(normal).negate().add(planePoint);
    rot.extractRotation(cam.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(planePoint, lookAt).reflect(normal).negate().add(planePoint);
    mirror.position.copy(view);
    mirror.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    mirror.lookAt(target);
    mirror.far = cam.far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(cam.projectionMatrix);
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
    // 斜裁剪：把近平面换成水面，水面以下的（对岸山脚泡在水里的部分、护岸的下半截）不进反射
    plane.setFromNormalAndCoplanarPoint(normal, planePoint).applyMatrix4(mirror.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = mirror.projectionMatrix.elements;
    q.set((Math.sign(clip.x) + pm[8]) / pm[0], (Math.sign(clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1;
    pm[14] = clip.w;
    mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    state.reflecting = true;
    mesh.visible = false;
    renderer.setRenderTarget(rt);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, mirror);
    renderer.setRenderTarget(prevTarget);
    mesh.visible = true;
    state.reflecting = false;
    renderer.shadowMap.autoUpdate = prevShadow;
  };

  return {
    mesh,
    /** 正在渲染反射（嵌套渲染里场景的 beforeRender 要跳过合批的剔除） */
    get reflecting() {
      return state.reflecting;
    },
    update(time: number) {
      mat.uniforms.uTime.value = time;
    },
  };
}
