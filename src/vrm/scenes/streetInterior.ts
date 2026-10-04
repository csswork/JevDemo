import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { pbrTextures, rng } from './common';
import { chalkboard } from './streetTextures';

/**
 * 她身边那家咖啡店的店内（真的 3D，透过透明玻璃看进去，见 glass.ts）：
 * 木地板、米色的灰泥墙 + 深色木墙裙、深色木梁的天花板；吧台、咖啡机、蛋糕和杯子、吧台凳，靠窗几张圆桌和椅子，
 * 吧台上方和桌子上方的吊灯，后墙的置物架和黑板菜单，角落的绿植、沙发。模型是 Blender 做的（scripts/blender/cafe_props.py），
 * 名字和原来用的 Poly Pizza 模型一样。
 * 店里一盏暖色的点光源（吧台上方，照不到 6m 以外：街上和角色身上都不受影响）。
 *
 * 模型都到了以后按材质合并成几十个网格（Poly Pizza 的模型一个就有好几个部件，加上罐子、木箱子，摆完三百多个网格，
 * 每帧多三百多次绘制）。店里的东西不投影（墙和窗框投的影子已经有窗格的光斑了），也省掉阴影通道里那一遍
 *
 * 坐标是房子的局部坐标（street.ts 的 building）：门脸在 z = 0、朝 +z，x 沿街，地板在 y = floorY
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

export interface CafeInteriorOptions {
  group: THREE.Group;
  keep: Keep;
  /** 房子的变换（局部 → 世界） */
  M: THREE.Matrix4;
  /** 房子的宽、进深 */
  w: number;
  d: number;
  /** 店里地板的高度（局部 y），天花板高度 */
  floorY: number;
  ceilY: number;
  /** 按名字取一件模型（scripts/blender/cafe_props.py 导出的，缓存过的） */
  load: (file: string) => Promise<THREE.Object3D | null>;
  /** 门在哪（局部 x 的范围）：门口留出通道 */
  door: [number, number];
}

/** 椅子模型默认面朝 +Z（Blender 做的，正面朝 -Y 导出），转到面朝桌子不用补 */
const CHAIR_FACING = 0;

export function buildCafeInterior(o: CafeInteriorOptions) {
  const { group, keep, M, w, d, floorY: F0, ceilY } = o;
  const hw = w / 2 - 0.1;
  const back = -d + 0.15;
  const front = -0.12;
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.matrix.copy(M);
  root.name = 'cafe-interior';
  group.add(root);
  const shaded = <T extends THREE.Object3D>(m: T) => {
    m.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        c.castShadow = false;
        c.receiveShadow = true;
      }
    });
    root.add(m);
    return m;
  };
  const pending: Array<Promise<unknown>> = [];

  // ---- 材质 ----
  // 颜色压暗一点：太阳从窗口照进来落在地板、墙上，墙太白的话那一块亮得发白
  const floorMat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('weathered_brown_planks', keep, { repeat: 1 / 1.8 }), color: 0x9a7658 }));
  const wallMat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('plastered_wall_02', keep, { repeat: 1 / 2.23 }), color: 0xd9c19c }));
  const panelMat = keep(new THREE.MeshStandardMaterial({ ...pbrTextures('weathered_brown_planks', keep, { repeat: 1 / 1.8 }), color: 0x6a4a36 }));
  const darkWood = keep(new THREE.MeshStandardMaterial({ color: 0x3a281e, roughness: 0.7 }));
  const lightWood = keep(new THREE.MeshStandardMaterial({ color: 0xb98a5e, roughness: 0.55 }));
  const ceilMat = keep(new THREE.MeshStandardMaterial({ color: 0x8a6a52, roughness: 0.85 }));

  /** 一块平面：中心、宽高、朝向（绕 y 转、绕 x 转），uv 按米 */
  const plane = (mat: THREE.Material, x: number, y: number, z: number, pw: number, ph: number, ry: number, rx = 0) => {
    const g = keep(new THREE.PlaneGeometry(pw, ph));
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * pw, uv.getY(i) * ph);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0, 'YXZ');
    return shaded(m);
  };
  const box = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(sx, sy, sz)), mat);
    m.position.set(x, y, z);
    return shaded(m);
  };
  const cyl = (mat: THREE.Material, x: number, y: number, z: number, r: number, h: number) => {
    const m = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r, h, 20)), mat);
    m.position.set(x, y, z);
    return shaded(m);
  };

  // ---- 房间：地板、天花板、后墙、两面侧墙（都朝里），下半截木墙裙 ----
  const H = ceilY - F0;
  const D = front - back;
  plane(floorMat, 0, F0, (front + back) / 2, hw * 2, D, 0, -Math.PI / 2);
  plane(ceilMat, 0, ceilY, (front + back) / 2, hw * 2, D, 0, Math.PI / 2);
  plane(wallMat, 0, F0 + H / 2, back, hw * 2, H, 0);
  plane(wallMat, -hw, F0 + H / 2, (front + back) / 2, D, H, Math.PI / 2);
  plane(wallMat, hw, F0 + H / 2, (front + back) / 2, D, H, -Math.PI / 2);
  box(panelMat, 0, F0 + 0.5, back + 0.02, hw * 2, 1.0, 0.04);
  box(panelMat, -hw + 0.02, F0 + 0.5, (front + back) / 2, 0.04, 1.0, D);
  box(panelMat, hw - 0.02, F0 + 0.5, (front + back) / 2, 0.04, 1.0, D);
  // 天花板的木梁（横跨店面）
  for (let z = back + 1.2; z < front - 0.4; z += 1.6) box(darkWood, 0, ceilY - 0.1, z, hw * 2, 0.2, 0.18);

  // ---- 模型 ----
  const place = (file: string, x: number, y: number, z: number, h: number, ry = 0) => {
    const p = o.load(file).then((src) => {
      if (!src) return null;
      const inner = src.clone(true);
      inner.rotation.y = ry;
      const m = new THREE.Group();
      m.add(inner);
      m.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(m);
      m.scale.setScalar(h / Math.max(1e-6, bb.max.y - bb.min.y));
      m.updateMatrixWorld(true);
      bb.setFromObject(m);
      m.position.set(x - (bb.min.x + bb.max.x) / 2, y - bb.min.y, z - (bb.min.z + bb.max.z) / 2);
      return shaded(m);
    });
    pending.push(p);
    return p;
  };

  // 吧台（店里靠后，横着）：台身、台面、踢脚
  const cz = back + 3.6;
  const counterTop = F0 + 1.025;
  box(panelMat, -0.4, F0 + 0.49, cz, 6.4, 0.98, 0.62);
  box(lightWood, -0.4, F0 + 1.0, cz, 6.55, 0.05, 0.74);
  box(darkWood, -0.4, F0 + 0.06, cz + 0.3, 6.4, 0.06, 0.05);
  // 咖啡机（正面朝里，对着吧台里的咖啡师）、一排杯子、星冰乐、蛋糕罩、一盘甜点
  void place('espresso_machine', 1.6, counterTop, cz - 0.06, 0.46, 0);
  for (let i = 0; i < 4; i++) void place('cup_tea', 2.05 + i * 0.13, counterTop, cz + 0.08 - (i % 2) * 0.06, 0.075, 0.6 + i * 1.3);
  void place('frappe', 1.05, counterTop, cz + 0.05, 0.2);
  const domeMat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.05 }));
  for (const [x, file, h] of [
    [-1.6, 'cake', 0.13],
    [-2.6, 'cupcake', 0.09],
  ] as const) {
    cyl(lightWood, x, F0 + 1.04, cz, 0.24, 0.025);
    const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), domeMat);
    dome.position.set(x, F0 + 1.05, cz);
    dome.scale.y = 1.3;
    root.add(dome);
    void place(file, x, F0 + 1.053, cz, h, 0.4);
  }
  void place('croissant', -0.6, counterTop + 0.016, cz - 0.02, 0.05, 0.5);
  void place('muffin', -0.45, counterTop + 0.016, cz - 0.03, 0.075);
  void place('donut_sprinkles', -0.62, counterTop + 0.016, cz + 0.11, 0.035, 1.2);
  void place('lamp_round_table', -3.3, counterTop, cz - 0.05, 0.36, 0.3);
  // 吧台凳（客人那一侧）
  for (const [x, ry] of [
    [-2.9, 0.3],
    [-1.5, -0.2],
    [0.3, 0.5],
    [1.9, -0.4],
  ] as const)
    void place('bar_stool', x, F0, cz + 0.62, 0.78, ry);

  // 后墙：置物架（瓶瓶罐罐、杯子、小盆栽）+ 黑板菜单
  const r = rng(808);
  const jarMats = [0x7a4b2a, 0xd9c7a3, 0x3f2a1c, 0xa8693c, 0xefe8da, 0x2f4f3a].map((c) => keep(new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 })));
  for (const y of [1.45, 1.85, 2.25]) {
    box(darkWood, 1.6, F0 + y, back + 0.14, 3.4, 0.04, 0.26);
    let x = 0.0;
    while (x < 3.2) {
      const k = r();
      if (k < 0.5) {
        const h = 0.14 + r() * 0.1;
        cyl(jarMats[Math.floor(r() * jarMats.length)], x, F0 + y + 0.02 + h / 2, back + 0.14, 0.05, h);
        x += 0.15;
      } else if (k < 0.8) {
        void place('cup', x, F0 + y + 0.02, back + 0.14, 0.075, r() * 6);
        x += 0.13;
      } else {
        void place(r() < 0.5 ? 'houseplant_3' : 'houseplant_2', x, F0 + y + 0.02, back + 0.14, 0.2, r() * 6);
        x += 0.2;
      }
    }
  }
  const board = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.5, 1.09)), keep(new THREE.MeshStandardMaterial({ map: keep(chalkboard()), roughness: 0.95 })));
  board.position.set(-2.2, F0 + 1.9, back + 0.04);
  shaded(board);
  box(darkWood, -2.2, F0 + 1.9, back + 0.02, 1.6, 1.19, 0.03);

  // 靠窗的圆桌（门口留出通道），每张两把椅子面朝桌子，桌上一杯咖啡或星冰乐
  const tz = front - 1.7;
  [-4.7, -2.6, 2.6, 4.7].forEach((x, k) => {
    if (x > o.door[0] - 0.6 && x < o.door[1] + 0.6) return;
    void place('round_table', x, F0, tz, 0.74, k);
    void place(k % 2 ? 'frappe' : 'cup_tea', x + 0.08, F0 + 0.74, tz - 0.05, k % 2 ? 0.2 : 0.075, k);
    for (const a of [0.2 + k * 0.4, Math.PI + 0.2 + k * 0.4]) {
      const ccx = x + Math.cos(a) * 0.68;
      const ccz = tz + Math.sin(a) * 0.68;
      void place('chair', ccx, F0, ccz, 0.95, Math.atan2(x - ccx, tz - ccz) + CHAIR_FACING);
    }
  });
  // 右边里面的沙发角、左边里面的书架
  void place('couch_medium', hw - 0.55, F0, cz + 1.9, 0.85, -Math.PI / 2);
  void place('rug_round', hw - 1.8, F0 + 0.003, cz + 1.9, 0.02);
  void place('coffee_table', hw - 1.8, F0, cz + 1.9, 0.42, Math.PI / 2);
  void place('bookcase_books', -hw + 0.25, F0, cz + 1.4, 1.9, Math.PI / 2);
  void place('wall_painting_1', -hw + 0.06, F0 + 1.6, tz - 1.4, 0.9, Math.PI / 2);
  // 角落、门边的盆栽
  for (const [x, z, file, h] of [
    [-hw + 0.5, back + 0.6, 'houseplant_1', 1.25],
    [hw - 0.5, back + 0.6, 'houseplant_2', 1.1],
    [o.door[0] - 0.35, front - 0.45, 'houseplant_3', 0.9],
    [o.door[1] + 0.35, front - 0.45, 'houseplant_1', 1.0],
  ] as const)
    void place(file, x, F0, z, h, x);

  // ---- 吊灯：吧台上方三盏、桌子上方两盏（模型里的灯泡营业时间亮，见 street.ts）；一盏暖色点光源照亮店里 ----
  for (const [lx, lz] of [
    [-2.4, cz],
    [-0.4, cz],
    [1.6, cz],
    [-3.6, tz],
    [3.6, tz],
  ] as const) {
    const ly = ceilY - 0.75;
    void place('light_ceiling', lx, ly - 0.06, lz, ceilY - (ly - 0.06));
  }
  // 模型都到了：不透明的按材质 + 属性合并（半透明的蛋糕罩留着单独画，要排序）
  void Promise.all(pending).then(() => {
    if (!root.parent) return;
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const old: THREE.Mesh[] = [];
    root.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.material.transparent) return;
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      const keepAttrs = ['position', 'normal', 'uv', ...((mesh.material as THREE.MeshStandardMaterial).vertexColors ? ['color'] : [])];
      for (const name of Object.keys(g.attributes)) if (!keepAttrs.includes(name)) g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
      const key = `${mesh.material.uuid}|${Object.keys(g.attributes).sort().join(',')}`;
      const entry = groups.get(key) ?? { mat: mesh.material, geos: [] };
      entry.geos.push(g);
      groups.set(key, entry);
      old.push(mesh);
    });
    for (const mesh of old) mesh.removeFromParent();
    for (const { mat, geos } of groups.values()) {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const m = new THREE.Mesh(keep(merged), mat);
      m.receiveShadow = true;
      root.add(m);
    }
  });

  const light = new THREE.PointLight(0xffc98a, 7, 9.5, 2);
  light.position.set(-0.4, ceilY - 0.6, cz + 1.2);
  light.position.applyMatrix4(M);
  // 店里的材质为白天的阳光压暗过：夜里外面黑了、只剩店里的灯，代码按时间把它们调亮一点（materials）
  return { lights: [light], materials: [floorMat, wallMat, panelMat, darkWood, lightWood, ceilMat] };
}
