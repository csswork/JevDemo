import * as THREE from 'three';
import type { TimeState } from '../timeOfDay';

/**
 * 背景场景的公共部分：舞台（stage.ts）认的接口，和几个场景都用的贴图小工具。
 */

/**
 * 场景每帧交给舞台的灯光（Backdrop.lighting）。颜色都是线性空间的 THREE.Color。
 * envScene = 拿来烘环境贴图（PMREM）的小场景（天空 + 月亮 + ……），envVersion 变了舞台就重新烘一次（最多 10 次 / 秒），
 * 旧的那张释放掉；贴图大小要和 HDRI 转出来的一样（256），换贴图的时候材质才不用重新编译
 */
export interface LiveLighting {
  /** 主光：太阳（夜里换成月亮）。position = 相对角色的方向 × 距离；shadow = 影子的浓淡（0..1，换灯的那一下淡掉） */
  sun: { color: THREE.Color; intensity: number; position: THREE.Vector3; shadow: number };
  fill: { color: THREE.Color; intensity: number };
  rim: { color: THREE.Color; intensity: number };
  hemisphere: { sky: THREE.Color; ground: THREE.Color; intensity: number };
  environmentIntensity: number;
  envScene: THREE.Scene | null;
  envVersion: number;
}

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
   * rotation = 绕竖轴转多少（弧度），和场景里显示出来的全景对齐。
   * 省略 = 场景按时间自己给（lighting.envScene，见 LiveLighting）
   */
  environment?: { url: string; intensity: number; rotation?: number } | { scene: THREE.Scene; intensity: number };
  /**
   * 场景的环境音：一条 CC0 循环音频的路径（见 src/speech/ambience.ts 和 public/audio/）。
   * 省略 = 这个场景安静。角色开口时会被自动压低，说完抬回来。
   */
  ambience?: string;
  /**
   * 环境音的音量（线性增益）。省略 = 用播放层的默认值（AMBIENCE_VOLUME）。
   * 同一档音量在不同素材上听感差很多（人声很近、鸟鸣很远），所以由场景自己定。
   * ambience、ambienceVolume 可以随时间变（写成 getter，比如街景夜里换成只有海浪的那条、更轻）：运行时每秒读一次
   */
  ambienceVolume?: number;
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
  /**
   * 像素预算：画布最多画多少个像素（宽 × 高 × 像素比²）。省略 = 不限，像素比照常取 min(dpr, 2)。
   * 满屏都是逐像素算光的树叶、草的场景，Retina 大窗口下像素比 2 要画四百多万像素；
   * 给了预算，像素比就按窗口大小自动降一点（比如 1.76），肉眼几乎看不出，片元着色的开销按像素数降
   */
  pixelBudget?: number;
  /** 每帧调一次（风吹树叶、草）。time = 现在几点、太阳在哪（舞台的时间，见 timeOfDay.ts；只有街景用） */
  update?(dt: number, time: TimeState): void;
  /**
   * 按时间变的灯光：有的话舞台每帧（update 之后）照着它设主光、补光、轮廓光、半球光和环境光，
   * 盖掉上面 sun / hemisphere / environment 的固定值。场景在 update 里改它的值就行
   */
  lighting?: LiveLighting;
  /**
   * 每次渲染前调一次，传进这次渲染的视锥（实际用的相机：主相机、防穿墙的替身或调试相机）
   * 和主光阴影相机的视锥（主光不投影时为 null）。场景拿来自己剔除合批的东西（公园的树，见 park.ts）。
   * camera = 这次的相机，size = 画布的像素大小（街景的光晕按它算最小尺寸）
   */
  beforeRender?(view: THREE.Frustum, shadow: THREE.Frustum | null, camera: THREE.Camera, size: THREE.Vector2): void;
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

/**
 * 一套 Poly Haven 的 PBR 贴图（public/scene/textures/<dir>/，由 scripts/fetch-scene-assets.mjs 下载）：
 * 漫反射 + 法线（OpenGL）+ ARM（R = AO、G = 粗糙度、B = 金属度），平铺。
 * repeat = 每个 uv 单位铺几张（uv 按米给的话就是 1 / 贴图的实际尺寸）；channel = 用第几套 uv（0 = uv，1 = uv1）。
 * keep = 场景的"换走时释放"登记函数
 */
export function pbrTextures(
  dir: string,
  keep: <T extends { dispose(): void }>(x: T) => T,
  { repeat = 1, channel = 0 }: { repeat?: number | [number, number]; channel?: number } = {},
) {
  const [rx, ry] = typeof repeat === 'number' ? [repeat, repeat] : repeat;
  const t = (file: string, color = false) => {
    const x = keep(textureLoader.load(`${import.meta.env.BASE_URL}scene/textures/${dir}/${file}`));
    if (color) x.colorSpace = THREE.SRGBColorSpace;
    x.wrapS = x.wrapT = THREE.RepeatWrapping;
    x.repeat.set(rx, ry);
    x.anisotropy = 8;
    x.channel = channel;
    return x;
  };
  const arm = t('arm.jpg');
  return { map: t('diffuse.jpg', true), normalMap: t('nor_gl.jpg'), aoMap: arm, roughnessMap: arm, metalnessMap: arm };
}
const textureLoader = new THREE.TextureLoader();

/** 可复现的伪随机数（同一个种子每次画出来一样） */
export function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
