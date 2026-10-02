import * as THREE from 'three';

/**
 * 背景场景的公共部分：舞台（stage.ts）认的接口，和几个场景都用的贴图小工具。
 */

export interface Backdrop {
  group: THREE.Group;
  /** 场景里额外的灯（会被加进舞台） */
  lights: THREE.Light[];
  /** 镜头不能穿过的东西（墙、地、吧台、桌椅……），舞台用来做防穿墙。可以是不加进场景的简化形状 */
  colliders: THREE.Object3D[];
  /** 场景开着时半球光换成的颜色（让角色的环境光和场景的色调一致） */
  hemisphere: { sky: number; ground: number; intensity: number };
  /** null = 不要雾（全景照片自己有空气感） */
  fog: THREE.Fog | null;
  /**
   * 环境光（IBL），舞台负责转成 PMREM；intensity = scene.environmentIntensity。
   * url = 一张 HDRI；scene = 一个小场景（比如天空球 + 草地），舞台直接拿它烘环境贴图，不用下载。
   * rotation = 绕竖轴转多少（弧度），和场景里显示出来的全景对齐
   */
  environment: { url: string; intensity: number; rotation?: number } | { scene: THREE.Scene; intensity: number };
  /** 投影的范围：舞台的主光只在这个盒子里算阴影（角色和身边的东西） */
  shadowBounds: number;
  /** 舞台的主光投不投影（默认投） */
  keyShadow?: boolean;
  /**
   * 室外：舞台的主光当太阳用 —— 换成太阳的颜色、亮度和方向（position = 灯相对角色的位置），
   * 阴影范围扩大到 ±bounds 米（树冠的影子、人的影子都由它投）。
   * 为什么不另加一盏太阳：three.js 的灯没法只照场景、不照角色。另加的太阳照在脸上会把五官的明暗冲平；
   * 主光不投影、太阳投影的话，主光又把地上的影子全冲淡了
   */
  sun?: {
    color: number;
    intensity: number;
    bounds: number;
    position?: [number, number, number];
    /**
     * 补光、轮廓光的亮度。它们是给室内人像定的（0.55 / 0.7），也照在地上、而且不投影 ——
     * 晴天户外这两盏太亮，会把太阳的影子从别的方向照平（实测平台上的影子只比旁边暗一成多）
     */
    fill?: number;
    rim?: number;
  };
  /** 相机看多远（米，默认 20，室内够了；室外要看到远处的树和天空） */
  far?: number;
  /** 每帧调一次（风吹树叶、草） */
  update?(dt: number): void;
  dispose(): void;
}

/** canvas 画一张贴图 */
export function canvasTexture(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D) => void,
  repeat?: [number, number],
) {
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

/** 可复现的伪随机数（同一个种子每次画出来一样） */
export function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
