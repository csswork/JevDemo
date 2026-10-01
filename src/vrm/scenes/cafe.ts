import * as THREE from 'three';

/**
 * 背景场景：一家小咖啡店的店内。全部程序生成（几何体 + canvas 画的贴图），没有外部模型和材质素材。
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

export interface Backdrop {
  group: THREE.Group;
  /** 场景里额外的灯（会被加进舞台） */
  lights: THREE.Light[];
  /** 镜头不能穿过的东西（墙、地、吧台、桌椅……），舞台用来做防穿墙 */
  colliders: THREE.Object3D[];
  /** 场景开着时半球光换成的颜色（让角色的环境光和店里的色调一致） */
  hemisphere: { sky: number; ground: number; intensity: number };
  fog: THREE.Fog;
  /** 环境光（IBL）用的 HDRI，舞台负责转成 PMREM；intensity = scene.environmentIntensity */
  environment: { url: string; intensity: number };
  /** 投影的范围：舞台的主光只在这个盒子里算阴影（角色和身边的东西） */
  shadowBounds: number;
  dispose(): void;
}

/** canvas 画一张贴图 */
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

/** 可复现的伪随机（每次打开店里的摆设都一样） */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
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

function painting(seed: number) {
  const r = rng(seed);
  return canvasTexture(256, 320, (g) => {
    g.fillStyle = `hsl(${30 + r() * 30}, 35%, 82%)`;
    g.fillRect(0, 0, 256, 320);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `hsla(${r() * 360}, 40%, ${45 + r() * 25}%, 0.8)`;
      g.beginPath();
      g.arc(40 + r() * 176, 50 + r() * 220, 20 + r() * 60, 0, Math.PI * 2);
      g.fill();
    }
  });
}

export function createCafe(): Backdrop {
  const group = new THREE.Group();
  group.name = 'cafe';
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

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
  const metal = mat({ color: 0xc9c9cc, metalness: 0.9, roughness: 0.28 });
  const blackMetal = mat({ color: 0x1d1d1f, metalness: 0.6, roughness: 0.45 });
  const ceramic = mat({ color: 0xf7f3ec, roughness: 0.35 });
  const leaf = mat({ color: 0x4f7a3f, roughness: 0.85 });
  const pot = mat({ color: 0xb9653f, roughness: 0.75 });

  // ---- 房间 ----
  const floor = shaded(new THREE.Mesh(keep(new THREE.PlaneGeometry(W, D)), floorMat));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, BACK + D / 2);
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

  // 咖啡机（右边，不在头后面）
  const mx = 1.75;
  box(0.62, 0.42, 0.42, metal, mx, 1.24, counterZ - 0.05);
  box(0.66, 0.06, 0.46, blackMetal, mx, 1.48, counterZ - 0.05);
  for (const dx of [-0.15, 0.15]) {
    cyl(0.035, 0.035, 0.08, blackMetal, mx + dx, 1.08, counterZ + 0.12, 12);
    cyl(0.04, 0.034, 0.07, ceramic, mx + dx, 1.06, counterZ + 0.14, 16); // 杯子
  }
  // 一摞杯子
  for (let i = 0; i < 4; i++) cyl(0.045, 0.036, 0.065, ceramic, mx + 0.42, 1.06 + i * 0.062, counterZ - 0.1, 16);
  // 磨豆机
  cyl(0.07, 0.08, 0.26, blackMetal, mx - 0.48, 1.16, counterZ - 0.12, 16);
  cyl(0.06, 0.03, 0.12, mat({ color: 0x6b4226, transparent: true, opacity: 0.85 }), mx - 0.48, 1.35, counterZ - 0.12, 16);

  // 蛋糕罩
  const glass = mat({ color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1 });
  const cx = -1.45;
  cyl(0.24, 0.24, 0.025, lightWood, cx, 1.04, counterZ, 32);
  const dome = shaded(new THREE.Mesh(keep(new THREE.SphereGeometry(0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), glass));
  dome.castShadow = false; // 玻璃不投影
  dome.position.set(cx, 1.05, counterZ);
  dome.scale.y = 1.3;
  cyl(0.15, 0.15, 0.1, mat({ color: 0xead2a8 }), cx, 1.1, counterZ, 24);
  cyl(0.15, 0.15, 0.025, mat({ color: 0x5a2f1c }), cx, 1.165, counterZ, 24);

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
        cyl(0.045, 0.036, 0.065, ceramic, x, y + 0.055, BACK + 0.14, 16);
        x += 0.12;
      } else {
        // 一小盆绿植
        cyl(0.05, 0.04, 0.08, pot, x, y + 0.06, BACK + 0.14, 12);
        const s = shaded(new THREE.Mesh(keep(new THREE.IcosahedronGeometry(0.08, 0)), leaf));
        s.position.set(x, y + 0.16, BACK + 0.14);
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
  const shadeMat = mat({ color: 0x2c4a3e, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  // 两盏，分在店招两侧（第一版正中那盏正好挡住店招）
  for (const lx of [-1.25, 1.25]) {
    const ly = 2.35;
    const lz = counterZ;
    cyl(0.004, 0.004, H - ly - 0.1, blackMetal, lx, (H + ly) / 2 + 0.05, lz, 6); // 吊线
    const shade = shaded(new THREE.Mesh(keep(new THREE.ConeGeometry(0.17, 0.18, 24, 1, true)), shadeMat));
    shade.position.set(lx, ly + 0.05, lz);
    const bulb = new THREE.Mesh(keep(new THREE.SphereGeometry(0.05, 16, 8)), bulbMat);
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
    // 窗框和窗格
    const fx = -W / 2 + 0.06;
    box(0.08, 0.08, 2.12, darkWood, fx, 2.64, wz);
    box(0.12, 0.08, 2.2, lightWood, fx + 0.03, 0.88, wz); // 窗台
    box(0.08, 1.8, 0.08, darkWood, fx, 1.75, wz - 1.04);
    box(0.08, 1.8, 0.08, darkWood, fx, 1.75, wz + 1.04);
    box(0.06, 1.7, 0.05, darkWood, fx, 1.75, wz);
    box(0.06, 0.05, 2.0, darkWood, fx, 1.85, wz);
    // 窗台上的小盆栽
    for (const dz of [-0.6, 0.5]) {
      cyl(0.08, 0.06, 0.12, pot, fx + 0.08, 0.99, wz + dz, 12);
      const s = shaded(new THREE.Mesh(keep(new THREE.IcosahedronGeometry(0.12, 0)), leaf));
      s.position.set(fx + 0.08, 1.14, wz + dz);
    }
  }
  const windowLight = new THREE.DirectionalLight(0xe4eeff, 0.45);
  windowLight.position.set(-4, 2.2, 0.2);
  lights.push(windowLight);

  // ---- 右墙：挂画 + 挂钟 ----
  for (const [pz, seed] of [
    [-1.6, 31],
    [-0.4, 47],
  ] as const) {
    const pic = shaded(new THREE.Mesh(keep(new THREE.PlaneGeometry(0.7, 0.88)), mat({ map: keep(painting(seed)) })));
    pic.position.set(W / 2 - 0.04, 1.8, pz);
    pic.rotation.y = -Math.PI / 2;
    box(0.03, 0.96, 0.78, darkWood, W / 2 - 0.02, 1.8, pz);
  }
  const clock = cyl(0.22, 0.22, 0.04, ceramic, W / 2 - 0.04, 2.15, 1.6, 32);
  clock.rotation.z = Math.PI / 2;

  // ---- 前墙：门 + 小窗 ----
  box(1.0, 2.2, 0.06, darkWood, 1.8, 1.1, FRONT - 0.04);
  cyl(0.025, 0.025, 0.12, metal, 1.42, 1.05, FRONT - 0.1, 8).rotation.x = Math.PI / 2;
  const fview = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.6, 1.2)), keep(new THREE.MeshBasicMaterial({ map: keep(windowView(77)) })));
  fview.position.set(-1.8, 1.7, FRONT - 0.03);
  fview.rotation.y = Math.PI;
  group.add(fview);

  // ---- 桌椅（不挡在镜头和角色之间：都在两侧和身后两侧）----
  const table = (x: number, z: number) => {
    cyl(0.38, 0.38, 0.04, lightWood, x, 0.74, z, 32);
    cyl(0.03, 0.03, 0.72, blackMetal, x, 0.37, z, 12);
    cyl(0.2, 0.22, 0.03, blackMetal, x, 0.015, z, 24);
    cyl(0.045, 0.036, 0.065, ceramic, x + 0.1, 0.79, z - 0.05, 16);
    for (const a of [0.4, Math.PI + 0.4]) {
      const ccx = x + Math.cos(a) * 0.62;
      const ccz = z + Math.sin(a) * 0.62;
      cyl(0.2, 0.2, 0.04, darkWood, ccx, 0.46, ccz, 24);
      for (const [lx, lz] of [
        [-0.12, -0.12],
        [0.12, -0.12],
        [-0.12, 0.12],
        [0.12, 0.12],
      ]) {
        cyl(0.015, 0.015, 0.46, blackMetal, ccx + lx, 0.23, ccz + lz, 6);
      }
      const back = box(0.36, 0.34, 0.03, darkWood, ccx, 0.68, ccz);
      back.position.x += Math.cos(a) * 0.18;
      back.position.z += Math.sin(a) * 0.18;
      back.lookAt(x, 0.68, z);
    }
  };
  table(-2.6, -1.4);
  table(2.9, -0.6);
  table(-2.9, 2.0);
  table(2.6, 2.9);

  // ---- 角落的大盆栽 ----
  for (const [x, z] of [
    [-4.4, BACK + 0.6],
    [4.4, BACK + 0.6],
    [4.3, FRONT - 0.7],
  ]) {
    cyl(0.22, 0.17, 0.42, pot, x, 0.21, z, 16);
    for (let i = 0; i < 5; i++) {
      const s = shaded(new THREE.Mesh(keep(new THREE.IcosahedronGeometry(0.26 - i * 0.025, 0)), leaf));
      s.position.set(x + Math.sin(i * 2.1) * 0.12, 0.62 + i * 0.22, z + Math.cos(i * 2.1) * 0.12);
      s.rotation.set(i, i * 0.7, 0);
    }
  }

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

  // 防穿墙：除了脚下阴影、灯泡这类没有实体的，其余都挡镜头
  const colliders: THREE.Object3D[] = [];
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
      for (const d of disposables) d.dispose();
    },
  };
}
