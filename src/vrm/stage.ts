import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { Backdrop } from './scenes/common';
import { createCafe } from './scenes/cafe';
import { createPark } from './scenes/park';

/**
 * 背景：none = 原来的纯色渐变（CSS 画的，画布透明）；cafe = 咖啡店店内（scenes/cafe.ts）；
 * park = 公园的木栈道（scenes/park.ts）
 */
export type BackdropId = 'none' | 'cafe' | 'park';

/** 镜头的视角：绕转轴的水平角、俯仰角（弧度，three.js Spherical 的 theta / phi）和离转轴的距离 */
export interface CameraView {
  azimuth: number;
  polar: number;
  distance: number;
}
const BACKDROPS: Record<Exclude<BackdropId, 'none'>, () => Backdrop> = { cafe: createCafe, park: createPark };
/** 相机默认看多远（室内够了；室外场景自己给，见 Backdrop.far） */
const FAR = 20;

/** three.js 场景骨架：相机、灯光、背景、resize。与 VRM 无关，便于单独调。 */
export function createStage(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 软阴影一直开着；投不投影由主光的 castShadow 决定（只有背景场景里才投）
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  // 半身胸像。这个模型实测：发顶 1.652、眼 1.48、颈 1.34、肩 1.31、胸 1.10。
  // 取景 y∈[1.06, 1.73]：上留约 8cm 头顶余量，下到上胸；眼睛落在画面上方 37%，
  // 是人像的常规比例。垂直视角固定，所以窗口变宽变窄都不会改变这个构图。
  //
  // 焦段用长的（24° 而非 30°+）：短焦会把鼻子推近、脸拉变形。
  // 长焦 + 拉远是拍人像的通行做法，五官关系更正。
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, FAR);
  camera.position.set(0, 1.42, 1.58);
  const lookTarget = new THREE.Vector3(0, 1.395, 0);
  camera.lookAt(lookTarget);

  // 鼠标看模型：绕胸像横向随便转，上下各 30°；滚轮往近最多到默认距离的 1/1.5，
  // 往远一直能拉到全身（见下面的 fullDistance）。不能平移 —— 转轴由程序决定，怎么拖都不会把人拖出画面。
  //
  // 角色的视线不跟着相机走：GazeLayer 在构造时复制了相机的初始位置，那是"对话的人"
  // 站的地方。转到侧面看，她还是在和正前方的你说话，而不是扭头追着镜头。
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(lookTarget);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.6;
  const home = camera.position.clone().sub(lookTarget);
  const homePolar = Math.acos(home.y / home.length());
  const PITCH = THREE.MathUtils.degToRad(30);
  controls.minPolarAngle = homePolar - PITCH;
  controls.maxPolarAngle = homePolar + PITCH;
  const homeDistance = home.length();
  controls.minDistance = homeDistance / 1.5;
  controls.update();

  // --- 拉远到全身 ---
  // 转轴在胸像的取景中心（眼睛略下）。如果一直绕它拉远，脚要到 6m 开外才进画面，人小得看不清；
  // 所以拉远的同时把转轴从头部平滑地挪到全身的中心，到最远时正好是一张全身照：
  // 头顶留一点余量、脚在画面底部。转轴只随距离变，不随拖动变，所以依然没有平移
  const HAIR_ABOVE_EYE = 0.17; // 詩乃实测发顶比眼睛高 17cm，样例模型都在这附近
  const frameY = { head: lookTarget.y, center: 0.85, half: 0.95 };
  let fullDistance = homeDistance * 1.5;
  function updateZoomRange() {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // 横向也要装得下（窗口很窄时）：张开手臂约 0.8m 宽
    const byHeight = frameY.half / tanHalf;
    const byWidth = 0.4 / (tanHalf * Math.max(0.2, camera.aspect));
    fullDistance = Math.max(homeDistance * 1.5, byHeight, byWidth);
    controls.maxDistance = fullDistance;
  }
  function setBodyHeight(eyeY: number) {
    // 上下各留一点：脚底贴着画面下沿看着像被裁了
    const top = eyeY + HAIR_ABOVE_EYE + 0.07;
    const bottom = -0.12;
    frameY.center = (top + bottom) / 2;
    frameY.half = (top - bottom) / 2;
    updateZoomRange();
  }
  setBodyHeight(1.481);
  const _offset = new THREE.Vector3();
  /** 按当前距离把转轴放到头部和全身中心之间（每帧调用） */
  function followZoom() {
    _offset.copy(camera.position).sub(controls.target);
    const d = _offset.length();
    const k = THREE.MathUtils.clamp((d - homeDistance) / Math.max(1e-3, fullDistance - homeDistance), 0, 1);
    const eased = k * k * (3 - 2 * k);
    const dy = frameY.head + (frameY.center - frameY.head) * eased - controls.target.y;
    if (Math.abs(dy) < 1e-5) return;
    controls.target.y += dy;
    camera.position.y += dy;
  }

  // 上面的构图是按 Shino 的眼高（1.481）定的。换模型时以眼睛为基准整组平移：
  // 景别、透视、鼠标的活动范围都不变，眼睛始终落在同一个位置
  const DESIGN_EYE = 1.481;
  const designCamera = camera.position.clone();
  const designTarget = lookTarget.clone();
  function frame(eyeY: number) {
    const dy = eyeY - DESIGN_EYE;
    lookTarget.copy(designTarget).setY(designTarget.y + dy);
    camera.position.copy(designCamera).setY(designCamera.y + dy);
    camera.lookAt(lookTarget);
    controls.target.copy(lookTarget);
    frameY.head = lookTarget.y;
    setBodyHeight(eyeY);
    controls.update();
  }

  // 三点布光。MToon 对方向光敏感，主光别太硬，否则二次元材质会出现明显的明暗切割线。
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1.2, 2.0, 1.6);
  scene.add(key);
  // 主光的阴影：只算角色身边一小块（范围由场景给），2048 的阴影图在这个范围里足够清楚
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  const keyDefault = { color: key.color.getHex(), intensity: key.intensity, position: key.position.clone() };

  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55);
  fill.position.set(-1.6, 1.2, 1.0);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffe9d6, 0.7);
  rim.position.set(-0.6, 1.6, -2.0);
  scene.add(rim);
  const fillDefault = fill.intensity;
  const rimDefault = rim.intensity;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.75);
  scene.add(hemi);
  const hemiDefault = { sky: hemi.color.getHex(), ground: hemi.groundColor.getHex(), intensity: hemi.intensity };

  // ---- 背景场景 ----
  let backdrop: Backdrop | null = null;
  let backdropId: BackdropId = 'none';
  let envMap: THREE.Texture | null = null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  /**
   * 换背景。场景里的灯一起加进来；半球光换成场景的色调，角色的环境光和背景一致；
   * 场景的 HDRI（或者场景给的天空小场景）转成环境光（IBL，只影响场景里的 PBR 材质，角色的 MToon 不吃环境贴图）；
   * 主光开始投影（室外场景有自己的太阳投影时不投）
   */
  function setBackdrop(id: BackdropId) {
    if (id === backdropId) return;
    if (backdrop) {
      scene.remove(backdrop.group, ...backdrop.lights);
      backdrop.dispose();
      backdrop = null;
    }
    envMap?.dispose();
    envMap = null;
    scene.environment = null;
    scene.environmentRotation.set(0, 0, 0);
    backdropId = id;
    if (id !== 'none') {
      const b = BACKDROPS[id]();
      backdrop = b;
      scene.add(b.group, ...b.lights);
      const env = b.environment;
      scene.environmentIntensity = env.intensity;
      if ('url' in env) {
        scene.environmentRotation.set(0, env.rotation ?? 0, 0);
        new HDRLoader().load(env.url, (hdr) => {
          if (backdrop !== b) return hdr.dispose();
          envMap = pmrem.fromEquirectangular(hdr).texture;
          hdr.dispose();
          scene.environment = envMap;
        });
      } else {
        envMap = pmrem.fromScene(env.scene, 0.02, 0.1, 200).texture;
        scene.environment = envMap;
      }
    }
    camera.far = backdrop?.far ?? FAR;
    camera.updateProjectionMatrix();
    const look = backdrop?.hemisphere ?? hemiDefault;
    hemi.color.setHex(look.sky);
    hemi.groundColor.setHex(look.ground);
    hemi.intensity = look.intensity;
    scene.fog = backdrop?.fog ?? null;
    key.castShadow = !!backdrop && (backdrop.keyShadow !== false || !!backdrop.sun);
    const sun = backdrop?.sun;
    key.color.setHex(sun?.color ?? keyDefault.color);
    key.intensity = sun?.intensity ?? keyDefault.intensity;
    if (sun?.position) key.position.set(...sun.position);
    else key.position.copy(keyDefault.position);
    fill.intensity = sun?.fill ?? fillDefault;
    rim.intensity = sun?.rim ?? rimDefault;
    if (backdrop) {
      // 当太阳用时阴影范围大：灯离目标只有 2.8m，近平面要放到灯"身后"，远处的树冠才进得了阴影
      const r = sun?.bounds ?? backdrop.shadowBounds;
      Object.assign(key.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: sun ? -40 : 0.5, far: sun ? 40 : 12 });
      key.shadow.camera.updateProjectionMatrix();
      key.shadow.normalBias = sun ? 0.04 : 0.02;
      key.shadow.radius = sun ? 3 : 4;
    }
  }

  /** 当前视角（存下来，下次打开 / 换回这个角色时恢复） */
  function getView(): CameraView {
    const s = new THREE.Spherical().setFromVector3(_offset.copy(camera.position).sub(controls.target));
    return { azimuth: s.theta, polar: s.phi, distance: s.radius };
  }
  /**
   * 换到某个视角。距离、俯仰角限制在鼠标能到的范围里（换了模型身高不同，范围也不同）；
   * 转轴的高度跟着距离走（和 followZoom 一样），所以先按距离定转轴、再按角度摆相机
   */
  function setView(v: CameraView) {
    if (![v.azimuth, v.polar, v.distance].every(Number.isFinite)) return;
    const r = THREE.MathUtils.clamp(v.distance, controls.minDistance, controls.maxDistance);
    const phi = THREE.MathUtils.clamp(v.polar, controls.minPolarAngle, controls.maxPolarAngle);
    const k = THREE.MathUtils.clamp((r - homeDistance) / Math.max(1e-3, fullDistance - homeDistance), 0, 1);
    controls.target.y = frameY.head + (frameY.center - frameY.head) * k * k * (3 - 2 * k);
    camera.position.copy(controls.target).add(_offset.setFromSpherical(new THREE.Spherical(r, phi, v.azimuth)));
    camera.lookAt(controls.target);
    controls.update();
  }

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updateZoomRange();
  }

  /**
   * 调试用的替身相机（dev 审计工具截特写时用）。单独一台而不是去挪主相机：
   * 视线层看的是主相机的位置，挪主相机角色会跟着转头。
   */
  const view: { camera: THREE.PerspectiveCamera | null } = { camera: null };

  // 防穿墙：转到背面时吧台、桌椅会挡在镜头和角色之间（最远能拉到 4.3m）。
  // 从转轴往相机方向打一条射线，碰到东西就用一台替身相机放在障碍物前面渲染 ——
  // 不改主相机：鼠标的距离不会被"吃掉"，转开之后自动回到原来的远近
  const ray = new THREE.Raycaster();
  const toCam = new THREE.Vector3();
  const blocked = new THREE.PerspectiveCamera();
  function renderCamera(): THREE.Camera {
    if (view.camera) return view.camera;
    if (!backdrop) return camera;
    toCam.copy(camera.position).sub(controls.target);
    const dist = toCam.length();
    ray.set(controls.target, toCam.normalize());
    ray.far = dist;
    const hit = ray.intersectObjects(backdrop.colliders, false)[0];
    if (!hit) return camera;
    blocked.copy(camera);
    blocked.position.copy(controls.target).addScaledVector(toCam, Math.max(0.35, hit.distance - 0.2));
    return blocked;
  }

  const clock = new THREE.Clock();
  function render() {
    backdrop?.update?.(Math.min(clock.getDelta(), 0.1));
    controls.update();
    followZoom();
    renderer.render(scene, renderCamera());
  }

  function dispose() {
    backdrop?.dispose();
    envMap?.dispose();
    pmrem.dispose();
    controls.dispose();
    renderer.dispose();
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    view,
    lookTarget,
    frame,
    getView,
    setView,
    resize,
    render,
    dispose,
    setBackdrop,
    get backdrop() {
      return backdropId;
    },
  };
}
