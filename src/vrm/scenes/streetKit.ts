import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LightAnchor } from './streetLights';

/**
 * Blender 做的街景模型（scripts/blender/ 的脚本导出的 GLB）怎么接进来：
 *
 *   loadKit      载入一个 GLB，按顶层物体的名字拆成"零件"（每个材质槽一份几何体 + 它在物体里的变换）
 *                和"标记点"（空物体：光源 light…、电线的挂点 wire… 等，自定义属性在 userData 里）
 *   kitMaterials 材质槽的名字 → 街景的材质（Blender 那边只给顶点色和一个槽名，质感全用街景已有的 PBR 材质，
 *                整条街一个材质一次绘制）。glow = 夜里才亮的灯罩 / LED（每个实例按自己的位置错开亮的时刻，
 *                和 streetLights.ts 里光晕、光斑的亮法一致），lightbox = 一直亮着的灯箱
 *   kitLight     标记点的自定义属性 → 光源（LightAnchor）
 */

export interface KitPart {
  geo: THREE.BufferGeometry;
  /** 材质槽的名字（paint / metal / wood / concrete / glass / glow / lightbox / board） */
  slot: string;
  /** 在物体里的变换 */
  local: THREE.Matrix4;
}
export interface KitMark {
  name: string;
  pos: THREE.Vector3;
  props: Record<string, unknown>;
}
export interface KitItem {
  parts: KitPart[];
  marks: KitMark[];
}

type Keep = <T extends { dispose(): void }>(x: T) => T;

export async function loadKit(url: string, keep: Keep): Promise<Map<string, KitItem>> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const out = new Map<string, KitItem>();
  gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const item: KitItem = { parts: [], marks: [] };
    const inv = root.matrixWorld.clone().invert();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        keep(mesh.geometry);
        const mat = mesh.material as THREE.Material;
        mat.dispose();
        item.parts.push({ geo: mesh.geometry, slot: mat.name.replace(/\.\d+$/, ''), local: inv.clone().multiply(mesh.matrixWorld) });
      } else if (o !== root && !o.children.some((c) => (c as THREE.Mesh).isMesh)) {
        item.marks.push({ name: o.name, pos: new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv), props: o.userData });
      }
    });
    out.set(root.name, item);
  }
  return out;
}

/**
 * 灯错开亮的时刻：按实例在世界里的位置算一个 0..1 的哈希（GLSL 和 JS 一模一样的算法，
 * 着色器里的灯罩和 streetLights.ts 里的光晕、光斑同一时刻亮）。避开 sin(很大的数)：GPU 上的精度和 JS 对不上
 */
export const ON_HASH_GLSL = /* glsl */ `
  float onHash( vec2 p ) {
    vec2 q = fract( p * vec2( 0.1031, 0.1030 ) );
    q += dot( q, q.yx + 33.33 );
    return fract( ( q.x + q.y ) * q.x );
  }
`;
const fract = (x: number) => x - Math.floor(x);
export function onHash(x: number, z: number) {
  let qx = fract(x * 0.1031);
  let qz = fract(z * 0.103);
  const d = qx * (qz + 33.33) + qz * (qx + 33.33);
  qx += d;
  qz += d;
  return fract((qx + qz) * qx);
}
/** 这个位置的灯天黑到多少（lightsOn）才亮 */
export const onAtOf = (p: THREE.Vector3) => 0.15 + 0.4 * onHash(p.x, p.z);

export interface KitNight {
  /** 天黑了多少（0..1） */
  uLights: { value: number };
  /** 灯罩亮起来的自发光倍数 */
  uGlowGain: { value: number };
  /** 灯箱的自发光倍数（白天也亮，夜里更亮） */
  uBoxGain: { value: number };
}

export function kitMaterials(keep: Keep, base: Record<'metal' | 'wood' | 'concrete' | 'board', THREE.Material>, night: KitNight) {
  const paint = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  const glass = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0 }));
  const glow = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }));
  glow.onBeforeCompile = (shader) => {
    shader.uniforms.uLights = night.uLights;
    shader.uniforms.uGlowGain = night.uGlowGain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uLights;\nvarying float vOn;\n${ON_HASH_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 ip = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #else
            vec3 ip = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #endif
          float onAt = 0.15 + 0.4 * onHash( ip.xz );
          vOn = smoothstep( onAt, onAt + 0.02, uLights );
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlowGain;\nvarying float vOn;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * vOn * uGlowGain;');
  };
  glow.customProgramCacheKey = () => 'street-kit-glow';
  const lightbox = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
  lightbox.onBeforeCompile = (shader) => {
    shader.uniforms.uBoxGain = night.uBoxGain;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBoxGain;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * uBoxGain;');
  };
  lightbox.customProgramCacheKey = () => 'street-kit-lightbox';
  const bySlot: Record<string, THREE.Material> = { paint, glass, glow, lightbox, ...base };
  return (slot: string) => bySlot[slot] ?? paint;
}

/** 标记点的自定义属性 → 光源；at = 这个实例的变换（光源的位置、错开亮灯的时刻都按它） */
export function kitLight(mark: KitMark, at: THREE.Matrix4): LightAnchor {
  const p = mark.props as { color?: string; intensity?: number; radius?: number; glow?: number; glowGain?: number; onAt?: number; hours?: [number, number] };
  const origin = new THREE.Vector3().setFromMatrixPosition(at);
  return {
    pos: mark.pos.clone().applyMatrix4(at),
    color: new THREE.Color(p.color ?? '#ffffff'),
    intensity: p.intensity ?? 0,
    radius: p.radius ?? 0,
    glow: p.glow ?? 0,
    glowGain: p.glowGain,
    onAt: p.onAt ?? onAtOf(origin),
    hours: p.hours,
  };
}

/**
 * 房子构件里夜里发光的部分（毛玻璃门、纸拉门、门灯、灯笼）：合进房子的大网格里，每个顶点带 aGlow =
 * (天黑到多少才亮, 几点开, 几点关)（构件的规格里写的营业时间，见 kitSpec.json）。白天是顶点色的样子，
 * 亮的时候自发光 = 顶点色 × 倍数
 */
export function buildingGlowMaterial(keep: Keep, u: { uLights: { value: number }; uHour: { value: number }; uGlowGain: { value: number } }) {
  const m = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLights = u.uLights;
    shader.uniforms.uHour = u.uHour;
    shader.uniforms.uGlowGain = u.uGlowGain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLights;\nuniform float uHour;\nuniform float uGlowGain;\nvarying vec3 vGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float a = vGlow.y, b = vGlow.z;
          float open = a <= b ? step( a, uHour ) * step( uHour, b ) : max( step( a, uHour ), step( uHour, b ) );
          // 屋里是白炽灯的暖光：透过毛玻璃、纸拉门的颜色往暖里偏（灯笼、门灯本身是有颜色的，乘上去影响不大）
          totalEmissiveRadiance = vColor.rgb * vec3( 1.0, 0.8, 0.55 ) * smoothstep( vGlow.x, vGlow.x + 0.03, uLights ) * open * uGlowGain;
        }`,
      );
  };
  m.customProgramCacheKey = () => 'street-building-glow';
  return m;
}
