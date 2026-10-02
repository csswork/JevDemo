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
  fog: THREE.Fog;
  /**
   * 环境光（IBL），舞台负责转成 PMREM；intensity = scene.environmentIntensity。
   * url = 一张 HDRI；scene = 一个小场景（比如天空球 + 草地），舞台直接拿它烘环境贴图，不用下载
   */
  environment: { url: string; intensity: number } | { scene: THREE.Scene; intensity: number };
  /** 投影的范围：舞台的主光只在这个盒子里算阴影（角色和身边的东西） */
  shadowBounds: number;
  /** 舞台的主光投不投影（默认投）。室外场景有自己的太阳投影，主光就不投了，免得一个人两个影子 */
  keyShadow?: boolean;
  /** 相机看多远（米，默认 20，室内够了；室外要看到远处的树和天空） */
  far?: number;
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
