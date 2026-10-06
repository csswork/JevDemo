import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { retargetSmpl } from './retargetSmpl';
import { BONE_NAMES, trimClip } from './editClip';
import { bakeClip } from './bakeClip';
import type { Edits } from '../shared';

export interface PreviewHandle { exportGlb: () => Promise<ArrayBuffer>; }
interface Props {
  url?: string; edits: Edits; target: string; playing: boolean; time: number; skeleton: boolean;
  onTime: (time: number) => void; onDuration: (duration: number, edited: number) => void;
  handle: { current: PreviewHandle | null };
}
export function Preview(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  useLayoutEffect(() => { current.current = props; });
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    const el = mount.current!; let disposed = false; let frame = 0;
    const exportHandle = props.handle;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { queueMicrotask(() => setError('无法启动 3D 预览，请检查浏览器 WebGL 支持')); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xeceee9); el.append(renderer.domElement);
    const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(36, 1, .01, 100);
    camera.position.set(2.8, 1.8, 3.8);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, .9, 0); controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x929b89, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 4, 3); scene.add(light);
    const grid = new THREE.GridHelper(8, 40, 0xadb6a6, 0xd4d9d0); scene.add(grid);
    const resize = new ResizeObserver(() => {
      renderer.setSize(el.clientWidth, el.clientHeight); camera.aspect = el.clientWidth / Math.max(1, el.clientHeight); camera.updateProjectionMatrix();
    }); resize.observe(el);
    let source: THREE.Group | undefined; let sourceClip: THREE.AnimationClip | undefined;
    let clip: THREE.AnimationClip | undefined;
    let bindings: Array<{ binding: THREE.PropertyBinding & { setValue(buffer: ArrayLike<number>, offset: number): void }; interpolant: THREE.Interpolant }> = [];
    let avatar: VRM | undefined; let helper: THREE.SkeletonHelper | undefined;
    let editKey = ''; let playTime = 0; let lastTime = performance.now(); let lastSent = -1;
    let initialRoot = new THREE.Vector3(); let ground = 0;
    const root = new THREE.Group(); scene.add(root);
    const disposeTree = (object: THREE.Object3D) => object.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
        mat.dispose();
      }
    });
    const feet = () => {
      if (avatar) return ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map(n => avatar!.humanoid.getNormalizedBoneNode(n as VRMHumanBoneName)).filter(Boolean) as THREE.Object3D[];
      return ['L_Foot', 'R_Foot', 'L_Ankle', 'R_Ankle'].map(n => source?.getObjectByName(n)).filter(Boolean) as THREE.Object3D[];
    };
    const pelvis = () => avatar ? avatar.humanoid.getNormalizedBoneNode('hips') : source?.getObjectByName('Pelvis');
    const rest: Array<{ node: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion }> = [];
    function pose(t: number, edits: Edits) {
      if (!clip) return;
      for (const r of rest) { r.node.position.copy(r.position); r.node.quaternion.copy(r.quaternion); }
      root.position.set(0, 0, 0);
      for (const { binding, interpolant } of bindings) binding.setValue(interpolant.evaluate(THREE.MathUtils.clamp(t, 0, clip.duration)), 0);
      const q = new THREE.Quaternion();
      for (const [bone, angles] of Object.entries(edits.offsets)) {
        const node = avatar ? avatar.humanoid.getNormalizedBoneNode((BONE_NAMES[bone] ?? bone) as VRMHumanBoneName) : source?.getObjectByName(bone);
        if (node) node.quaternion.multiply(q.setFromEuler(new THREE.Euler(...angles.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ')));
      }
      avatar?.humanoid.update(); root.updateMatrixWorld(true);
      const pos = pelvis()?.getWorldPosition(new THREE.Vector3());
      if (edits.inPlace && pos) { root.position.x = initialRoot.x - pos.x; root.position.z = initialRoot.z - pos.z; }
      if (edits.ground) root.position.y = -ground;
      root.updateMatrixWorld(true);
    }
    function rebuild(edits: Edits) {
      if (!source || !sourceClip) return;
      for (const { binding } of bindings) binding.unbind();
      for (const r of rest) { r.node.position.copy(r.position); r.node.quaternion.copy(r.quaternion); }
      clip = trimClip(sourceClip, edits);
      bindings = clip.tracks.map(track => ({ binding: new THREE.PropertyBinding(avatar?.scene ?? source!, track.name) as THREE.PropertyBinding & { setValue(buffer: ArrayLike<number>, offset: number): void }, interpolant: (track as THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant }).createInterpolant() }));
      initialRoot.set(0, 0, 0); ground = 0;
      pose(0, { ...edits, inPlace: false, ground: false });
      initialRoot.copy(pelvis()?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3());
      const nodes = feet();
      if (nodes.length) {
        let min = Infinity;
        for (let t = 0; t <= clip.duration + .001; t += Math.max(clip.duration / 60, .01)) {
          pose(Math.min(t, clip.duration), { ...edits, inPlace: false, ground: false });
          min = Math.min(min, ...nodes.map(n => n.getWorldPosition(new THREE.Vector3()).y));
        }
        ground = Number.isFinite(min) ? min : 0;
      }
      playTime = Math.min(current.current.time, clip.duration);
      current.current.onDuration(source.animations[0].duration, clip.duration);
      pose(playTime, edits);
    }
    async function load() {
      setError('');
      if (!props.url) return;
      setLoading(true);
      try {
        source = await new FBXLoader().loadAsync(props.url);
        if (disposed) { disposeTree(source); return; }
        if (!source.animations[0]) throw new Error('FBX 中没有动画轨道');
        sourceClip = source.animations[0];
        if (props.target !== 'source') {
          if (!source.getObjectByName('Pelvis')) throw new Error('角色预览仅支持 HY-Motion 的 SMPL-H 骨架，请切回原始动作');
          const gltf = await new GLTFLoader().register(parser => new VRMLoaderPlugin(parser)).loadAsync(props.target);
          if (disposed) { disposeTree(gltf.scene); return; }
          avatar = gltf.userData.vrm;
          if (!avatar) { disposeTree(gltf.scene); throw new Error('请选择有效的 VRM 角色'); }
          if (avatar.meta.metaVersion === '0') VRMUtils.rotateVRM0(avatar);
          const tracks = retargetSmpl(source, avatar);
          const remapped: THREE.KeyframeTrack[] = [];
          for (const [bone, track] of tracks.rotation) {
            const node = avatar.humanoid.getNormalizedBoneNode(bone); if (!node) continue;
            const t = track.clone(); t.name = `${node.uuid}.quaternion`; remapped.push(t);
          }
          for (const [bone, track] of tracks.translation) {
            const node = avatar.humanoid.getNormalizedBoneNode(bone); if (!node) continue;
            const t = track.clone(); t.name = `${node.uuid}.position`; remapped.push(t);
          }
          sourceClip = new THREE.AnimationClip('retarget', tracks.duration, remapped);
          root.add(avatar.scene);
        } else {
          // HY-Motion coordinates are centimeters. Other FBX files can still be inspected in their original skeleton.
          source.scale.multiplyScalar(.01); root.add(source);
        }
        const animated = avatar ? avatar.scene : source;
        animated.traverse(node => rest.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone() }));
        helper = new THREE.SkeletonHelper(animated); helper.visible = current.current.skeleton; scene.add(helper);
        rebuild(current.current.edits); editKey = JSON.stringify(current.current.edits);
        exportHandle.current = { exportGlb: async () => {
          if (avatar) throw new Error('请切回「原始动作」导出；角色预览只用于验证适配效果');
          if (!source || !clip) throw new Error('动作还没有加载');
          const baked = bakeClip(root, source, clip.duration, t => pose(t, current.current.edits));
          pose(0, current.current.edits);
          try { return await new GLTFExporter().parseAsync(root, { binary: true, animations: [baked], onlyVisible: false }) as ArrayBuffer; }
          finally { pose(playTime, current.current.edits); }
        } };
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '加载失败'); }
      finally { if (!disposed) setLoading(false); }
    }
    void load();
    function draw(now: number) {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      const p = current.current; const dt = Math.min((now - lastTime) / 1000, .1); lastTime = now;
      const key = JSON.stringify(p.edits);
      if (key !== editKey) { rebuild(p.edits); editKey = key; }
      if (clip) {
        if (Math.abs(p.time - lastSent) > .025) playTime = p.time;
        if (p.playing) playTime = p.edits.loop ? (playTime + dt) % clip.duration : Math.min(clip.duration, playTime + dt);
        pose(playTime, p.edits);
        if (p.playing) { lastSent = playTime; p.onTime(playTime); }
      }
      if (helper) helper.visible = p.skeleton;
      avatar?.update(dt); controls.update(); renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); exportHandle.current = null;
      for (const { binding } of bindings) binding.unbind(); controls.dispose(); helper?.dispose(); disposeTree(scene);
      if (source && avatar) disposeTree(source);
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [props.url, props.target, props.handle]);
  return <div className="viewport" ref={mount}>
    {!props.url && <div className="stage-message"><span className="stage-icon">↗</span><strong>让动作有自己的迭代空间</strong><span>添加一个动作，生成或导入 FBX 开始预览</span></div>}
    {loading && <div className="stage-message"><strong>正在加载动作…</strong></div>}
    {error && <div className="preview-error">{error}</div>}
    <div className="stage-caption">拖动旋转 · 滚轮缩放 · 右键平移</div>
  </div>;
}
