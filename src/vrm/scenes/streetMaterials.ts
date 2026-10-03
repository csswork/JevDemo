import * as THREE from 'three';
import { pbrTextures } from './common';
import { SEA_Y } from './seaside';

/**
 * 街景（street.ts）的材质：Poly Haven 的 PBR 贴图（漫反射 + 法线 + AO/粗糙度，和公园的木板、草地一样），
 * 再在着色器里加几笔"旧"：大尺度的深浅（打破平铺的重复感）、车道上轮胎压过的痕迹、墙根的泥、雨痕、路牙的缝、
 * 护岸贴水面那段湿的和青苔。第一版是 canvas 平涂的颜色、没有法线，和公园的实拍材质、ez-tree 的树放在一起很突兀。
 *
 * uv 都按米给（沿路的带子：u 横着、v 沿路；墙：u 沿墙、v 往上），repeat = 1 / 贴图的实际尺寸。
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

/** 着色器里加两个 varying：世界坐标 vWorld、原始 uv（米）vUv0。这些网格的 modelMatrix 都是单位阵，transformed 就是世界坐标 */
function addVaryings(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nvarying vec2 vUv0;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvUv0 = uv;');
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nvarying vec2 vUv0;');
}

const HASH = /* glsl */ `
  float streetHash( float n ) { return fract( sin( n ) * 43758.5453 ); }
`;

/**
 * 贴图按它自己的局部平均色归一（平均 = 1），再乘材质颜色：颜色和亮度由 material.color 定，贴图只给细节。
 * 实拍贴图各有各的底色（柏油偏深灰、方砖偏棕红、灰泥偏米灰），直接乘颜色要乘到 4、5 倍，对比度也跟着放大。
 * k = 细节保留多少（0 = 纯色，1 = 原样的明暗）；lo = 暗部最多到平均的多少（柏油的裂缝提亮，不要一道道黑线）。
 * 平均色取最小一级 mipmap（1×1）的那个像素：所有片元读的是同一个像素，几乎不花钱
 * （按片元自己的 uv 取低一级的 mipmap，满屏的路面、墙面每个像素都要多读一次贴图）
 */
const normMap = (k: number, lo = 0) => /* glsl */ `
  #ifdef USE_MAP
    vec3 texC = texture2D( map, vMapUv ).rgb;
    vec3 texA = textureLod( map, vec2( 0.5 ), 12.0 ).rgb;
    vec3 texN = max( texC / max( texA, vec3( 1e-4 ) ), vec3( ${lo.toFixed(2)} ) );
    diffuseColor.rgb = diffuse * mix( vec3( 1.0 ), texN, ${k.toFixed(2)} );
  #endif
`;

/**
 * 墙：灰泥的 PBR 铺在 uv1（米）上，立面图集（窗、门、梁、招牌……）按遮罩盖在上面 —— 遮罩是 0 的地方是灰泥，
 * 1 的地方是画出来的构件（构件那里不要灰泥的法线，粗糙度也换掉）。每栋的顶点色乘在最后（米白、浅灰……）。
 * 墙根 60cm 一圈溅上去的泥；每层楼板下面零星几道往下流的雨痕。
 * holes = 每一格开口的 uv 范围（streetTextures.ts 的 holeRects）：窗、店门那块挖空，真的玻璃和窗框在里面（street.ts）
 */
export function facadeMaterial(keep: Keep, atlas: { map: THREE.Texture; emissive: THREE.Texture; mask: THREE.Texture }, holes: THREE.Vector4[]) {
  const PLASTER_M = 2.23;
  const mat = keep(
    new THREE.MeshStandardMaterial({
      ...pbrTextures('plastered_wall_02', keep, { repeat: 1 / PLASTER_M, channel: 1 }),
      emissiveMap: atlas.emissive,
      emissive: 0xffffff,
      emissiveIntensity: 0.85,
      vertexColors: true,
      // 这张灰泥有一道道竖的接缝，法线和明暗都压淡（不然像竖拼的木板墙）
      normalScale: new THREE.Vector2(0.35, 0.35),
    }),
  );
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlas.map };
    shader.uniforms.uMask = { value: atlas.mask };
    shader.uniforms.uHoles = { value: holes };
    addVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uAtlas;\nuniform sampler2D uMask;\n${HOLES_GLSL}\n${HASH}`)
      .replace(
        '#include <map_fragment>',
        `if ( inHole( vEmissiveMapUv ) ) discard;
        ${normMap(0.4)}
        vec4 atlasC = texture2D( uAtlas, vEmissiveMapUv );
        float atlasM = texture2D( uMask, vEmissiveMapUv ).r;
        vec2 wallM = vMapUv * ${PLASTER_M.toFixed(2)};
        float grime = ( 1.0 - smoothstep( 0.0, 0.6, vWorld.y ) ) * 0.3;
        float col = floor( wallM.x * 4.0 );
        float streak = step( 0.7, streetHash( col * 7.31 + floor( wallM.y / 2.9 ) * 3.7 ) )
          * ( 1.0 - smoothstep( 0.05, 0.45, abs( fract( wallM.x * 4.0 ) - 0.5 ) ) )
          * smoothstep( 1.0, 0.25, fract( ( wallM.y - 0.15 ) / 2.9 ) ) * 0.16;
        vec3 plasterC = diffuseColor.rgb * ( 1.0 - grime - streak ) * mix( vec3( 1.0 ), vec3( 0.96, 0.92, 0.86 ), grime * 2.0 );
        diffuseColor.rgb = mix( plasterC, atlasC.rgb, atlasM );`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.55, atlasM );')
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * ( 1.0 - atlasM );');
  };
  mat.customProgramCacheKey = () => 'street-facade';
  return mat;
}

/** 挖洞：按 uv 算出是图集的哪一格，在那一格的开口里就丢掉（按格子查表，不用遮罩贴图：远处取 mipmap 时洞不会变形） */
const HOLES_GLSL = /* glsl */ `
  uniform vec4 uHoles[32];
  bool inHole( vec2 hu ) {
    int cellI = int( floor( hu.x * 8.0 ) ) + int( floor( ( 1.0 - hu.y ) * 4.0 ) ) * 8;
    vec4 hr = uHoles[ clamp( cellI, 0, 31 ) ];
    return hu.x > hr.x && hu.x < hr.z && hu.y > hr.y && hu.y < hr.w;
  }
`;

/** 墙投影用的深度材质：同样挖洞（阳光从窗口照进店里，地板上有窗格的光斑） */
export function facadeDepthMaterial(keep: Keep, holes: THREE.Vector4[]) {
  const mat = keep(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHoles = { value: holes };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHoleUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHoleUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vHoleUv;\n${HOLES_GLSL}`)
      .replace('void main() {', 'void main() {\n  if ( inHole( vHoleUv ) ) discard;');
  };
  mat.customProgramCacheKey = () => 'street-facade-depth';
  return mat;
}

/**
 * 屋瓦：Ceramic Roof 01 的法线和 AO 做出一排排瓦的起伏；它本来是橙红带青苔的，漫反射转成亮度、再乘每栋的瓦色（银灰、蓝灰……），
 * 日式的熏瓦带一点光泽（粗糙度压低一点）
 */
export function roofMaterial(keep: Keep) {
  const mat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('ceramic_roof_01', keep, { repeat: 1 / 3.5 }), vertexColors: true }));
  mat.color.setScalar(0.85);
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `${normMap(0.9, 0.35)}
        diffuseColor.rgb = vec3( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 0.72;');
  };
  mat.customProgramCacheKey = () => 'street-roof';
  return mat;
}

/**
 * 柏油：Asphalt 02（3m 一张，带裂缝）。偏紫的浅灰（插画里的路色）；再按 1/12 的尺度采样同一张图调深浅，
 * 远看不出平铺的格子；两条车道上各两道轮胎压过的痕迹（暗一点、更光滑），靠路牙那一溜脏一点。
 * uv：u = 离右边路沿多远（米），v = 沿路（米）
 */
export function asphaltMaterial(keep: Keep, roadHalf: number) {
  const mat = keep(
    new THREE.MeshStandardMaterial({ ...pbrTextures('asphalt_02', keep, { repeat: 1 / 3 }), color: 0xa29da8, normalScale: new THREE.Vector2(0.45, 0.45) }),
  );
  mat.onBeforeCompile = (shader) => {
    addVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `${normMap(0.75, 0.86)}
        float macro = textureLod( map, vUv0 * 0.031 + vec2( 0.37, 0.11 ), 3.0 ).g / max( texA.g, 1e-4 );
        diffuseColor.rgb *= mix( 0.9, 1.08, smoothstep( 0.7, 1.3, macro ) );
        float dd = vUv0.x - ${roadHalf.toFixed(2)};
        float tracks = 0.0;
        tracks = max( tracks, 1.0 - smoothstep( 0.12, 0.42, abs( dd - 2.15 ) ) );
        tracks = max( tracks, 1.0 - smoothstep( 0.12, 0.42, abs( dd - 0.85 ) ) );
        tracks = max( tracks, 1.0 - smoothstep( 0.12, 0.42, abs( dd + 0.85 ) ) );
        tracks = max( tracks, 1.0 - smoothstep( 0.12, 0.42, abs( dd + 2.15 ) ) );
        float edge = 1.0 - smoothstep( 0.0, 0.7, ${roadHalf.toFixed(2)} - abs( dd ) );
        diffuseColor.rgb *= ( 1.0 - 0.07 * tracks ) * ( 1.0 - 0.14 * edge );`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, roughnessFactor * 0.82, tracks );');
  };
  mat.customProgramCacheKey = () => 'street-asphalt';
  return mat;
}

/** 人行道：Square Tiles 03 放大三倍（原图是 10cm 的小方砖，铺成 30cm 的方石板），调亮、偏暖；大尺度深浅同柏油 */
export function paverMaterial(keep: Keep) {
  const mat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('square_tiles_03', keep, { repeat: 1 / 6 }), color: 0xcdc6ba }));
  mat.onBeforeCompile = (shader) => {
    addVaryings(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `${normMap(0.7)}
      float macro = textureLod( map, vUv0 * 0.017 + vec2( 0.61, 0.23 ), 3.0 ).r / max( texA.r, 1e-4 );
      diffuseColor.rgb *= mix( 0.92, 1.06, smoothstep( 0.7, 1.3, macro ) );`,
    );
  };
  mat.customProgramCacheKey = () => 'street-paver';
  return mat;
}

/**
 * 混凝土：Concrete Wall 008（2.71m 一张，带模板缝）。kind：
 *   curb     路牙：沿路每 1m 一道缝
 *   parapet  矮墙：每 1.2m 一块预制块，块之间一道缝
 *   seawall  护岸：贴水面那段湿的（暗、光滑），水线上下一溜青苔
 *   plain    电线杆、侧沟
 * 顶点色乘在上面（右边路牙顶上刷的黄线）
 */
export function concreteMaterial(keep: Keep, kind: 'curb' | 'parapet' | 'seawall' | 'plain') {
  const mat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('concrete_wall_008', keep, { repeat: 1 / 2.71 }), vertexColors: true, color: 0xc8c4bb }));
  const joints =
    kind === 'curb'
      ? 'float jt = smoothstep( 0.488, 0.497, abs( fract( vUv0.y ) - 0.5 ) ); diffuseColor.rgb *= 1.0 - 0.45 * jt;'
      : kind === 'parapet'
        ? 'float jt = smoothstep( 0.49, 0.497, abs( fract( vUv0.y / 1.2 ) - 0.5 ) ); diffuseColor.rgb *= 1.0 - 0.5 * jt;'
        : '';
  const wet =
    kind === 'seawall'
      ? `float wet = 1.0 - smoothstep( ${(SEA_Y + 0.1).toFixed(2)}, ${(SEA_Y + 1.4).toFixed(2)}, vWorld.y );
         float algae = 1.0 - smoothstep( 0.0, 0.45, abs( vWorld.y - ${(SEA_Y + 0.15).toFixed(2)} ) );
         diffuseColor.rgb *= mix( 1.0, 0.55, wet );
         diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.62, 0.86, 0.58 ), algae * 0.8 );`
      : 'float wet = 0.0;';
  mat.onBeforeCompile = (shader) => {
    addVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `${normMap(0.8)}\n${joints}\n${wet}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.32, wet );');
  };
  mat.customProgramCacheKey = () => `street-concrete-${kind}`;
  return mat;
}

/** 木头：公园那张旧木板（1.8m 一张），压暗成深棕的木梁、檐口板、阳台。顶点色调每块的深浅 */
export function woodMaterial(keep: Keep) {
  const mat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('weathered_brown_planks', keep, { repeat: 1 / 1.8 }), vertexColors: true }));
  mat.color.setRGB(0.62, 0.5, 0.42);
  return mat;
}

/** 铁件：遮阳篷的支架、旗子的铁臂、侧沟的格栅、电线杆的横担和变压器 */
export function metalMaterial(keep: Keep) {
  return keep(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.42 }));
}
