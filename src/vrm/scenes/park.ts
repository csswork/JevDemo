import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js';
import { canvasTexture, rng, type Backdrop } from './common';

/**
 * 背景场景：公园（名古屋的城墙公园小路）。用 Poly Haven 的素材（CC0，`npm run assets` 下载，来源见 public/scene/CREDITS.md）：
 *
 *   远景    一张公园的全景照片（nagoya_wall_path），用 GroundedSkybox 投影成"地面 + 天空"：
 *           近处的地面是平的，人站在上面不会飘着，远处的树、栏杆、小路都是照片本身
 *   打光    同一张全景的 1k HDR 转成环境光（IBL）；一盏从身后照过来的太阳（全景里太阳的方向，
 *           穿过树冠、离地 25° 左右）投软阴影 —— 逆光，脸靠舞台的主光和补光打亮
 *   近处    一块旧木平台（weathered_brown_planks）、两盏欧式路灯（street_lamp_01）、几块青苔石头
 *           （rock_moss_set_01 里挑几块缩小）、平台上的树桩凳和石板长凳、落叶
 *
 * 第一版是全程序生成的（几何体 + canvas 画的树叶），树冠一团一团的，看着很假，换成了这样。
 *
 * 全景图的朝向：原图横向 0.6 处是那条往远处延伸的石板小路，太阳也在那个方向。转 126° 让它落在角色身后（-Z）——
 * 半身景别里看到的就是她身后那条小路和逆光的树。
 * 照片投到地面上只是一张图，接不住影子：地面上另铺一层只显示阴影的透明平面（ShadowMaterial），
 * 人、路灯、石头的影子落在照片的地面上。
 */

const BASE = `${import.meta.env.BASE_URL}scene/`;
const ROTATION = THREE.MathUtils.degToRad(126);
/** 拍全景时相机离地多高（米）：决定地面投影的比例 */
const CAPTURE_HEIGHT = 1.7;
/** 照片地面的高度：木平台面在 0，平台比地面高 10cm */
const GROUND_Y = -0.1;
/** 平台 */
const DECK = { x0: -2.4, x1: 2.3, z0: -2.0, z1: 2.0 };
/** 太阳的方向（指向太阳）：身后、离地 25° */
const SUN_DIR = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(25)), -Math.cos(THREE.MathUtils.degToRad(25)));

/** 一片落叶（白色剪影，颜色由 instanceColor 染） */
function fallenLeaf() {
  return canvasTexture(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.translate(32, 32);
    g.rotate(-0.6);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(-26, 0);
    g.quadraticCurveTo(0, -13, 26, 0);
    g.quadraticCurveTo(0, 13, -26, 0);
    g.fill();
    g.strokeStyle = 'rgba(120,90,30,0.5)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-26, 0);
    g.lineTo(26, 0);
    g.stroke();
  });
}

export function createPark(): Backdrop {
  const group = new THREE.Group();
  group.name = 'park';
  const disposables: Array<{ dispose(): void }> = [];
  let disposed = false;
  // 模型是异步加载的：换走场景之后才到的，直接释放
  const keep = <T extends { dispose(): void }>(x: T) => {
    if (disposed) x.dispose();
    else disposables.push(x);
    return x;
  };
  const r = rng(2026);
  const add = <T extends THREE.Mesh>(mesh: T, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const colliders: THREE.Object3D[] = [];
  /** 不加进场景、只给防穿墙用的简化形状 */
  const collider = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(keep(geo));
    m.position.set(x, y, z);
    m.updateMatrixWorld();
    colliders.push(m);
  };

  // ---- 全景背景（投影到地面）----
  const tl = new THREE.TextureLoader();
  const plate = keep(tl.load(`${BASE}hdri/nagoya_wall_path_4k.jpg`));
  plate.colorSpace = THREE.SRGBColorSpace;
  plate.anisotropy = 8;
  const sky = new GroundedSkybox(plate, CAPTURE_HEIGHT, 60, 96);
  keep(sky.geometry);
  keep(sky.material as THREE.Material);
  sky.position.y = CAPTURE_HEIGHT + GROUND_Y;
  sky.rotation.y = ROTATION;
  sky.renderOrder = -1;
  group.add(sky);

  // 照片的地面接不住影子：铺一层只画阴影的透明平面
  {
    const g = keep(new THREE.PlaneGeometry(24, 24));
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, keep(new THREE.ShadowMaterial({ opacity: 0.32 })));
    m.position.y = GROUND_Y + 0.002;
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- 木平台 ----
  const planks = (file: string, color = false) => {
    const t = keep(tl.load(`${BASE}textures/weathered_brown_planks/${file}`));
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  const arm = planks('arm.jpg');
  const deckMat = keep(
    new THREE.MeshStandardMaterial({
      map: planks('diffuse.jpg', true),
      normalMap: planks('nor_gl.jpg'),
      aoMap: arm,
      roughnessMap: arm,
      metalnessMap: arm,
    }),
  );
  /** 贴图一张 1.8m 见方；按世界坐标铺，木板横着（沿 x） */
  const TILE = 1.8;
  const worldUV = (g: THREE.BufferGeometry, axes: 'xz' | 'xy' | 'zy') => {
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const [a, b] = axes === 'xz' ? [p.getX(i), p.getZ(i)] : axes === 'xy' ? [p.getX(i), p.getY(i)] : [p.getZ(i), p.getY(i)];
      uv.setXY(i, a / TILE, b / TILE);
    }
    return g;
  };
  {
    const w = DECK.x1 - DECK.x0;
    const d = DECK.z1 - DECK.z0;
    const cx = (DECK.x0 + DECK.x1) / 2;
    const cz = (DECK.z0 + DECK.z1) / 2;
    const top = keep(new THREE.PlaneGeometry(w, d));
    top.rotateX(-Math.PI / 2);
    top.translate(cx, 0, cz);
    add(new THREE.Mesh(worldUV(top, 'xz'), deckMat), false);
    // 四边的边板（比平台面低一点点，到地面以下）
    const sideMat = keep(deckMat.clone());
    sideMat.color.setScalar(0.72);
    const edge = (sx: number, sz: number, x: number, z: number, axes: 'xy' | 'zy') => {
      const g = keep(new THREE.BoxGeometry(sx, 0.16, sz));
      g.translate(x, -0.08 - 0.003, z);
      add(new THREE.Mesh(worldUV(g, axes), sideMat));
    };
    edge(w + 0.08, 0.08, cx, DECK.z1, 'xy');
    edge(w + 0.08, 0.08, cx, DECK.z0, 'xy');
    edge(0.08, d, DECK.x0, cz, 'zy');
    edge(0.08, d, DECK.x1, cz, 'zy');
    collider(new THREE.BoxGeometry(w, 0.2, d), cx, -0.1, cz);
  }
  // 地面（防穿墙）
  {
    const g = new THREE.PlaneGeometry(40, 40);
    g.rotateX(-Math.PI / 2);
    collider(g, 0, GROUND_Y, 0);
  }

  // ---- 平台上的座位：树桩凳、石板长凳 ----
  {
    const stumpMat = keep(deckMat.clone());
    stumpMat.color.set(0xd8c2a8);
    const seat = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const m = add(new THREE.Mesh(keep(geo), mat));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.updateMatrixWorld();
      colliders.push(m);
    };
    seat(new THREE.CylinderGeometry(0.17, 0.19, 0.42, 16), stumpMat, 1.2, 0.21, -1.3);
    seat(new THREE.BoxGeometry(0.44, 0.07, 0.38), deckMat, 1.2, 0.455, -1.3, 0.15);
    const bx = 1.75;
    const bz = 0.55;
    const ry = -0.3;
    for (const dx of [-0.42, 0.42])
      seat(new THREE.BoxGeometry(0.26, 0.4, 0.32), stumpMat, bx + dx * Math.cos(ry), 0.2, bz - dx * Math.sin(ry), ry);
    seat(new THREE.BoxGeometry(1.3, 0.09, 0.5), deckMat, bx, 0.445, bz, ry);
  }

  // ---- 落叶 ----
  {
    const mat = keep(new THREE.MeshStandardMaterial({ map: keep(fallenLeaf()), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }));
    const geo = keep(new THREE.PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    const n = 160;
    const im = new THREE.InstancedMesh(geo, mat, n);
    const colors = [0xe9c64b, 0xd9b23a, 0xc98f3a, 0xb7a14a, 0xa8b452, 0x8e7a3a];
    const s = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const k = 0.05 + r() * 0.04;
      const p = new THREE.Vector3(DECK.x0 + r() * (DECK.x1 - DECK.x0), 0.003, DECK.z0 + r() * (DECK.z1 - DECK.z0));
      im.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2), s.set(k, 1, k)));
      im.setColorAt(i, new THREE.Color(colors[Math.floor(r() * colors.length)]));
    }
    im.computeBoundingSphere();
    im.receiveShadow = true;
    group.add(im);
  }

  // ---- 脚下的接触阴影 ----
  {
    const tex = keep(
      canvasTexture(128, 128, (g) => {
        const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grd.addColorStop(0, 'rgba(0,0,0,0.45)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 128, 128);
      }),
    );
    const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.9, 0.6)), keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.006;
    group.add(m);
  }

  // ---- 模型：路灯、石头（异步加载，到了再放进来）----
  const loader = new GLTFLoader();
  const own = (root: THREE.Object3D) =>
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      keep(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        keep(m);
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) keep(v);
      }
    });
  const place = (src: THREE.Object3D, x: number, y: number, z: number, scale = 1, ry = 0) => {
    const o = src.clone();
    o.position.set(x, y, z);
    o.scale.setScalar(scale);
    o.rotation.y = ry;
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 玻璃灯罩不投影
      const glass = (mesh.material as THREE.Material).transparent;
      mesh.castShadow = !glass;
      mesh.receiveShadow = true;
    });
    group.add(o);
    return o;
  };
  loader.load(`${BASE}models/street_lamp_01/street_lamp_01.gltf`, (gltf) => {
    own(gltf.scene);
    if (disposed) return;
    // 一盏在平台右后角外（照片里最近的那盏），一盏在左后方远一点 —— 都不在头后面
    for (const [x, z, ry] of [
      [2.05, -2.45, 0.4],
      [-3.4, -4.6, -0.3],
    ]) {
      place(gltf.scene, x, GROUND_Y, z, 1, ry);
      collider(new THREE.CylinderGeometry(0.12, 0.12, 3.9, 6), x, GROUND_Y + 1.95, z);
    }
  });
  loader.load(`${BASE}models/rock_moss_set_01/rock_moss_set_01.gltf`, (gltf) => {
    own(gltf.scene);
    if (disposed) return;
    const rocks = gltf.scene.children;
    // 原尺寸是 2~3m 的大石头，缩到半米到一米，沿着平台边上和小路两侧放；一半埋在土里
    const spots: Array<[number, number, number, number, number]> = [
      // 第几块, x, z, 缩放, 转角
      [1, -3.1, -1.0, 0.26, 0.6],
      [4, 3.1, 0.9, 0.22, 2.1],
      [0, -1.9, -4.4, 0.3, 1.2],
      [5, 2.6, -4.8, 0.24, -0.8],
      [2, -3.6, 2.2, 0.28, 0.3],
    ];
    for (const [k, x, z, s, ry] of spots) {
      const src = rocks[k % rocks.length];
      if (!src) continue;
      const o = place(src, x, GROUND_Y + 0.02, z, s, ry);
      o.updateMatrixWorld(true);
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) colliders.push(c);
      });
    }
  });

  // ---- 太阳 ----
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.4);
  sun.target.position.set(0, 0, -0.5);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 2, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 4;
  group.add(sun.target);

  return {
    group,
    lights: [sun],
    colliders,
    hemisphere: { sky: 0xdcebd2, ground: 0x6e5c44, intensity: 0.8 },
    fog: null,
    environment: { url: `${BASE}hdri/nagoya_wall_path_1k.hdr`, intensity: 1, rotation: ROTATION },
    shadowBounds: 3,
    keyShadow: false,
    far: 170,
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose();
    },
  };
}
