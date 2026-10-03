import * as THREE from 'three';
import { canvasTexture, rng } from './common';

/**
 * 街景的玻璃（street.ts 用）：
 *
 *   室内映射（interior mapping）  店面和住家的窗。玻璃后面是一个虚拟的房间：片元着色器里按视线求和房间盒子
 *        （后墙、两面侧墙、地板、天花板）的交点，去房间图集里取那一面的颜色；中间再插一层家具的剪影（桌椅、货架、沙发）。
 *        转动镜头时有真实的视差（看得到侧墙、地板往里延伸），不用建真的室内模型。同一栋楼同一层的几扇窗共用一个房间，
 *        店里的架子、地板连成一片。住家的窗前面再加一层窗帘（程序画的，拉开一半、或者一层白纱）
 *   透明玻璃  她身边那家咖啡店（真的 3D 室内，street.ts 里摆的桌椅、吧台、咖啡机）。透过去看得到店里，斜着看反射天空
 *
 * 两种都是 MeshStandardMaterial 的反射通道（粗糙度很低）：正对着看几乎透明（菲涅耳 4%），斜着看反射 HDRI 的天和云，
 * 太阳的高光也是它自己算的。第一版是画在立面贴图上的店内，和墙在同一个平面上，没有纵深、没有反射，近看是一张糊的海报
 */

type Keep = <T extends { dispose(): void }>(x: T) => T;

/** 房间的种类 = 房间图集的行 */
export const ROOMS = ['cafe', 'pottery', 'souvenir', 'clothes', 'flower', 'home', 'home2'] as const;
export type RoomKind = (typeof ROOMS)[number];
/** 每个房间五个面 = 图集的列：后墙、侧墙、地板、天花板、家具（带透明） */
const FACES = 5;
const RC = 256;

type G = CanvasRenderingContext2D;
type R = () => number;

const shade = (g: G, x: number, y: number, w: number, h: number, top: string, bottom: string) => {
  const grd = g.createLinearGradient(0, y, 0, y + h);
  grd.addColorStop(0, top);
  grd.addColorStop(1, bottom);
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
};
const glow = (g: G, x: number, y: number, rad: number, color: string) => {
  const grd = g.createRadialGradient(x, y, 0, x, y, rad);
  grd.addColorStop(0, color);
  grd.addColorStop(1, 'rgba(255,230,180,0)');
  g.fillStyle = grd;
  g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
};
/** 架子上的一排东西（瓶、罐、碗、盒子……） */
const shelfItems = (g: G, r: R, x0: number, x1: number, y: number, kind: RoomKind) => {
  g.fillStyle = '#6e4c35';
  g.fillRect(x0, y, x1 - x0, 5);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(x0, y + 5, x1 - x0, 4);
  let x = x0 + 3 + r() * 5;
  while (x < x1 - 10) {
    const w = 7 + r() * 10;
    const h = 10 + r() * 18;
    if (kind === 'cafe') g.fillStyle = ['#c98a3a', '#f6f2ea', '#e9dcc0', '#7a4a2a', '#5e9a4a', '#d9c7a0'][Math.floor(r() * 6)];
    else if (kind === 'pottery') g.fillStyle = ['#3d5f9c', '#eef1f4', '#8a5a3c', '#6f8fb8', '#c9b79a', '#2f3a4a'][Math.floor(r() * 6)];
    else if (kind === 'souvenir') g.fillStyle = ['#e2574c', '#f2c14e', '#4f9bd9', '#f6f2ea', '#7cbf6a', '#e88fb0'][Math.floor(r() * 6)];
    else g.fillStyle = ['#d9cbb6', '#8a6a52', '#efe6d8', '#6a7a8a'][Math.floor(r() * 4)];
    if (kind === 'pottery' && r() < 0.5) {
      g.beginPath();
      g.ellipse(x + w / 2, y - h * 0.4, w / 2 + 2, h * 0.42, 0, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillRect(x, y - h, w, h);
      g.fillStyle = 'rgba(255,255,255,0.3)';
      g.fillRect(x + 1.5, y - h + 2, 2, h - 4);
    }
    x += w + 2 + r() * 4;
  }
};
const planks = (g: G, r: R, base: number, light: number, horizontal = true) => {
  for (let k = 0; k < 8; k++) {
    g.fillStyle = `hsl(${26 + r() * 6}, ${32 + r() * 10}%, ${base + r() * light}%)`;
    if (horizontal) g.fillRect(0, k * 32, RC, 31);
    else g.fillRect(k * 32, 0, 31, RC);
  }
};

/** 每个面的画法：(g, r, kind) 画在 0..RC 的格子里。图集是 sRGB 的颜色，店里的灯光也画进去（玻璃的着色器当自发光输出） */
const FACE_PAINTERS: Array<(g: G, r: R, kind: RoomKind) => void> = [
  // 后墙（横向可平铺：一张 = 3m 宽）
  (g, r, kind) => {
    const home = kind === 'home' || kind === 'home2';
    shade(g, 0, 0, RC, RC, home ? '#efe6d6' : kind === 'clothes' || kind === 'souvenir' ? '#f4f1ea' : '#f2dcb4', home ? '#cfc2ac' : '#c9a77c');
    if (kind === 'cafe') {
      // 木墙裙、两层架子、一块黑板菜单、壁灯
      planks(g, r, 28, 8, false);
      shade(g, 0, 0, RC, 150, '#f4dfb8', '#e2c493');
      shelfItems(g, r, 10, 120, 80, kind);
      shelfItems(g, r, 10, 120, 118, kind);
      g.fillStyle = '#5a3a26';
      g.fillRect(140, 50, 96, 78);
      g.fillStyle = '#26302c';
      g.fillRect(146, 56, 84, 66);
      g.strokeStyle = 'rgba(240,240,230,0.8)';
      g.lineWidth = 2;
      for (let k = 0; k < 5; k++) {
        g.beginPath();
        g.moveTo(154, 68 + k * 11);
        g.lineTo(154 + 30 + r() * 30, 68 + k * 11);
        g.stroke();
      }
      glow(g, 128, 40, 40, 'rgba(255,225,160,0.9)');
    } else if (kind === 'pottery' || kind === 'souvenir') {
      for (const y of [70, 112, 154, 196]) shelfItems(g, r, 6, 250, y, kind);
      g.fillStyle = '#6e4c35';
      for (const x of [4, 126, 248]) g.fillRect(x, 50, 5, 160);
    } else if (kind === 'clothes') {
      // 挂衣杆上一排衣服
      g.fillStyle = '#9aa0a6';
      g.fillRect(10, 70, 236, 4);
      for (let x = 14; x < 240; x += 13) {
        g.fillStyle = ['#4f9bd9', '#f6f2ea', '#e2574c', '#f2c14e', '#2f3a8f', '#7cbf6a', '#e88fb0'][Math.floor(r() * 7)];
        g.beginPath();
        g.moveTo(x, 74);
        g.lineTo(x + 12, 74);
        g.lineTo(x + 11, 74 + 55 + r() * 30);
        g.lineTo(x + 1, 74 + 55 + r() * 30);
        g.fill();
      }
      shelfItems(g, r, 10, 246, 196, 'souvenir');
    } else if (kind === 'flower') {
      for (let k = 0; k < 60; k++) {
        g.fillStyle = r() < 0.6 ? `hsl(${100 + r() * 30}, 40%, ${28 + r() * 18}%)` : ['#e2574c', '#f2c14e', '#f08fb0', '#ffffff', '#9b6bd0'][Math.floor(r() * 5)];
        g.beginPath();
        g.arc(r() * RC, 60 + r() * 150, 5 + r() * 10, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      // 住家：一个矮柜、墙上一幅画、门框
      g.fillStyle = '#8a6a52';
      g.fillRect(30, 170, 110, 60);
      g.fillStyle = '#6e5440';
      g.fillRect(30, 196, 110, 3);
      g.fillStyle = '#5a6a7a';
      g.fillRect(56, 80, 60, 44);
      g.fillStyle = '#d9cbb6';
      g.fillRect(60, 84, 52, 36);
      g.fillStyle = kind === 'home2' ? '#c9b8a0' : '#b8a68c';
      g.fillRect(170, 60, 60, 196);
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(170, 60, 3, 196);
    }
    // 踢脚线
    g.fillStyle = 'rgba(60,40,30,0.5)';
    g.fillRect(0, 244, RC, 12);
  },
  // 侧墙（u = 从窗边往里，不平铺）
  (g, r, kind) => {
    const home = kind === 'home' || kind === 'home2';
    shade(g, 0, 0, RC, RC, home ? '#ece2d0' : kind === 'cafe' ? '#b46a4a' : '#efebe2', home ? '#c8baa2' : kind === 'cafe' ? '#7a4632' : '#c9c2b4');
    if (kind === 'cafe') {
      // 砖墙 + 两幅挂画
      for (let y = 0; y < RC; y += 16)
        for (let x = (y / 16) % 2 ? -12 : 0; x < RC; x += 24) {
          g.fillStyle = `hsl(${12 + r() * 10}, ${38 + r() * 12}%, ${34 + r() * 10}%)`;
          g.fillRect(x + 1, y + 1, 22, 14);
        }
      for (const x of [50, 160]) {
        g.fillStyle = '#3a2a20';
        g.fillRect(x, 70, 50, 40);
        g.fillStyle = ['#7aa6c8', '#d9b77a'][x > 100 ? 1 : 0];
        g.fillRect(x + 4, 74, 42, 32);
      }
    } else if (!home) {
      for (const y of [80, 130, 180]) shelfItems(g, r, 20, 236, y, kind === 'clothes' || kind === 'flower' ? 'souvenir' : kind);
    } else {
      g.fillStyle = '#9a7a5a';
      g.fillRect(140, 50, 70, 206);
      g.fillStyle = '#d4c4aa';
      g.fillRect(40, 90, 50, 70);
    }
    g.fillStyle = 'rgba(60,40,30,0.45)';
    g.fillRect(0, 244, RC, 12);
  },
  // 地板（两个方向都平铺：一张 = 2m 见方）
  (g, r, kind) => {
    if (kind === 'cafe' || kind === 'home' || kind === 'clothes') planks(g, r, kind === 'cafe' ? 24 : 40, 10);
    else if (kind === 'home2') {
      // 榻榻米
      g.fillStyle = '#c9c08a';
      g.fillRect(0, 0, RC, RC);
      g.strokeStyle = '#6a5a3a';
      g.lineWidth = 3;
      g.strokeRect(0, 0, 128, RC);
      g.strokeRect(128, 0, 128, 128);
      g.strokeRect(128, 128, 128, 128);
    } else {
      for (let y = 0; y < RC; y += 64)
        for (let x = 0; x < RC; x += 64) {
          g.fillStyle = `hsl(30, 6%, ${55 + r() * 10}%)`;
          g.fillRect(x + 1, y + 1, 62, 62);
        }
    }
  },
  // 天花板（两个方向都平铺：一张 = 2m 见方）：店里有吊灯的光斑
  (g, _r, kind) => {
    const home = kind === 'home' || kind === 'home2';
    g.fillStyle = kind === 'cafe' ? '#5a4030' : '#f2efe8';
    g.fillRect(0, 0, RC, RC);
    if (kind === 'cafe') {
      g.fillStyle = '#3a2a20';
      g.fillRect(0, 100, RC, 30);
      glow(g, 128, 210, 60, 'rgba(255,220,150,1)');
      g.fillStyle = '#fff2c8';
      g.beginPath();
      g.arc(128, 210, 10, 0, Math.PI * 2);
      g.fill();
    } else if (!home) {
      g.fillStyle = '#ffffff';
      g.fillRect(40, 116, 176, 24);
      glow(g, 128, 128, 90, 'rgba(255,255,245,0.8)');
    } else {
      glow(g, 128, 128, 50, 'rgba(255,250,235,0.7)');
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(128, 128, 22, 0, Math.PI * 2);
      g.fill();
    }
  },
  // 家具（透明底，横向平铺：一张 = 3m 宽、1.6m 高）：桌椅、展示台、沙发……的剪影
  (g, r, kind) => {
    g.clearRect(0, 0, RC, RC);
    if (kind === 'cafe') {
      for (const cx of [64, 192]) {
        // 圆桌 + 两把椅子
        g.fillStyle = '#5a3a28';
        g.fillRect(cx - 4, 150, 8, 100);
        g.beginPath();
        g.ellipse(cx, 150, 34, 7, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#7a5238';
        for (const s of [-1, 1]) {
          g.fillRect(cx + s * 48 - 14, 176, 28, 8);
          g.fillRect(cx + s * 48 + (s > 0 ? 10 : -14), 120, 4, 130);
          g.fillRect(cx + s * 48 - 12, 184, 4, 66);
          g.fillRect(cx + s * 48 + 8, 184, 4, 66);
        }
        g.fillStyle = '#f6f2ea';
        g.fillRect(cx - 10, 136, 8, 12);
        g.fillRect(cx + 6, 138, 7, 10);
      }
    } else if (kind === 'pottery' || kind === 'souvenir' || kind === 'flower') {
      // 中间一张展示台
      g.fillStyle = '#7a5a40';
      g.fillRect(40, 170, 176, 12);
      g.fillRect(48, 182, 10, 74);
      g.fillRect(198, 182, 10, 74);
      shelfItems(g, r, 44, 212, 170, kind === 'flower' ? 'souvenir' : kind);
    } else if (kind === 'clothes') {
      g.fillStyle = '#9aa0a6';
      g.fillRect(60, 100, 136, 4);
      g.fillRect(64, 100, 4, 156);
      g.fillRect(188, 100, 4, 156);
      for (let x = 72; x < 186; x += 12) {
        g.fillStyle = ['#4f9bd9', '#f6f2ea', '#e2574c', '#2f3a8f'][Math.floor(r() * 4)];
        g.fillRect(x, 104, 10, 60 + r() * 24);
      }
    } else if (kind === 'home') {
      // 沙发 + 茶几
      g.fillStyle = '#8a9aa8';
      g.fillRect(30, 180, 130, 50);
      g.fillRect(30, 150, 130, 34);
      g.fillStyle = '#7a8a98';
      g.fillRect(24, 170, 14, 60);
      g.fillRect(152, 170, 14, 60);
      g.fillStyle = '#6e5440';
      g.fillRect(180, 210, 60, 8);
      g.fillRect(186, 218, 6, 38);
      g.fillRect(228, 218, 6, 38);
    } else {
      // 床
      g.fillStyle = '#e9e2d4';
      g.fillRect(40, 200, 180, 36);
      g.fillStyle = '#8a6a52';
      g.fillRect(36, 170, 8, 86);
      g.fillRect(36, 236, 188, 20);
    }
  },
];

/** 房间图集（7 种房间 × 5 个面，每格 256²），全部 canvas 画的 */
export function roomAtlas() {
  const W = RC * FACES;
  const H = RC * ROOMS.length;
  const t = canvasTexture(W, H, (g) => {
    ROOMS.forEach((kind, row) => {
      FACE_PAINTERS.forEach((paint, col) => {
        g.save();
        g.translate(col * RC, row * RC);
        g.beginPath();
        g.rect(0, 0, RC, RC);
        g.clip();
        paint(g, rng(row * 31 + col * 7 + 3), kind);
        g.restore();
      });
    });
  });
  t.anisotropy = 8;
  return t;
}

/**
 * 玻璃反射的环境光：场景的环境光强度（0.35）是给漫反射定的，玻璃的反射要亮好几倍；但封顶 ——
 * HDRI 里那个太阳也会被放大，在玻璃上糊成一大块发白的光斑（第一版咖啡店的窗上就有一块，封顶 0.75 也还是白的）
 */
const GLASS_REFLECTION = (k: number) => `reflectedLight.indirectSpecular = min( reflectedLight.indirectSpecular * ${k.toFixed(1)}, vec3( 0.32 ) );`;

/** 玻璃里的店内按时间变：uLights = 天黑了多少（0 白天 … 1 夜里，开灯的程度），uHour = 几点（太阳时） */
export interface GlassNight {
  uLights: { value: number };
  uHour: { value: number };
}

/**
 * 室内映射的玻璃。几何体要带这几个属性（见 street.ts 的 GlassMesher）：
 *   aRoomPos   这一点在房间里的位置（米）：x 从房间左墙量、y 从地板量（玻璃在房间的 z = 0 面上）
 *   aRoomSize  房间的宽、高、深（米）
 *   aRoomInfo  x = 房间种类（图集的行）、y = 变体（0..1 随机）、z = 店里的灯有多亮、w = 窗帘（0 没有，1 有）
 *   aWinUv     在这扇窗里的位置（0..1），窗帘用
 */
export function interiorGlassMaterial(keep: Keep, atlas: THREE.Texture, night: GlassNight) {
  const mat = keep(new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.06, metalness: 0, emissive: 0xffffff }));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRooms = { value: atlas };
    shader.uniforms.uLights = night.uLights;
    shader.uniforms.uHour = night.uHour;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aRoomPos;
        attribute vec3 aRoomSize;
        attribute vec4 aRoomInfo;
        attribute vec2 aWinUv;
        varying vec2 vRoomPos;
        varying vec3 vRoomSize;
        varying vec4 vRoomInfo;
        varying vec2 vWinUv;
        varying vec3 vWorldP;
        varying vec3 vWorldN;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRoomPos = aRoomPos;
        vRoomSize = aRoomSize;
        vRoomInfo = aRoomInfo;
        vWinUv = aWinUv;
        vWorldP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vWorldN = normalize( mat3( modelMatrix ) * objectNormal );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uRooms;
        uniform float uLights;
        uniform float uHour;
        varying vec2 vRoomPos;
        varying vec3 vRoomSize;
        varying vec4 vRoomInfo;
        varying vec2 vWinUv;
        varying vec3 vWorldP;
        varying vec3 vWorldN;
        // 图集里第 row 行、第 col 列那一格，f = 格子里的坐标（0..1，y 向上：画布里格子的顶边是 1；会平铺的面先 fract）。
        // 平铺处 fract 不连续，按原坐标的导数取 mipmap（textureGrad），接缝处不会闪出一道线
        vec4 roomTex( float row, float col, vec2 f, vec2 g ) {
          vec2 cellSize = vec2( ${(1 / FACES).toFixed(6)}, ${(1 / ROOMS.length).toFixed(6)} );
          vec2 inset = vec2( 2.0 / ${RC * FACES}.0, 2.0 / ${RC * ROOMS.length}.0 );
          vec2 uv = vec2( col, ${ROOMS.length - 1}.0 - row ) * cellSize + inset + f * ( cellSize - 2.0 * inset );
          vec2 dx = dFdx( g ) * ( cellSize - 2.0 * inset );
          vec2 dy = dFdy( g ) * ( cellSize - 2.0 * inset );
          return textureGrad( uRooms, uv, dx, dy );
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 Nw = normalize( vWorldN );
          vec3 Vw = normalize( cameraPosition - vWorldP );
          vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), Nw ) );
          // 视线（从玻璃往房间里）换到房间的坐标：x 沿窗、y 向上、z 朝外（房间在 z < 0）
          vec3 d = -Vw;
          vec3 rd = vec3( dot( d, right ), d.y, dot( d, Nw ) );
          rd.z = min( rd.z, -1e-3 );
          vec3 p = vec3( vRoomPos, 0.0 );
          float W = vRoomSize.x;
          float H = vRoomSize.y;
          float D = vRoomSize.z;
          float row = floor( vRoomInfo.x + 0.5 );
          float tx = ( ( rd.x > 0.0 ? W : 0.0 ) - p.x ) / ( abs( rd.x ) < 1e-4 ? 1e-4 : rd.x );
          float ty = ( ( rd.y > 0.0 ? H : 0.0 ) - p.y ) / ( abs( rd.y ) < 1e-4 ? 1e-4 : rd.y );
          float tz = -D / rd.z;
          tx = tx < 0.0 ? 1e6 : tx;
          ty = ty < 0.0 ? 1e6 : ty;
          float t = min( min( tx, ty ), tz );
          vec3 hit = p + rd * t;
          vec3 room;
          if ( t == tz ) {
            vec2 f = vec2( hit.x / 3.0 + vRoomInfo.y * 7.0, hit.y / H );
            room = roomTex( row, 0.0, vec2( fract( f.x ), clamp( f.y, 0.0, 1.0 ) ), f ).rgb;
          } else if ( t == tx ) {
            vec2 f = vec2( -hit.z / D, hit.y / H );
            room = roomTex( row, 1.0, vec2( rd.x > 0.0 ? f.x : 1.0 - f.x, clamp( f.y, 0.0, 1.0 ) ), f ).rgb * 0.9;
          } else if ( rd.y < 0.0 ) {
            vec2 f = vec2( hit.x, -hit.z ) / 2.0;
            room = roomTex( row, 2.0, fract( f ), f ).rgb * 0.85;
          } else {
            vec2 f = vec2( hit.x, -hit.z ) / 2.0;
            room = roomTex( row, 3.0, fract( f ), f ).rgb;
          }
          // 家具：离窗 0.38 个房间深的一层剪影，挡在房间前面
          float zf = -D * 0.38;
          float tf = zf / rd.z;
          if ( tf < t ) {
            vec3 hf = p + rd * tf;
            vec2 f = vec2( hf.x / 3.0 + vRoomInfo.y * 3.0, hf.y / 1.6 );
            if ( f.y > 0.0 && f.y < 1.0 && hf.x > 0.0 && hf.x < W ) {
              vec4 fc = roomTex( row, 4.0, vec2( fract( f.x ), f.y ), f );
              if ( fc.a > 0.5 ) {
                room = fc.rgb;
                t = tf;
                hit = hf;
              }
            }
          }
          // 夜里这间开不开灯：住家按房间的随机值和钟点（傍晚七成亮着，夜深了越来越少），
          // 商店 21 点关门（咖啡店 22 点），清晨还没开门。开着的比白天亮（外面黑了），关着的几乎全黑
          float kind = floor( vRoomInfo.x + 0.5 );
          float isHome = step( 4.5, kind );
          float rnd = fract( vRoomInfo.y * 91.7 );
          float ev = uHour < 12.0 ? uHour + 24.0 : uHour;
          float pHome = ev < 22.0 ? 0.72 : ev < 24.0 ? mix( 0.72, 0.45, ( ev - 22.0 ) / 2.0 ) : ev < 26.0 ? mix( 0.45, 0.15, ( ev - 24.0 ) / 2.0 ) : ev < 29.0 ? 0.1 : 0.22;
          float shopOpen = step( ev, kind < 0.5 ? 22.0 : 21.0 );
          float lit = isHome > 0.5 ? step( rnd, pHome ) : shopOpen;
          float bright = mix( vRoomInfo.z, lit > 0.5 ? max( vRoomInfo.z, isHome > 0.5 ? 0.75 : 0.95 ) : 0.03, uLights );
          // 越往里越暗（窗边亮，屋子深处暗）；店里的灯整体乘一个亮度
          room *= mix( 1.0, 0.55, clamp( -hit.z / D, 0.0, 1.0 ) ) * bright;
          // 窗帘：住家的窗拉开一半（两边垂下来的布，迎着窗外的天光是亮的），或者一层白纱
          if ( vRoomInfo.w > 0.5 ) {
            float c = 0.16 + 0.24 * fract( vRoomInfo.y * 13.0 );
            float x = vWinUv.x;
            float folds = 0.82 + 0.18 * sin( x * 90.0 + vRoomInfo.y * 20.0 );
            vec3 cloth = mix( vec3( 0.93, 0.9, 0.84 ), vec3( 0.82, 0.86, 0.9 ), step( 0.5, fract( vRoomInfo.y * 5.0 ) ) ) * folds * 0.75;
            // 夜里：开着灯的从里面透出暖光，关着的是暗的
            cloth = mix( cloth, cloth * ( lit > 0.5 ? vec3( 1.1, 0.88, 0.6 ) : vec3( 0.04 ) ), uLights );
            if ( x < c || x > 1.0 - c ) room = cloth;
            else if ( fract( vRoomInfo.y * 3.0 ) > 0.6 ) room = mix( room, cloth * 0.9, 0.55 );
          }
          float NdotV = clamp( dot( Nw, Vw ), 0.0, 1.0 );
          float Fr = 0.04 + 0.96 * pow( 1.0 - NdotV, 5.0 );
          totalEmissiveRadiance = room * ( 1.0 - Fr );
        }`,
      )
      // 反射：场景的环境光强度（0.35）是给漫反射定的，玻璃的反射要亮得多（见 GLASS_REFLECTION）
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLASS_REFLECTION(3.2)}`);
  };
  mat.customProgramCacheKey = () => 'street-interior-glass';
  return mat;
}

/**
 * 透明玻璃（她身边那家咖啡店，后面是真的 3D 室内）：只输出反射（环境 + 太阳的高光），
 * 自定义混合：结果 = 反射 + 后面 ×（1 − a），a 随菲涅耳变大（斜着看更像镜子、更挡后面）
 */
export function clearGlassMaterial(keep: Keep) {
  const mat = keep(
    new THREE.MeshStandardMaterial({
      color: 0x000000,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    }),
  );
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLASS_REFLECTION(2.0)}`)
      .replace(
        '#include <opaque_fragment>',
        `float glassF = 0.04 + 0.96 * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 5.0 );
        gl_FragColor = vec4( outgoingLight, 0.08 + 0.75 * glassF );`,
      );
  };
  mat.customProgramCacheKey = () => 'street-clear-glass';
  return mat;
}
