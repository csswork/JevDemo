import * as THREE from 'three';

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
    renderer.render(scene, view.camera ?? camera);
  }

  function dispose() {
    renderer.dispose();
  }

  return { renderer, scene, camera, view, lookTarget, resize, render, dispose };
}
