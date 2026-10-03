import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { Backdrop } from './scenes/common';
import { createCafe } from './scenes/cafe';
import { createPark } from './scenes/park';
import { createStreet } from './scenes/street';
import { TimeOfDay, type TimeMode } from './timeOfDay';

/**
 * 背景：none = 原来的纯色渐变（CSS 画的，画布透明）；cafe = 咖啡店店内（scenes/cafe.ts）；
 * park = 公园的木栈道（scenes/park.ts）；street = 海边小镇的街道（scenes/street.ts）
 */
export type BackdropId = 'none' | 'cafe' | 'park' | 'street';

/** 镜头的视角：绕转轴的水平角、俯仰角（弧度，three.js Spherical 的 theta / phi）和离转轴的距离 */
export interface CameraView {
  azimuth: number;
  polar: number;
  distance: number;
}
const BACKDROPS: Record<Exclude<BackdropId, 'none'>, () => Backdrop> = { cafe: createCafe, park: createPark, street: createStreet };
/** 相机默认看多远（室内够了；室外场景自己给，见 Backdrop.far） */
const FAR = 20;
/** 像素比的上限：再高肉眼分不出，GPU 白干活 */
const MAX_PIXEL_RATIO = 2;

/** three.js 场景骨架：相机、灯光、背景、resize。与 VRM 无关，便于单独调。 */
export function createStage(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
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
  const fillDefault = { color: fill.color.getHex(), intensity: fill.intensity };
  const rimDefault = { color: rim.color.getHex(), intensity: rim.intensity };

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.75);
  scene.add(hemi);
  const hemiDefault = { sky: hemi.color.getHex(), ground: hemi.groundColor.getHex(), intensity: hemi.intensity };

  // ---- 背景场景 ----
  let backdrop: Backdrop | null = null;
  let backdropId: BackdropId = 'none';
  let envMap: THREE.Texture | null = null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  /** 场景按时间给的环境贴图（Backdrop.lighting.envScene 烘出来的），换一张就释放上一张 */
  let baked: { rt: THREE.WebGLRenderTarget; version: number; at: number } | null = null;
  /** 一天里的时间（只有街景用：太阳、月亮、灯，见 timeOfDay.ts） */
  const time = new TimeOfDay();
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
    baked?.rt.dispose();
    baked = null;
    scene.environment = null;
    scene.environmentRotation.set(0, 0, 0);
    backdropId = id;
    if (id !== 'none') {
      const b = BACKDROPS[id]();
      backdrop = b;
      scene.add(b.group, ...b.lights);
      const env = b.environment;
      if (!env) {
        // 场景按时间自己给（lighting.envScene），第一帧就烘
      } else if ('url' in env) {
        scene.environmentIntensity = env.intensity;
        scene.environmentRotation.set(0, env.rotation ?? 0, 0);
        new HDRLoader().load(env.url, (hdr) => {
          if (backdrop !== b) return hdr.dispose();
          envMap = pmrem.fromEquirectangular(hdr).texture;
          hdr.dispose();
          scene.environment = envMap;
        });
      } else {
        scene.environmentIntensity = env.intensity;
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
    key.shadow.intensity = 1;
    fill.color.setHex(fillDefault.color);
    fill.intensity = sun?.fill ?? fillDefault.intensity;
    rim.color.setHex(rimDefault.color);
    rim.intensity = sun?.rim ?? rimDefault.intensity;
    applyLighting();
    if (backdrop) {
      // 当太阳用时阴影范围大：灯离目标只有 2.8m，近平面要放到灯"身后"，远处的树冠才进得了阴影
      const r = sun?.bounds ?? backdrop.shadowBounds;
      Object.assign(key.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: sun ? -40 : 0.5, far: sun ? 40 : 12 });
      key.shadow.camera.updateProjectionMatrix();
      key.shadow.normalBias = sun ? 0.04 : 0.02;
      key.shadow.radius = sun ? 3 : 4;
    }
    // 像素预算是场景给的（公园有、咖啡店和纯色没有）：换背景时按当前画布大小重算一次像素比
    const size = renderer.getSize(_size);
    if (size.x > 0 && size.y > 0) applyPixelRatio(size.x, size.y);
  }

  /**
   * 像素比：默认 min(dpr, 2)；当前背景给了像素预算（Backdrop.pixelBudget）时再压到预算以内。
   * w、h 是画布的 CSS 尺寸。setPixelRatio 内部会按旧的 CSS 尺寸重设一次画布，所以 resize 里要在 setSize 之前调
   */
  const _size = new THREE.Vector2();
  function applyPixelRatio(w: number, h: number) {
    let ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    const budget = backdrop?.pixelBudget;
    if (budget) ratio = Math.min(ratio, Math.sqrt(budget / (w * h)));
    if (ratio !== renderer.getPixelRatio()) renderer.setPixelRatio(ratio);
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
    // 每次都按当前的 dpr 和预算重算（审计工具截图时临时把像素比改成 1，截完调 resize 就复原了）
    applyPixelRatio(w, h);
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

  // 把这次渲染的视锥交给场景，让它自己剔除合批的东西（Backdrop.beforeRender）。
  // 挂在 scene.onBeforeRender 上：three 这时已经更新完相机矩阵，拿到的就是这次实际用的相机（可能是替身）；
  // 阴影相机的矩阵平时在阴影通道里才更新，这里先更新一次（太阳不动，结果和阴影通道里一样）
  const viewFrustum = new THREE.Frustum();
  const _viewProj = new THREE.Matrix4();
  scene.onBeforeRender = (_r, _s, cam) => {
    if (!backdrop?.beforeRender) return;
    viewFrustum.setFromProjectionMatrix(_viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let shadow: THREE.Frustum | null = null;
    if (key.castShadow) {
      key.shadow.updateMatrices(key);
      shadow = key.shadow.getFrustum();
    }
    backdrop.beforeRender(viewFrustum, shadow, cam, renderer.getDrawingBufferSize(_buf));
  };
  const _buf = new THREE.Vector2();

  /**
   * 场景按时间给的灯光（Backdrop.lighting）：主光、补光、轮廓光、半球光、环境光每帧照着设；
   * 环境贴图在 envVersion 变了的时候重烘（最多 10 次 / 秒：切时段的那 3 秒里一直在变）
   */
  function applyLighting() {
    const L = backdrop?.lighting;
    if (!L) return;
    key.color.copy(L.sun.color);
    key.intensity = L.sun.intensity;
    key.position.copy(L.sun.position);
    key.shadow.intensity = L.sun.shadow;
    fill.color.copy(L.fill.color);
    fill.intensity = L.fill.intensity;
    rim.color.copy(L.rim.color);
    rim.intensity = L.rim.intensity;
    hemi.color.copy(L.hemisphere.sky);
    hemi.groundColor.copy(L.hemisphere.ground);
    hemi.intensity = L.hemisphere.intensity;
    scene.environmentIntensity = L.environmentIntensity;
    if (L.envScene && (!baked || (baked.version !== L.envVersion && performance.now() - baked.at > 100))) {
      const rt = pmrem.fromScene(L.envScene, 0, 0.1, 1000, { size: 256 });
      baked?.rt.dispose();
      baked = { rt, version: L.envVersion, at: performance.now() };
      scene.environment = rt.texture;
    }
  }

  const clock = new THREE.Clock();
  function render() {
    const dt = Math.min(clock.getDelta(), 0.1);
    time.update(dt);
    backdrop?.update?.(dt, time.state);
    applyLighting();
    controls.update();
    followZoom();
    renderer.render(scene, renderCamera());
  }

  function dispose() {
    backdrop?.dispose();
    envMap?.dispose();
    baked?.rt.dispose();
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
    /** 时间模式（跟随现在 / 清晨 / 白天 / 黄昏 / 夜晚，或者调试用的某个钟点）。instant = 不过渡、直接跳过去 */
    setTimeOfDay(mode: TimeMode | number, instant = false) {
      time.setMode(mode, instant);
    },
    get timeOfDay() {
      return time.current;
    },
    /** 现在几点、太阳在哪（调试看） */
    get time() {
      return time.state;
    },
    /** 当前背景要播的环境音（CC0 循环音频）。没配或纯色背景就是 null */
    get ambience(): string | null {
      return backdrop?.ambience ?? null;
    },
    /** 当前背景要的环境音音量。场景没指定就是 null（用播放层的默认值） */
    get ambienceVolume(): number | null {
      return backdrop?.ambienceVolume ?? null;
    },
  };
}
