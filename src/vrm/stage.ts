import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** three.js 场景骨架：相机、灯光、背景、resize。与 VRM 无关，便于单独调。 */
export function createStage(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  // 半身胸像。这个模型实测：发顶 1.652、眼 1.48、颈 1.34、肩 1.31、胸 1.10。
  // 取景 y∈[1.06, 1.73]：上留约 8cm 头顶余量，下到上胸；眼睛落在画面上方 37%，
  // 是人像的常规比例。垂直视角固定，所以窗口变宽变窄都不会改变这个构图。
  //
  // 焦段用长的（24° 而非 30°+）：短焦会把鼻子推近、脸拉变形。
  // 长焦 + 拉远是拍人像的通行做法，五官关系更正。
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
  camera.position.set(0, 1.42, 1.58);
  const lookTarget = new THREE.Vector3(0, 1.395, 0);
  camera.lookAt(lookTarget);

  // 鼠标看模型：绕胸像横向随便转，上下各 30°，远近在默认距离的 1/1.5 ~ 1.5 倍之间。
  // 不能平移 —— 转轴始终是上面的取景中心，怎么拖都不会把人拖出画面。
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
  controls.minDistance = home.length() / 1.5;
  controls.maxDistance = home.length() * 1.5;
  controls.update();

  // 三点布光。MToon 对方向光敏感，主光别太硬，否则二次元材质会出现明显的明暗切割线。
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1.2, 2.0, 1.6);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55);
  fill.position.set(-1.6, 1.2, 1.0);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffe9d6, 0.7);
  rim.position.set(-0.6, 1.6, -2.0);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.75));

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /**
   * 调试用的替身相机（dev 审计工具截特写时用）。单独一台而不是去挪主相机：
   * 视线层看的是主相机的位置，挪主相机角色会跟着转头。
   */
  const view: { camera: THREE.PerspectiveCamera | null } = { camera: null };

  function render() {
    controls.update();
    renderer.render(scene, view.camera ?? camera);
  }

  function dispose() {
    controls.dispose();
    renderer.dispose();
  }

  return { renderer, scene, camera, controls, view, lookTarget, resize, render, dispose };
}
