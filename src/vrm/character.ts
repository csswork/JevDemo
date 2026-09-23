import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { TimelineEvent } from '../act/timeline';
import { PoseAccumulator } from './pose';
import { IdleLayer } from './idle';
import { GestureLayer, vrmMetaVersion } from './gestures';
import { GazeLayer } from './gaze';
import { ExpressionLayer } from './expressions';
import { LipSyncLayer } from './lipsync';

/**
 * 角色控制器 —— Act IR 的消费端。
 *
 * 每帧的层叠顺序是固定的，也是这个 demo 的核心：
 *   resetNormalizedPose → idle → gesture → gaze → flush → expression → lipsync → vrm.update
 *
 * 换渲染引擎（Live2D / Unity / AnimeActEngine）时，需要重写的只有这个文件和 vrm/ 目录；
 * act/ 和 jev/ 两层原样保留。
 */
export class Character {
  vrm: VRM | null = null;

  readonly idle = new IdleLayer();
  readonly gesture = new GestureLayer();
  readonly gaze: GazeLayer;
  readonly expression = new ExpressionLayer();
  readonly lipsync = new LipSyncLayer();

  private acc = new PoseAccumulator();
  /** 调试开关：关掉后只跑 vrm.update，用于隔离"是我的层还是引擎本身"的问题 */
  layersEnabled = true;
  /**
   * 手势总开关。
   *
   * 默认开：手到脸那一组（掩嘴笑、扶额、托腮…）本来就是为半身景别写的，
   * 是表情的延伸而不是独立的肢体表演。垂在身侧的那组在这个景别里看不见，
   * 由 Jev 答案的推导规则决定不去触发它们。
   */
  gesturesEnabled = true;
  private hipsRest = new THREE.Vector3();

  constructor(cameraPos: THREE.Vector3) {
    this.gaze = new GazeLayer(cameraPos);
  }

  async load(url: string, onProgress?: (ratio: number) => void): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url, (e) => {
      if (e.total > 0) onProgress?.(e.loaded / e.total);
    });

    const vrm = gltf.userData.vrm as VRM;

    // 注意：VRMUtils 的 removeUnnecessaryVertices / combineSkeletons / combineMorphs
    // 在这个模型上会撕裂头发的蒙皮（弹簧骨被拽成放射状）。它们是 draw call 优化，
    // 对单角色场景收益很小，这里直接不用。换模型时可以单独试，但务必肉眼验收。
    VRMUtils.rotateVRM0(vrm);

    // 二次元模型不需要视锥剔除和阴影，关掉省事也避免手抬高时被裁掉
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    const metaVersion = vrmMetaVersion(vrm);
    this.gesture.setVrmVersion(metaVersion);
    this.idle.setVrmVersion(metaVersion);
    this.gaze.setVrmVersion(metaVersion);

    this.expression.bind(vrm);
    this.lipsync.bind(vrm);

    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) this.hipsRest.copy(hips.position);

    if (vrm.lookAt) {
      vrm.lookAt.autoUpdate = true;
      vrm.lookAt.target = this.gaze.target;
    }

    this.vrm = vrm;
    this.gaze.look('camera');

    // 暖机：先把姿态落到位再重置弹簧骨。
    // 两个坑都在这里：
    //   1. rotateVRM0 把 vrm.scene 整体转了 180°，而弹簧骨记录的是上一帧的**世界**
    //      位置。旋转之后每个关节的世界坐标瞬间跳到镜像位置，被当成一个巨大的速度
    //      输入 —— 这个模型 dragForce 只有 0.05，阻尼极低，于是头发和裙子会直接炸开
    //      成放射状且再也收不回来。必须在旋转之后重新播种弹簧骨状态。
    //   2. VRM 规范的静止姿态是 T-pose，而 idle 层的目标是垂手。如果让它从 T-pose
    //      缓动过去，开场一秒内手臂扫过的大位移同样会甩飞头发。所以先 snap 到位、
    //      空跑几帧、再 reset。
    this.idle.snap();
    for (let i = 0; i < 12; i++) this.update(1 / 60);
    vrm.springBoneManager?.reset();

    return vrm;
  }

  /** 消费时间轴事件。这是 Act IR 与渲染层之间唯一的接触面。 */
  apply(ev: TimelineEvent) {
    switch (ev.kind) {
      case 'posture':
        this.idle.setPosture(ev.posture);
        break;
      case 'expression':
        // 整组一次性设定：给定的情绪按权重叠加，没给的淡出。
        // 逐个 setExclusive 会让同时刻的后一拍清掉前一拍，分布退化成 top-1。
        this.expression.setBlend(Object.fromEntries(ev.mix), ev.fade);
        break;
      case 'gesture':
        if (this.gesturesEnabled) this.gesture.play(ev.clip, ev.weight, ev.speed);
        break;
      case 'gaze':
        this.gaze.look(ev.target, ev.hold);
        break;
      case 'speech_start':
        this.expression.setSpeaking(true);
        break;
      case 'speech_end':
        this.expression.setSpeaking(false);
        this.lipsync.stop();
        break;
    }
  }

  setArousal(a: number) {
    this.idle.setArousal(a);
  }

  update(dt: number) {
    const vrm = this.vrm;
    if (!vrm) return;

    vrm.humanoid.resetNormalizedPose();
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) hips.position.copy(this.hipsRest);

    if (this.layersEnabled) {
      this.acc.reset();
      this.idle.update(dt, this.acc);
      this.gesture.update(dt, this.acc);
      this.gaze.update(dt, vrm, this.acc);
      this.acc.flush(vrm);
    }

    this.expression.update(dt, vrm);
    this.lipsync.setMouthRoom(1 - 0.6 * this.expression.mouthOcclusion());
    this.lipsync.update(dt, vrm);

    vrm.update(dt);
  }

  dispose() {
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }
}
