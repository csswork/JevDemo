import * as THREE from 'three';
import type { Tree } from '@dgreenheck/ez-tree';

/**
 * 室外场景共用的植物和合批（公园 park.ts、街景 street.ts）：
 *   windShader / windDepth  草、花、树叶随风摆，影子跟着摆
 *   createBatcher           同一份几何体 + 材质的一批东西合成 InstancedMesh，每次渲染前按视锥逐个剔除
 *   createTreeMaker         ez-tree 生成树 / 灌木的一个变体：树叶随风（合批也能用）、逆光透光、影子跟着摆
 */

export type Wind = { uTime: { value: number } };
type Keep = <T extends { dispose(): void }>(x: T) => T;

/**
 * 草随风摆：每丛草的顶端按位置错开相位地晃（根部不动）。
 * 思路来自 ez-tree 演示场景的 grass.js（MIT），简化过
 */
export function windShader(mat: THREE.Material, uniforms: Wind, height = 2, amp = 0.045) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uTime;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        // k = 0 根部，1 顶端（模型原始高度 ${height.toFixed(2)} 个单位）
        float k = clamp( position.y / ${height.toFixed(2)}, 0.0, 1.0 );
        float ph = uTime * 1.6 + mvPosition.x * 0.45 + mvPosition.z * 0.31;
        mvPosition.xz += k * k * vec2( sin( ph ), 0.6 * cos( ph * 0.83 + 1.3 ) ) * ${amp.toFixed(3)};
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        `,
      );
  };
  // 高度、幅度是直接写进代码的常量，缓存键要带上它们：默认的键是 onBeforeCompile 的源码（每次都一样），
  // 几种花的材质类型相同，会共用第一种编译出来的程序、用错高度
  mat.customProgramCacheKey = () => `park-wind:${height}:${amp}`;
}

/**
 * 随风摆的东西投出的影子也要跟着摆：阴影用的深度材质注入同一段风的代码、读同一个 uTime。
 * 贴图和 alphaTest（叶片、花瓣的镂空）不用设 —— three 画阴影时每次都从物体自己的材质抄过来
 */
export function windDepth(uniforms: Wind, height?: number, amp?: number) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  windShader(mat, uniforms, height, amp);
  return mat;
}

/**
 * 合批：同一个几何体 + 材质的一批树（灌木、路灯同理）合成 InstancedMesh，几十棵一次绘制（之前每棵树的树干、树冠各画一次，
 * 主画面加阴影一帧要画近两百次）。
 * 合成之后 three 只能按整体的包围球剔除，镜头背后的树也照画、三角形反而更多 —— 所以每次渲染前按这次的视锥
 * 在 CPU 上逐棵剔除，只把看得见的写进实例缓冲（几十个包围球和视锥比一下；看得见的那批没变就不重新上传）。
 * 投影的另用一个 InstancedMesh（同一份几何体和材质），只在阴影通道里画：
 * 一个 InstancedMesh 在两个通道里画的是同一批实例，合用的话要么主画面多画镜头外的树，要么镜头外的树没了影子。
 * 投影的这批除了要在阴影相机的视锥里，影子还得落进画面：树冠沿着阳光往下扫到地面是一条胶囊，
 * 影子只可能落在这条胶囊里，它整个在视锥外（镜头背后的树，影子也落在背后）就不画 —— 阴影通道的树省掉一大半，画面一点不变。
 *
 * floor = 影子最低落到哪（地面最低处再留点余量）。cull 在 Backdrop.beforeRender 里调
 */
export function createBatcher(group: THREE.Group, keep: Keep, sunDir: THREE.Vector3, floor = -0.4) {
  const batches: Array<(view: THREE.Frustum, shadow: THREE.Frustum | null) => void> = [];
  const batch = (geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], shadow: { depth?: THREE.Material } | null) => {
    if (!matrices.length) return;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const spheres = matrices.map((m) => geo.boundingSphere!.clone().applyMatrix4(m));
    // three 给物体排先后（不透明的由近到远、半透明的由远到近）用整体的包围球。不设的话它在第一帧按当时的实例数算一次，可能是空的
    const bounds = spheres.reduce((u, s) => u.union(s), spheres[0].clone());
    // 胶囊的下端：从包围球心逆着阳光走到地面以下
    const ends = spheres.map((s) => s.center.clone().addScaledVector(sunDir, -(s.center.y - floor) / sunDir.y));
    /** 第 i 棵的影子会不会落进视锥：胶囊整个在视锥某一个面的外侧就不会 */
    const shadowInView = (view: THREE.Frustum, i: number) => {
      const r = spheres[i].radius;
      for (const p of view.planes) if (p.distanceToPoint(spheres[i].center) < -r && p.distanceToPoint(ends[i]) < -r) return false;
      return true;
    };
    const part = (cast: boolean) => {
      const im = keep(new THREE.InstancedMesh(geo, mat, matrices.length));
      im.count = 0;
      im.frustumCulled = false; // 自己逐棵剔
      im.boundingSphere = bounds;
      im.castShadow = cast;
      im.receiveShadow = !cast;
      group.add(im);
      const ids = new Int32Array(matrices.length);
      let shown = 0;
      /** frustum = 这一批按哪个视锥剔；view = 投影的那批还要看影子落不落进画面 */
      const cull = (frustum: THREE.Frustum | null, view?: THREE.Frustum) => {
        let n = 0;
        let changed = false;
        if (frustum) {
          for (let i = 0; i < spheres.length; i++) {
            if (!frustum.intersectsSphere(spheres[i]) || (view && !shadowInView(view, i))) continue;
            if (n >= shown || ids[n] !== i) changed = true;
            ids[n++] = i;
          }
        }
        if (!changed && n === shown) return;
        for (let k = 0; k < n; k++) im.setMatrixAt(k, matrices[ids[k]]);
        im.count = shown = n;
        im.instanceMatrix.needsUpdate = true;
      };
      return { im, cull };
    };
    const view = part(false);
    const cast = shadow ? part(true) : null;
    if (cast) {
      if (shadow?.depth) cast.im.customDepthMaterial = shadow.depth;
      // 主通道里 three 也会走到它：画之前把实例数置 0（three 遇到 0 个实例直接跳过，不发绘制），画完恢复
      let n = 0;
      cast.im.onBeforeRender = () => {
        n = cast.im.count;
        cast.im.count = 0;
      };
      cast.im.onAfterRender = () => {
        cast.im.count = n;
      };
    }
    batches.push((v, s) => {
      view.cull(v);
      cast?.cull(s, v);
    });
  };
  return {
    batch,
    cull(view: THREE.Frustum, shadow: THREE.Frustum | null) {
      for (const b of batches) b(view, shadow);
    },
  };
}

export interface TreeVariant {
  tree: Tree;
  /** 树叶影子用的深度材质（同一套风） */
  depth: THREE.MeshDepthMaterial;
  /** 缩放到指定高度的倍数 */
  scale: number;
  /** 树干半径（模型单位，乘 scale 才是米） */
  trunk: number;
}

/**
 * ez-tree 生成一个变体（树或灌木）。只在动态 import 了 ez-tree 之后用（模块 4MB，选了这个场景才加载）。
 * leafTint = 叶子的颜色再乘多少（Phong 的颜色可以超过 1）；染过色（tint）的叶子不乘
 */
export function createTreeMaker(
  TreeClass: typeof Tree,
  opts: { wind: Wind; sunDir: THREE.Vector3; keep: Keep; leafTint: THREE.Color },
) {
  const { wind, keep } = opts;
  /**
   * ez-tree 树叶的风是它自己的 onBeforeCompile（整段替换了 project_vertex）。这里先调它，再补两处：
   * 1. 它没乘 instanceMatrix（ez-tree 是一棵树一个 Mesh 的用法），合批之后补上；风还是在树自己的坐标里算，和之前一样
   * 2. uTime 换成场景共用的那一个：树叶的颜色材质和阴影的深度材质读同一个值，影子和叶子一起摆
   *    （ez-tree 的 Tree.update 也是写这个值，所以不用再逐棵调它）
   * 两种材质都过这一遍，风的代码是同一份
   */
  const leafWind = (ez: THREE.Material['onBeforeCompile'], shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
    ez(shader, renderer);
    shader.uniforms.uTime = wind.uTime;
    const vs = shader.vertexShader;
    shader.vertexShader = vs.replace(
      'mvPosition = modelViewMatrix * mvPosition;',
      `#ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      mvPosition = modelViewMatrix * mvPosition;`,
    );
    if (shader.vertexShader === vs) console.warn('foliage: ez-tree 树叶的风代码变了，合批的树叶没乘 instanceMatrix');
  };
  /**
   * 树叶逆光透光（假的次表面散射，写法参考 Stillwater）：Phong 只算朝着光的那一面，逆光看树冠是一片暗绿。
   * 两项：视线对着太阳（叶子在人和太阳之间）时最亮；叶子背面朝着太阳时透一点。乘太阳的阴影 ——
   * 树冠里面被别的叶子挡住的暗下去，留 25% 当作天光透过来的。只加在 directDiffuse 上，顺光看不变。
   * Phong 默认不带 getShadowMask()，在 shadowmap_pars_fragment 后面补上
   */
  const sunDir = { value: opts.sunDir };
  const translucent = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uSunDir = sunDir;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <shadowmap_pars_fragment>',
        `#include <shadowmap_pars_fragment>
        #include <shadowmask_pars_fragment>
        uniform vec3 uSunDir;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          vec3 sunDirView = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
          float translucency = pow( max( dot( - geometryViewDir, sunDirView ), 0.0 ), 2.0 ) * 0.6
            + max( dot( - normal, sunDirView ), 0.0 ) * 0.24;
          reflectedLight.directDiffuse += diffuseColor.rgb * vec3( 1.9, 1.6, 0.85 ) * translucency * ( 0.25 + 0.75 * getShadowMask() );
        }`,
      );
  };
  return (preset: string, seed: number, height: number, tint: number | null, leaves = 1): TreeVariant => {
    const t = new TreeClass();
    t.loadPreset(preset);
    t.options.seed = seed;
    t.options.leaves.count = Math.round(t.options.leaves.count * leaves);
    if (tint != null) t.options.leaves.tint = tint;
    t.generate();
    const leafMat = t.leavesMesh.material as THREE.MeshPhongMaterial;
    if (tint == null) leafMat.color.multiply(opts.leafTint);
    // 背光的叶子补一点自发光（不补就是一片暗橄榄绿）。逆光透亮交给上面的透光，这里只托底，比之前（0.55）低
    leafMat.emissive.set(tint == null ? 0x4a6a14 : 0x5a1a0a);
    leafMat.emissiveIntensity = 0.3;
    leafMat.emissiveMap = leafMat.map;
    const ez = leafMat.onBeforeCompile.bind(leafMat);
    leafMat.onBeforeCompile = (shader, renderer) => {
      leafWind(ez, shader, renderer);
      translucent(shader);
    };
    leafMat.customProgramCacheKey = () => 'park-leaf';
    // 树叶的影子：同一套风、同一个 uTime（每个变体一个，这个变体的树叶共用）
    const depth = keep(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
    depth.onBeforeCompile = (shader, renderer) => leafWind(ez, shader, renderer);
    depth.customProgramCacheKey = () => 'park-leaf-depth';
    for (const mesh of [t.branchesMesh, t.leavesMesh]) {
      keep(mesh.geometry);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) keep(mm);
    }
    const box = new THREE.Box3().setFromObject(t);
    return {
      tree: t,
      depth,
      scale: height / Math.max(1e-3, box.max.y - box.min.y),
      trunk: (t.options.branch.radius as Record<string, number>)['0'] ?? 1,
    };
  };
}
