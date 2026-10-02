import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { canvasTexture, rng, type Backdrop } from './common';

export type { Backdrop };

/**
 * 背景场景：一家小咖啡店的店内。房间本身（墙、地板、窗、黑板、店招、吧台、置物架）是程序生成的（几何体 + canvas 画的贴图）；
 * 店里的小物件是 Poly Pizza 上的低多边形模型（public/scene/polypizza/，来源和授权见 public/scene/CREDITS.md）：
 * 意式咖啡机（Zsky，CC-BY）、杯子、甜点、圆桌木椅、吧台凳、吊灯、绿植、地毯、台灯（Kenney / Quaternius，CC0）。
 * 平涂的低多边形和动漫角色放在一起比写实模型协调（Poly Haven 的写实模型试过，很突兀）。
 * 唯一的外部文件是打光用的室内 HDRI（public/scene/hdri/，Poly Haven，CC0）：舞台把它转成环境光（IBL），
 * 只用来照亮场景里的 PBR 材质，不显示出来。
 *
 * 试过换成 Poly Haven 的写实模型和 PBR 材质（桌椅、吊灯、绿植、木板墙……），和动漫角色放在一起非常突兀，
 * 撤掉了 —— 见 README"背景"一节。
 *
 * 坐标和舞台一致：角色站在原点、面朝 +Z，主相机在 +Z 方向 1.6m 处往 -Z 看。所以：
 *   身后（-Z）   吧台、咖啡机、蛋糕罩、墙上的置物架和黑板菜单、吧台上方两盏暖光吊灯 —— 半身景别里看到的就是这面
 *   左（-X）     两扇大窗，窗台上有绿植
 *   右（+X）     砖墙，挂画和挂钟
 *   前（+Z）     门和一扇小窗（镜头转过来时看到）
 *   中间         几张小圆桌和椅子（拉远看全身时看到）
 * 房间 10m × 10m、以角色为中心：鼠标最远能把相机拉到 4.3m 外绕着转，四面墙离角色都是 5m。
 * 吧台、桌椅挡在镜头和角色之间时，舞台会把镜头拉近到障碍物前面（stage.ts 的防穿墙，用 colliders）。
 *
 * 半身景别里，主相机在 5m 外的后墙上只看得到约 2m 宽、2.4m 高的一块 —— 头后面那块墙特意留空
 * （第一版置物架上的瓶瓶罐罐正好在头后面，抢脸）：置物架在右边，黑板在左边，咖啡机、蛋糕罩也往两边放。
 *
 * 灯光：吊灯是暖色点光源，只照近处（decay 2），给吧台和后墙打光，也会在角色头发上留一点暖色轮廓光；
 * 窗户是自发光的面 + 一盏偏冷的方向光。舞台自己的三点布光和半球光照常照着角色，主光在店里投软阴影。
 */

const W = 10; // 房间宽（x）
const D = 10; // 房间深（z）
const H = 3.2; // 层高
const BACK = -5; // 后墙 z
const FRONT = BACK + D; // 前墙 z
/** Poly Pizza 的模型 */
const PP = `${import.meta.env.BASE_URL}scene/polypizza/`;
/** 椅子模型默认面朝 -Z（实测），转到面朝桌子时补半圈 */
const CHAIR_FACING = Math.PI;
/** 其余模型的朝向（绕竖轴，弧度）：让正面朝向店里。逐个从店里拍过（__views 的特写）确认的 */
const WINDOW_RY = Math.PI / 2;
const WINDOW_SMALL_RY = Math.PI;
const DOOR_RY = Math.PI;
const PAINTING_1_RY = Math.PI / 2;
const PAINTING_2_RY = Math.PI;
const CLOCK_RY = Math.PI;
const BOOKCASE_RY = -Math.PI / 2;
const COUCH_RY = Math.PI / 2;
/** 休闲椅（Kenney）正面默认朝 -Z，和木椅一样：转到朝 -X（茶几）是 +90° */
const LOUNGE_RY = Math.PI / 2;

/** 窗户模型里的玻璃是不透明的：改成半透明、不挡阴影，窗外才看得见 */
function glassy(o: THREE.Object3D | null) {
  o?.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!/glass/i.test(m.name)) continue;
      m.transparent = true;
      m.opacity = 0.15;
      m.depthWrite = false;
      mesh.castShadow = false;
    }
  });
}

function woodFloor() {
  const r = rng(7);
  return canvasTexture(
    512,
    512,
    (g) => {
      const plankH = 64;
      for (let y = 0; y < 512; y += plankH) {
        let x = -Math.floor(r() * 300);
        while (x < 512) {
          const len = 180 + r() * 220;
          const l = 30 + r() * 10;
          g.fillStyle = `hsl(${26 + r() * 6}, ${38 + r() * 10}%, ${l}%)`;
          g.fillRect(x, y, len, plankH);
          // 木纹
          g.strokeStyle = `hsla(25, 40%, ${l - 8}%, 0.35)`;
          g.lineWidth = 1;
          for (let i = 0; i < 6; i++) {
            const yy = y + 6 + r() * (plankH - 12);
            g.beginPath();
            g.moveTo(x, yy);
            g.bezierCurveTo(x + len * 0.3, yy + r() * 6 - 3, x + len * 0.7, yy + r() * 6 - 3, x + len, yy);
            g.stroke();
          }
          g.fillStyle = 'rgba(20,10,5,0.55)';
          g.fillRect(x, y, 2, plankH);
          x += len;
        }
        g.fillStyle = 'rgba(20,10,5,0.6)';
        g.fillRect(0, y, 512, 2);
      }
    },
    [5, 5],
  );
}

function brick() {
  const r = rng(11);
  return canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#d8cbb8';
      g.fillRect(0, 0, 512, 512);
      const bh = 32;
      const bw = 96;
      for (let row = 0; row * bh < 512; row++) {
        const off = row % 2 ? bw / 2 : 0;
        for (let x = -off; x < 512; x += bw) {
          g.fillStyle = `hsl(${12 + r() * 10}, ${42 + r() * 12}%, ${38 + r() * 10}%)`;
          g.fillRect(x + 3, row * bh + 3, bw - 6, bh - 6);
        }
      }
    },
    [4, 2.5],
  );
}

function plaster() {
  const r = rng(3);
  return canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#efe4d2';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = `rgba(${150 + r() * 60},${120 + r() * 50},${90 + r() * 40},${0.04 + r() * 0.05})`;
        g.fillRect(r() * 256, r() * 256, 1 + r() * 3, 1 + r() * 3);
      }
    },
    [6, 2],
  );
}

function woodPanel() {
  return canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#5b3a24';
      g.fillRect(0, 0, 256, 256);
      for (let x = 0; x < 256; x += 32) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, 0, 3, 256);
        g.fillStyle = 'rgba(255,220,180,0.06)';
        g.fillRect(x + 3, 0, 10, 256);
      }
    },
    [8, 1],
  );
}

function chalkboard() {
  return canvasTexture(768, 560, (g) => {
    g.fillStyle = '#26302b';
    g.fillRect(0, 0, 768, 560);
    // 粉笔灰
    const r = rng(5);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(255,255,255,${r() * 0.04})`;
      g.fillRect(r() * 768, r() * 560, 2 + r() * 8, 1 + r() * 3);
    }
    g.fillStyle = '#f4efe2';
    g.textAlign = 'center';
    g.font = 'bold 64px "Hiragino Sans GB", "PingFang SC", sans-serif';
    g.fillText('CAFÉ  MENU', 384, 86);
    g.font = '26px "PingFang SC", sans-serif';
    g.fillStyle = '#e8c27a';
    g.fillText('— 今日手冲 · 埃塞俄比亚 耶加雪菲 —', 384, 130);
    const items: Array<[string, string]> = [
      ['美式 Americano', '¥24'],
      ['拿铁 Latte', '¥30'],
      ['卡布奇诺 Cappuccino', '¥30'],
      ['抹茶拿铁 Matcha Latte', '¥32'],
      ['热可可 Hot Cocoa', '¥26'],
      ['提拉米苏 Tiramisu', '¥28'],
    ];
    g.font = '32px "PingFang SC", sans-serif';
    items.forEach(([name, price], i) => {
      const y = 200 + i * 56;
      g.textAlign = 'left';
      g.fillStyle = '#f4efe2';
      g.fillText(name, 80, y);
      g.textAlign = 'right';
      g.fillStyle = '#ffd98e';
      g.fillText(price, 690, y);
      g.fillStyle = 'rgba(244,239,226,0.25)';
      g.fillRect(80, y + 14, 610, 2);
    });
  });
}

/** 窗外：亮的天空、远处的楼和树的剪影（自发光，不受灯光影响） */
function windowView(seed: number) {
  const r = rng(seed);
  return canvasTexture(512, 512, (g) => {
    const sky = g.createLinearGradient(0, 0, 0, 512);
    sky.addColorStop(0, '#cfe3f5');
    sky.addColorStop(0.7, '#f3efe6');
    sky.addColorStop(1, '#e8e1d2');
    g.fillStyle = sky;
    g.fillRect(0, 0, 512, 512);
    for (let x = 0; x < 512; ) {
      const w = 50 + r() * 90;
      const h = 120 + r() * 200;
      g.fillStyle = `rgba(${150 + r() * 30},${160 + r() * 30},${175 + r() * 30},0.55)`;
      g.fillRect(x, 512 - h - 60, w, h);
      x += w + 6;
    }
    g.fillStyle = 'rgba(96,128,86,0.75)';
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(r() * 512, 470 + r() * 30, 40 + r() * 40, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/** 圆形店招：深绿底、奶油色的字和一只咖啡杯 */
function shopSign() {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = '#2c4a3e';
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#e8d9b8';
    g.lineWidth = 8;
    g.beginPath();
    g.arc(256, 256, 226, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#efe4c8';
    g.textAlign = 'center';
    g.font = 'bold 64px Georgia, serif';
    g.fillText('CAFÉ', 256, 190);
    g.font = '34px Georgia, serif';
    g.fillText('— since 2026 —', 256, 400);
    // 杯子
    g.fillRect(196, 236, 120, 86);
    g.beginPath();
    g.arc(320, 279, 26, -Math.PI / 2, Math.PI / 2);
    g.lineWidth = 14;
    g.strokeStyle = '#efe4c8';
    g.stroke();
    g.fillRect(176, 324, 160, 10);
  });
}

export function createCafe(): Backdrop {
  const group = new THREE.Group();
  group.name = 'cafe';
  const disposables: Array<{ dispose(): void }> = [];
  let disposed = false;
  // 模型是异步加载的：换走场景之后才到的，直接释放
  const keep = <T extends { dispose(): void }>(x: T) => {
    if (disposed) x.dispose();
    else disposables.push(x);
    return x;
  };
  /** 防穿墙（最后把程序生成的实体也加进来）。模型到了再往里加包围盒 */
  const colliders: THREE.Object3D[] = [];

  // ---- Poly Pizza 的模型 ----
  const loader = new GLTFLoader();
  const sources = new Map<string, Promise<THREE.Object3D | null>>();
  const load = (file: string) => {
    let p = sources.get(file);
    if (!p) {
      p = loader
        .loadAsync(`${PP}${file}.glb`)
        .then((gltf) => {
          gltf.scene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            keep(mesh.geometry);
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              keep(m);
              for (const v of Object.values(m)) if (v instanceof THREE.Texture) keep(v);
            }
          });
          return gltf.scene;
        })
        .catch(() => null);
      sources.set(file, p);
    }
    return p;
  };
  /**
   * 放一个模型：先绕竖轴转 ry，再按包围盒缩放到 h 米高，底部落在 y、水平中心在 (x, z)。
   * solid = 挡镜头（包围盒当碰撞体）。
   * wall = 贴墙放：包围盒的这一边贴到这个坐标上（minX 左墙、maxX 右墙、maxZ 前墙），对应的 x / z 不用；
   * centerY = y 是包围盒中心的高度（挂在墙上的东西）；
   * fitW = 宽度也拉到这么宽（沿 fitAxis，非等比缩放）：窗框要正好罩住后面那块窗外的画。
   * 第一版窗框按高度等比缩放，宽窄和窗洞对不上，窗外的画从窗框两边露出来
   */
  const place = (
    file: string,
    x: number,
    y: number,
    z: number,
    h: number,
    ry = 0,
    solid = false,
    opts: { minX?: number; maxX?: number; maxZ?: number; centerY?: boolean; fitW?: number; fitAxis?: 'x' | 'z' } = {},
  ) =>
    load(file).then((src) => {
      if (!src || disposed) return null;
      // 模型自己绕竖轴转，外面套一层不转的壳来缩放 —— 非等比缩放才是沿世界坐标轴的
      const inner = src.clone(true);
      inner.rotation.y = ry;
      const o = new THREE.Group();
      o.add(inner);
      o.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(o);
      const k = h / Math.max(1e-6, box.max.y - box.min.y);
      o.scale.setScalar(k);
      if (opts.fitW != null) {
        const axis = opts.fitAxis ?? 'x';
        const span = axis === 'x' ? box.max.x - box.min.x : box.max.z - box.min.z;
        o.scale[axis] = opts.fitW / Math.max(1e-6, span);
      }
      o.updateMatrixWorld(true);
      box.setFromObject(o);
      const px =
        opts.minX != null ? opts.minX - box.min.x : opts.maxX != null ? opts.maxX - box.max.x : x - (box.min.x + box.max.x) / 2;
      const pz = opts.maxZ != null ? opts.maxZ - box.max.z : z - (box.min.z + box.max.z) / 2;
      const py = opts.centerY ? y - (box.min.y + box.max.y) / 2 : y - box.min.y;
      o.position.set(px, py, pz);
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      group.add(o);
      if (solid) {
        o.updateMatrixWorld(true);
        box.setFromObject(o);
        const size = box.getSize(new THREE.Vector3());
        const c = new THREE.Mesh(keep(new THREE.BoxGeometry(size.x, size.y, size.z)));
        box.getCenter(c.position);
        c.updateMatrixWorld();
        colliders.push(c);
      }
      return o;
    });

  // 所有面都接收阴影，实心的东西也投影（主光的软阴影，见 stage.ts）
  const shaded = <T extends THREE.Mesh>(mesh: T) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const mat = (opts: THREE.MeshStandardMaterialParameters) => keep(new THREE.MeshStandardMaterial({ roughness: 0.8, ...opts }));
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = shaded(new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), m));
    mesh.position.set(x, y, z);
    return mesh;
  };
  const cyl = (rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, seg = 24) => {
    const mesh = shaded(new THREE.Mesh(keep(new THREE.CylinderGeometry(rt, rb, h, seg)), m));
    mesh.position.set(x, y, z);
    return mesh;
  };

  // ---- 材质 ----
  const floorMat = mat({ map: keep(woodFloor()), roughness: 0.7 });
  const plasterMat = mat({ map: keep(plaster()) });
  const brickMat = mat({ map: keep(brick()), roughness: 0.95 });
  const panelMat = mat({ map: keep(woodPanel()), roughness: 0.6 });
  const darkWood = mat({ color: 0x4a2f1d, roughness: 0.55 });
  const lightWood = mat({ color: 0xb98a5e, roughness: 0.5 });
  const ceilingMat = mat({ color: 0x3b2a1f, roughness: 0.9 });
  const ceramic = mat({ color: 0xf7f3ec, roughness: 0.35 });

  // ---- 房间 ----
  // 地板：Quaternius 的木地板块（1m 一块）铺满 10m × 10m，隔一块转半圈打散重复感。
  // 块到了之前先用 canvas 画的木地板顶着；到了以后它只留着当防穿墙的碰撞面
  const floor = shaded(new THREE.Mesh(keep(new THREE.PlaneGeometry(W, D)), floorMat));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, BACK + D / 2);
  void load('wood_floor').then((src) => {
    if (!src || disposed) return;
    src.updateMatrixWorld(true);
    // 把块里的网格烘成一个几何体（带上节点自己的变换），缩到 1m 见方、顶面在 y = 0
    const parts: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 原色是很亮的浅橙木色，和深色墙裙、暖光的店不搭：压暗一点
      const mat = keep((mesh.material as THREE.MeshStandardMaterial).clone());
      mat.color.multiplyScalar(0.72);
      parts.push({ geo: keep(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)), mat });
    });
    const box = new THREE.Box3();
    for (const p of parts) box.union(new THREE.Box3().setFromBufferAttribute(p.geo.attributes.position as THREE.BufferAttribute));
    const k = 1 / Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const p of parts) {
      p.geo.translate(-(box.min.x + box.max.x) / 2, -box.max.y, -(box.min.z + box.max.z) / 2);
      p.geo.scale(k, k, k);
      const im = new THREE.InstancedMesh(p.geo, p.mat, W * D);
      let i = 0;
      for (let ix = 0; ix < W; ix++)
        for (let iz = 0; iz < D; iz++) {
          q.setFromAxisAngle(up, ((ix + iz) % 2) * Math.PI);
          im.setMatrixAt(i++, m.compose(new THREE.Vector3(-W / 2 + ix + 0.5, 0, BACK + iz + 0.5), q, new THREE.Vector3(1, 1, 1)));
        }
      im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
    }
    floor.visible = false;
  });
  const ceiling = shaded(new THREE.Mesh(keep(new THREE.PlaneGeometry(W, D)), ceilingMat));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, H, BACK + D / 2);
  for (let z = BACK + 1; z < FRONT; z += 2) box(W, 0.18, 0.16, darkWood, 0, H - 0.09, z); // 梁

  const wall = (w: number, m: THREE.Material, x: number, z: number, ry: number) => {
    const mesh = shaded(new THREE.Mesh(keep(new THREE.PlaneGeometry(w, H)), m));
    mesh.position.set(x, H / 2, z);
    mesh.rotation.y = ry;
    return mesh;
  };
  wall(W, plasterMat, 0, BACK, 0); // 后墙
  wall(D, plasterMat, -W / 2, BACK + D / 2, Math.PI / 2); // 左墙
  wall(D, brickMat, W / 2, BACK + D / 2, -Math.PI / 2); // 右墙（砖）
  wall(W, plasterMat, 0, FRONT, Math.PI); // 前墙
  // 墙裙：下半截深色木板
  box(W, 1.0, 0.04, panelMat, 0, 0.5, BACK + 0.02);
  box(0.04, 1.0, D, panelMat, -W / 2 + 0.02, 0.5, BACK + D / 2);
  box(W, 1.0, 0.04, panelMat, 0, 0.5, FRONT - 0.02);

  // ---- 吧台（身后）----
  const counterZ = BACK + 1.3;
  box(5.2, 0.98, 0.62, panelMat, 0, 0.49, counterZ); // 台身
  box(5.35, 0.05, 0.74, lightWood, 0, 1.0, counterZ); // 台面
  box(5.2, 0.06, 0.05, darkWood, 0, 0.06, counterZ + 0.3); // 踢脚

  // 咖啡机（右边，不在头后面）：意式咖啡机，旁边一排咖啡杯、一杯星冰乐
  const mx = 1.75;
  const counterTop = 1.025;
  // 正面（冲煮头、旋钮）朝里，对着吧台里的咖啡师（模型默认就朝 -Z）；客人那边看到的是机身背面
  void place('espresso_machine', mx, counterTop, counterZ - 0.06, 0.46, 0);
  for (let i = 0; i < 3; i++) void place('cup_tea', mx + 0.42 + i * 0.13, counterTop, counterZ + 0.08 - (i % 2) * 0.06, 0.075, 0.6 + i * 1.3);
  void place('frappe', mx - 0.52, counterTop, counterZ + 0.05, 0.2);

  // 蛋糕罩
  const glass = mat({ color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1 });
  const cx = -1.45;
  cyl(0.24, 0.24, 0.025, lightWood, cx, 1.04, counterZ, 32);
  const dome = shaded(new THREE.Mesh(keep(new THREE.SphereGeometry(0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), glass));
  dome.castShadow = false; // 玻璃不投影
  dome.position.set(cx, 1.05, counterZ);
  dome.scale.y = 1.3;
  void place('cake', cx, 1.053, counterZ, 0.13, 0.4);
  // 一盘甜点：可颂、玛芬、甜甜圈、纸杯蛋糕
  const px = cx + 0.62;
  cyl(0.2, 0.2, 0.015, ceramic, px, counterTop + 0.008, counterZ + 0.04, 32);
  void place('croissant', px - 0.08, counterTop + 0.016, counterZ - 0.02, 0.05, 0.5);
  void place('muffin', px + 0.09, counterTop + 0.016, counterZ - 0.03, 0.075);
  void place('donut_sprinkles', px - 0.06, counterTop + 0.016, counterZ + 0.11, 0.035, 1.2);
  void place('cupcake', px + 0.08, counterTop + 0.016, counterZ + 0.12, 0.09);

  // ---- 后墙：置物架 + 黑板菜单 ----
  const shelfX = 2.35;
  const jarColors = [0x7a4b2a, 0xd9c7a3, 0x3f2a1c, 0xa8693c, 0xefe8da, 0x2f4f3a];
  const r = rng(21);
  for (const y of [1.48, 1.86, 2.24]) {
    box(2.2, 0.04, 0.26, darkWood, shelfX, y, BACK + 0.14);
    let x = shelfX - 0.98;
    while (x < shelfX + 0.98) {
      const kind = r();
      if (kind < 0.45) {
        const h = 0.14 + r() * 0.1;
        cyl(0.05, 0.05, h, mat({ color: jarColors[Math.floor(r() * jarColors.length)], roughness: 0.4 }), x, y + 0.02 + h / 2, BACK + 0.14, 16);
        x += 0.14;
      } else if (kind < 0.75) {
        void place('cup', x, y + 0.02, BACK + 0.14, 0.075, r() * 6);
        x += 0.12;
      } else {
        // 一小盆绿植
        void place(r() < 0.5 ? 'houseplant_3' : 'houseplant_2', x, y + 0.02, BACK + 0.14, 0.2, r() * 6);
        x += 0.18;
      }
    }
  }
  const board = shaded(new THREE.Mesh(keep(new THREE.PlaneGeometry(1.5, 1.09)), mat({ map: keep(chalkboard()), roughness: 0.95 })));
  board.position.set(-2.3, 1.95, BACK + 0.03);
  box(1.6, 1.19, 0.03, darkWood, -2.3, 1.95, BACK + 0.012); // 框

  // 头后面：一块素墙，只在高处挂一块圆形店招。挂在 2.78m —— 低了会正好压在头顶，像个光环；
  // 这个高度在半身景别里出画，拉远看全身时才看到
  const sign = shaded(new THREE.Mesh(keep(new THREE.CircleGeometry(0.36, 48)), mat({ map: keep(shopSign()), roughness: 0.6 })));
  sign.position.set(0, 2.78, BACK + 0.04);
  cyl(0.39, 0.39, 0.03, darkWood, 0, 2.78, BACK + 0.02, 48).rotation.x = Math.PI / 2;

  // ---- 吊灯（吧台上方）----
  const lights: THREE.Light[] = [];
  const bulbMat = keep(new THREE.MeshBasicMaterial({ color: 0xffe2a8 }));
  // 两盏，分在店招两侧（第一版正中那盏正好挡住店招）。灯罩是模型，从天花板吊下来，底边在 2.3m
  for (const lx of [-1.25, 1.25]) {
    const ly = 2.35;
    const lz = counterZ;
    void place('light_ceiling', lx, ly - 0.06, lz, H - (ly - 0.06));
    const bulb = new THREE.Mesh(keep(new THREE.SphereGeometry(0.045, 16, 8)), bulbMat);
    bulb.position.set(lx, ly - 0.03, lz);
    group.add(bulb);
    const p = new THREE.PointLight(0xffc98a, 2.8, 6, 2);
    p.position.set(lx, ly - 0.08, lz);
    lights.push(p);
  }

  // ---- 左墙：两扇大窗 ----
  for (const wz of [-1.6, 2.0]) {
    const view = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(2.0, 1.7)),
      keep(new THREE.MeshBasicMaterial({ map: keep(windowView(Math.round(wz * 10) + 40)) })),
    );
    view.position.set(-W / 2 + 0.03, 1.75, wz);
    view.rotation.y = Math.PI / 2;
    group.add(view);
    // 窗框：Quaternius 的白色格子窗（模型里的玻璃是不透明的，改成半透明才看得见窗外）；窗台保留
    const fx = -W / 2 + 0.06;
    // 窗外的画 2.0 × 1.7，窗框比它四周各大 8cm，正好压住画的边
    void place('window_large', 0, 1.75, wz, 1.86, WINDOW_RY, false, { minX: -W / 2 + 0.005, centerY: true, fitW: 2.16, fitAxis: 'z' }).then(glassy);
    box(0.12, 0.08, 2.2, lightWood, fx + 0.03, 0.88, wz); // 窗台
    // 窗台上的小盆栽
    for (const [dz, file] of [
      [-0.6, 'houseplant_1'],
      [0.5, 'houseplant_3'],
    ] as const)
      void place(file, fx + 0.09, 0.92, wz + dz, 0.34, dz * 3);
  }
  const windowLight = new THREE.DirectionalLight(0xe4eeff, 0.45);
  windowLight.position.set(-4, 2.2, 0.2);
  lights.push(windowLight);

  // ---- 右墙：两幅挂画、挂钟（CC-BY，署名在 CREDITS.md）、一个书架 ----
  void place('wall_painting_1', 0, 1.8, -1.6, 0.95, PAINTING_1_RY, false, { maxX: W / 2 - 0.01, centerY: true });
  void place('wall_painting_2', 0, 1.8, -0.4, 0.8, PAINTING_2_RY, false, { maxX: W / 2 - 0.01, centerY: true });
  void place('analog_clock', 0, 2.15, 1.6, 0.42, CLOCK_RY, false, { maxX: W / 2 - 0.01, centerY: true });
  void place('bookcase_books', 0, 0, 3.4, 1.9, BOOKCASE_RY, true, { maxX: W / 2 - 0.02 });

  // ---- 前墙：双开木门 + 小窗，门边一个衣帽架 ----
  void place('door_double', 1.8, 0, 0, 2.3, DOOR_RY, true, { maxZ: FRONT - 0.01 });
  void place('window_small', -1.8, 1.7, 0, 1.36, WINDOW_SMALL_RY, false, { maxZ: FRONT - 0.005, centerY: true, fitW: 1.76, fitAxis: 'x' }).then(glassy);
  void place('coat_rack_standing', 0.35, 0, FRONT - 0.45, 1.75, 0.4, true);
  const fview = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.6, 1.2)), keep(new THREE.MeshBasicMaterial({ map: keep(windowView(77)) })));
  fview.position.set(-1.8, 1.7, FRONT - 0.03);
  fview.rotation.y = Math.PI;
  group.add(fview);

  // ---- 桌椅（不挡在镜头和角色之间：都在两侧和身后两侧）----
  // 圆桌 + 两把椅子（椅子面朝桌子），桌上一杯咖啡或星冰乐；一张桌子底下铺圆地毯
  const table = (x: number, z: number, k: number) => {
    void place('round_table', x, 0, z, 0.74, k, true);
    void place(k % 2 ? 'frappe' : 'cup_tea', x + 0.08, 0.74, z - 0.05, k % 2 ? 0.2 : 0.075, k);
    for (const a of [0.4 + k * 0.3, Math.PI + 0.4 + k * 0.3]) {
      const ccx = x + Math.cos(a) * 0.68;
      const ccz = z + Math.sin(a) * 0.68;
      void place('chair', ccx, 0, ccz, 0.95, Math.atan2(x - ccx, z - ccz) + CHAIR_FACING, true);
    }
  };
  table(-2.6, -1.4, 0);
  table(2.9, -0.6, 1);
  table(2.6, 2.9, 3);
  // 窗边的沙发角（左前方）：沙发靠墙、茶几上一本书、对面一把休闲椅，底下圆地毯
  void place('couch_medium', 0, 0, 2.0, 0.85, COUCH_RY, true, { minX: -W / 2 + 0.08 });
  void place('rug_round', -3.4, 0.003, 2.0, 0.02);
  void place('coffee_table', -3.35, 0, 2.0, 0.42, Math.PI / 2, true);
  void place('book', -3.3, 0.42, 1.85, 0.05, 0.5);
  void place('cup_tea', -3.4, 0.42, 2.25, 0.075, 2.0);
  void place('lounge_chair', -2.15, 0, 2.15, 0.85, LOUNGE_RY, true);
  // 吧台前两把吧台凳（都在头后面那块的两边）
  for (const [x, ry] of [
    [-2.15, 0.3],
    [2.35, -0.5],
  ] as const)
    void place('bar_stool', x, 0, counterZ + 0.62, 0.78, ry, true);
  // 吧台左边一组花瓶（CC-BY）
  void place('vase', -1.95, counterTop, counterZ - 0.08, 0.22, 0);
  // 吧台左端一盏小台灯
  void place('lamp_round_table', -2.35, counterTop, counterZ - 0.05, 0.36, 0.3);

  // ---- 角落的大盆栽 ----
  for (const [x, z, file, h] of [
    [-4.4, BACK + 0.6, 'houseplant_1', 1.25],
    [4.4, BACK + 0.6, 'houseplant_2', 1.1],
    [4.3, FRONT - 0.7, 'houseplant_3', 1.2],
  ] as const)
    void place(file, x, 0, z, h, x * 0.7, true);

  // ---- 脚下的接触阴影：主光的投影之外，脚底和地面接触处再压暗一点，人才"站在地上" ----
  const shadowTex = keep(
    canvasTexture(128, 128, (g) => {
      const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, 'rgba(0,0,0,0.5)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    }),
  );
  const shadow = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(0.9, 0.6)),
    keep(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.002, 0);
  group.add(shadow);

  // 防穿墙：除了脚下阴影、灯泡这类没有实体的，其余都挡镜头（模型的包围盒在加载完时加进来）
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o !== shadow && (o as THREE.Mesh).material !== bulbMat) colliders.push(o);
  });

  return {
    group,
    lights,
    colliders,
    hemisphere: { sky: 0xffe9cf, ground: 0x6b4a32, intensity: 0.8 },
    // 很淡的暖色雾：角色离相机 1.6m 基本不受影响，5m 外的后墙对比度降一点，背景退后、视线落在人身上
    fog: new THREE.Fog(0x8a6a50, 2.5, 22),
    environment: { url: `${import.meta.env.BASE_URL}scene/hdri/wooden_lounge_1k.hdr`, intensity: 0.5 },
    shadowBounds: 3,
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose();
    },
  };
}
