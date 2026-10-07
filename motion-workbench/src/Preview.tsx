import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { exportMotion } from './exportMotion';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { AvatarEditSpace, beginPositionDrag, applyAvatarPositions, applyBoneEdits, avatarBoneName, BONE_LABELS, offsetQuaternion, quaternionAngles } from './boneEditing';
import { DRAG_RULES, setWorldQuaternion, solveCcd, solveTwoBone } from './ikDrag';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { avatarLoader } from './avatarLoader';
import { retargetSmpl } from './retargetSmpl';
import { trimClip } from './editClip';
import type { Edits } from '../shared';

export interface PreviewHandle { exportGlb: () => Promise<ArrayBuffer>; }
interface Props {
  url?: string; edits: Edits; target: string; playing: boolean; time: number; skeleton: boolean;
  boneEditing: boolean; bone: string; boneMode: 'rotate' | 'drag';
  onSelectBone: (bone: string) => void; onBones: (bones: string[]) => void;
  /** Bone values to merge into edits, in the source FBX axes regardless of preview avatar. */
  onBoneEdits: (patch: Pick<Edits, 'offsets' | 'positions'>) => void;
  onLoadState: (status: 'loading' | 'ready' | 'error') => void;
  onTime: (time: number) => void; onDuration: (duration: number, edited: number) => void;
  handle: { current: PreviewHandle | null };
}
export function Preview(props: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  useLayoutEffect(() => { current.current = props; });
  const exporter = useRef<(() => Promise<ArrayBuffer>) | null>(null);
  useImperativeHandle(props.handle, () => ({ exportGlb: async () => {
    if (!exporter.current) throw new Error('预览尚未加载');
    return exporter.current();
  } }), []);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    // Report the resource captured by this effect; cancelled loads never unlock a newer one.
    const onLoadState = current.current.onLoadState;
    onLoadState(props.url ? 'loading' : 'ready');
    exporter.current = null;
    const el = mount.current!; let disposed = false; let frame = 0;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { queueMicrotask(() => { setError('无法启动 3D 预览，请检查浏览器 WebGL 支持'); setLoading(false); onLoadState('error'); }); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xeceee9); el.append(renderer.domElement);
    const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(36, 1, .01, 100);
    camera.position.set(2.8, 1.8, 3.8);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, .9, 0); controls.enableDamping = true; controls.screenSpacePanning = true; controls.enabled = false;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x929b89, .75));
    const light = new THREE.DirectionalLight(0xffffff, 1.5); light.position.set(2, 4, 3); scene.add(light);
    const fill = new THREE.DirectionalLight(0xdfe8ff, .55); fill.position.set(-3, 2, 1); scene.add(fill);
    const grid = new THREE.GridHelper(8, 40, 0xadb6a6, 0xd4d9d0); scene.add(grid);
    const resize = new ResizeObserver(() => {
      renderer.setSize(el.clientWidth, el.clientHeight); camera.aspect = el.clientWidth / Math.max(1, el.clientHeight); camera.updateProjectionMatrix();
    }); resize.observe(el);
    let source: THREE.Group | undefined; let exportSnapshot: THREE.Group | undefined; let sourceClip: THREE.AnimationClip | undefined;
    let clip: THREE.AnimationClip | undefined;
    let bindings: Array<{ binding: THREE.PropertyBinding & { setValue(buffer: ArrayLike<number>, offset: number): void }; interpolant: THREE.Interpolant }> = [];
    let avatar: VRM | undefined; let space: AvatarEditSpace | undefined; let helper: THREE.SkeletonHelper | undefined;
    let editKey = ''; let playTime = 0; let lastTime = performance.now(); let lastSent = -1;
    let initialRoot = new THREE.Vector3(); let ground = 0;
    const root = new THREE.Group(); scene.add(root);
    const transform = new TransformControls(camera, renderer.domElement); transform.setSpace('local'); transform.setSize(.7);
    transform.enabled = false; const transformHelper = transform.getHelper(); scene.add(transformHelper);
    const proxy = new THREE.Object3D();
    const markers = new THREE.Group(); scene.add(markers); markers.visible = false;
    const joints = new Map<string, THREE.Object3D>(); const dots = new Map<string, THREE.Mesh>();
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
    let loaded = false; let attached = ''; let dragBone = '';
    const panKeys: Record<string, [number, number]> = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
    const heldKeys = new Set<string>();
    function panView(x: number, y: number, amount: number) {
      const distance = camera.position.distanceTo(controls.target);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const shift = right.multiplyScalar(-x).add(up.multiplyScalar(-y)).multiplyScalar(distance * amount);
      camera.position.add(shift); controls.target.add(shift);
    }
    const clearKeys = () => { heldKeys.clear(); };
    const keyDown = (e: KeyboardEvent) => {
      if (document.activeElement !== el || e.target !== el || !loaded || directDrag || transform.dragging || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) { clearKeys(); return; }
      const direction = panKeys[e.code]; if (!direction) return;
      e.preventDefault(); e.stopPropagation();
      if (!heldKeys.has(e.code)) panView(...direction, .025);
      heldKeys.add(e.code);
    };
    const keyUp = (e: KeyboardEvent) => { if (heldKeys.delete(e.code)) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener('keydown', keyDown); el.addEventListener('keyup', keyUp); el.addEventListener('blur', clearKeys);
    window.addEventListener('blur', clearKeys);

    const dragBaseQ = new THREE.Quaternion();
    const resolveBone = (name: string) => avatar ? avatar.humanoid.getNormalizedBoneNode(avatarBoneName(name) as VRMHumanBoneName) : source?.getObjectByName(name);
    /** Offset as applied to the preview node: VRM normalized axes differ from the stored FBX axes. */
    const nodeOffset = (bone: string, angles: number[] | undefined) => space ? space.rotationToAvatar(bone, angles ?? [0, 0, 0]) : offsetQuaternion(angles ?? [0, 0, 0]);
    const storedOffset = (bone: string, q: THREE.Quaternion) => space ? space.rotationFromAvatar(bone, q) : quaternionAngles(q);
    transform.addEventListener('dragging-changed', e => { controls.enabled = loaded && !e.value; });
    transform.addEventListener('mouseDown', () => {
      const p = current.current; dragBone = attached;
      dragBaseQ.copy(proxy.quaternion).multiply(nodeOffset(dragBone, p.edits.offsets[dragBone]).invert());
    });
    transform.addEventListener('objectChange', () => {
      if (!transform.dragging || !dragBone) return;
      current.current.onBoneEdits({ offsets: { [dragBone]: storedOffset(dragBone, dragBaseQ.clone().invert().multiply(proxy.quaternion)) } });
    });
    let pointerStart: [number, number] | undefined;
    let directDrag: { pointerId: number; bones: Set<string>; move: (ray: THREE.Ray) => void } | undefined;
    /**
     * IK drag. Every move re-poses from the pose at grab time and solves again, so the result never drifts
     * and the bend direction stays the one the motion already had.
     */
    function beginIkDrag(id: string, ray: THREE.Ray) {
      const rule = DRAG_RULES[id]; if (!rule || !clip) return;
      const start = structuredClone(current.current.edits); const time = playTime;
      pose(time, start);
      const normal = camera.getWorldDirection(new THREE.Vector3());
      const node = (n: string) => joints.get(n);
      const lHip = node('L_Hip'); const rHip = node('R_Hip');
      const forward = lHip && rHip ? lHip.getWorldPosition(new THREE.Vector3()).sub(rHip.getWorldPosition(new THREE.Vector3())).cross(new THREE.Vector3(0, 1, 0)).normalize() : normal.clone().negate();
      type Limb = { root: THREE.Object3D; mid: THREE.Object3D; end: THREE.Object3D; names: string[]; target?: THREE.Vector3; rotation?: THREE.Quaternion; pole: THREE.Vector3 };
      const limb = (end: string, chain: string[]): Limb | undefined => {
        const nodes = [end, ...chain].map(node);
        if (nodes.some(n => !n)) return undefined;
        return { end: nodes[0]!, mid: nodes[1]!, root: nodes[2]!, names: [end, ...chain], pole: chain[1].endsWith('Hip') ? forward : forward.clone().negate() };
      };
      // Snapshot the animated pose (without this gesture's offsets) for each bone the gesture may write.
      const bases = new Map<string, THREE.Quaternion>();
      const captureBases = (names: string[]) => { for (const n of names) { const o = node(n); if (o) bases.set(n, o.quaternion.clone().multiply(nodeOffset(n, start.offsets[n]).invert())); } };
      const collect = (names: string[]) => Object.fromEntries(names.filter(n => node(n)).map(n => [n, storedOffset(n, bases.get(n)!.clone().invert().multiply(node(n)!.quaternion))]));
      let move: (ray: THREE.Ray) => void; let bones: string[];
      if (rule === 'body') {
        const pelvisNode = node('Pelvis'); if (!pelvisNode) return;
        const startOffset = space ? space.positionToAvatar('Pelvis', start.positions?.Pelvis ?? [0, 0, 0]).toArray() : start.positions?.Pelvis ?? [0, 0, 0];
        const drag = beginPositionDrag(pelvisNode, ray, normal, startOffset, avatar ? 1 : 100); if (!drag) return;
        const legs = (['L', 'R'] as const).map(s => limb(`${s}_Ankle`, [`${s}_Knee`, `${s}_Hip`])).filter((l): l is Limb => !!l);
        for (const leg of legs) { leg.target = leg.end.getWorldPosition(new THREE.Vector3()); leg.rotation = leg.end.getWorldQuaternion(new THREE.Quaternion()); }
        bones = ['Pelvis', ...legs.flatMap(l => l.names)];
        move = next => {
          const local = drag(next); if (!local) return;
          const pelvis = space ? space.positionFromAvatar('Pelvis', new THREE.Vector3(...local)) : local;
          const edits = { ...start, positions: { ...start.positions, Pelvis: pelvis } };
          pose(time, edits); captureBases(legs.flatMap(l => l.names));
          for (const leg of legs) { solveTwoBone(leg.root, leg.mid, leg.end, leg.target!, leg.pole); setWorldQuaternion(leg.end, leg.rotation!); }
          current.current.onBoneEdits({ offsets: collect(legs.flatMap(l => l.names)), positions: { Pelvis: pelvis } });
        };
      } else {
        const effector = node(id)!; const chain = rule.chain.map(node).filter((n): n is THREE.Object3D => !!n);
        if (!chain.length) return;
        const world = effector.getWorldPosition(new THREE.Vector3());
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
        const first = ray.intersectPlane(plane, new THREE.Vector3()); if (!first) return;
        const grab = world.sub(first);
        const twoBone = rule.limb ? limb(id, rule.chain) : undefined;
        bones = [...rule.chain, ...(rule.keep ? [id] : [])].filter(n => node(n));
        move = next => {
          const point = next.intersectPlane(plane, new THREE.Vector3()); if (!point) return;
          pose(time, start); captureBases(bones);
          const keep = effector.getWorldQuaternion(new THREE.Quaternion());
          const target = point.add(grab);
          if (twoBone) solveTwoBone(twoBone.root, twoBone.mid, twoBone.end, target, twoBone.pole);
          else solveCcd(chain, effector, target);
          if (rule.keep) setWorldQuaternion(effector, keep);
          current.current.onBoneEdits({ offsets: collect(bones) });
        };
      }
      return { bones: new Set([id, ...bones]), move };
    }
    const pointerRay = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster;
    };
    const pointerDown = (e: PointerEvent) => {
      if (loaded) el.focus({ preventScroll: true });
      pointerStart = [e.clientX, e.clientY];
      const p = current.current;
      if (!loaded || !p.boneEditing || p.boneMode !== 'drag' || e.button !== 0) return;
      const hit = pointerRay(e).intersectObjects([...dots.values()], false)[0]; if (!hit) return;
      const id = hit.object.userData.bone as string;
      const drag = beginIkDrag(id, raycaster.ray); if (!drag) return;
      directDrag = { pointerId: e.pointerId, ...drag }; controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId); current.current.onSelectBone(id);
      e.preventDefault(); e.stopImmediatePropagation();
    };
    const pointerMove = (e: PointerEvent) => {
      if (!directDrag || e.pointerId !== directDrag.pointerId) return;
      directDrag.move(pointerRay(e).ray);
      e.preventDefault(); e.stopImmediatePropagation();
    };
    const endDirectDrag = (e: PointerEvent) => {
      if (!directDrag || e.pointerId !== directDrag.pointerId) return false;
      directDrag = undefined; controls.enabled = loaded;
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId);
      e.preventDefault(); e.stopImmediatePropagation(); return true;
    };
    const pointerUp = (e: PointerEvent) => {
      if (endDirectDrag(e)) return;
      if (!loaded || !current.current.boneEditing || transform.axis || !pointerStart || Math.hypot(e.clientX - pointerStart[0], e.clientY - pointerStart[1]) > 4) return;
      const hit = pointerRay(e).intersectObjects([...dots.values()], false)[0];
      if (hit) current.current.onSelectBone(hit.object.userData.bone);
    };
    const pointerCancel = (e: PointerEvent) => { endDirectDrag(e); };
    renderer.domElement.addEventListener('pointerdown', pointerDown, true); renderer.domElement.addEventListener('pointermove', pointerMove, true);
    renderer.domElement.addEventListener('pointerup', pointerUp, true); renderer.domElement.addEventListener('pointercancel', pointerCancel, true);
    function syncEditor() {
      const p = current.current; markers.visible = loaded && p.boneEditing;
      if (!loaded || !p.boneEditing || !joints.has(p.bone)) { transform.detach(); transform.enabled = false; attached = ''; return; }
      const node = joints.get(p.bone)!;
      if (p.boneMode === 'drag') { transform.detach(); transform.enabled = false; attached = ''; }
      else if (!transform.dragging) {
        if (proxy.parent !== node.parent) node.parent!.add(proxy);
        proxy.position.copy(node.position); proxy.quaternion.copy(node.quaternion); proxy.scale.set(1, 1, 1); proxy.updateMatrixWorld(true);
        transform.setMode(p.boneMode); transform.attach(proxy); transform.enabled = true; attached = p.bone;
      }
      for (const [id, dot] of dots) {
        dot.position.copy(joints.get(id)!.getWorldPosition(new THREE.Vector3()));
        const finger = /Thumb|Index|Middle|Ring|Pinky/.test(id);
        const linked = !!directDrag?.bones.has(id) && id !== p.bone;
        dot.scale.setScalar(camera.position.distanceTo(dot.position) * (id === p.bone ? .009 : linked ? .007 : finger ? .0035 : .006));
        (dot.material as THREE.MeshBasicMaterial).color.set(id === p.bone ? 0xf5a623 : linked ? 0xe0c27a : finger ? 0x537cc7 : 0x66824f);
      }
    }
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
      const applied = space ? space.toAvatar(edits) : edits;
      applyBoneEdits(applied, resolveBone, avatar ? 1 : 100);
      avatar?.humanoid.update(); if (avatar) applyAvatarPositions(avatar, applied); root.updateMatrixWorld(true);
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
      setLoading(!!props.url);
      if (!props.url) return;
      let succeeded = false;
      try {
        source = await new FBXLoader().loadAsync(props.url);
        if (disposed) { disposeTree(source); return; }
        if (!source.animations[0]) throw new Error('FBX 中没有动画轨道');
        exportSnapshot = clone(source) as THREE.Group; exportSnapshot.animations = source.animations;
        sourceClip = source.animations[0];
        if (props.target !== 'source') {
          if (!source.getObjectByName('Pelvis')) throw new Error('角色预览仅支持 HY-Motion 的 SMPL-H 骨架，请切回原始动作');
          const gltf = await avatarLoader().loadAsync(props.target);
          if (disposed) { disposeTree(gltf.scene); return; }
          avatar = gltf.userData.vrm;
          if (!avatar) { disposeTree(gltf.scene); throw new Error('请选择有效的 VRM 角色'); }
          if (avatar.meta.metaVersion === '0') VRMUtils.rotateVRM0(avatar);
          const tracks = retargetSmpl(source, avatar);
          space = new AvatarEditSpace(source, avatar.meta.metaVersion === '0', tracks.scale);
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
        for (const id of Object.keys(BONE_LABELS)) {
          const node = resolveBone(id); if (!node) continue; joints.set(id, node);
          const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: 0x66824f, depthTest: false, depthWrite: false }));
          dot.userData.bone = id; dot.renderOrder = 100; markers.add(dot); dots.set(id, dot);
        }
        current.current.onBones([...joints.keys()]);
        helper = new THREE.SkeletonHelper(animated); helper.visible = current.current.skeleton; scene.add(helper);
        rebuild(current.current.edits); editKey = JSON.stringify(current.current.edits);
        avatar?.update(0); root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(animated);
        if (box.isEmpty()) animated.traverse(node => { if ((node as THREE.Bone).isBone) box.expandByPoint(node.getWorldPosition(new THREE.Vector3())); });
        if (!box.isEmpty()) {
          const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
          const aspect = el.clientWidth / Math.max(1, el.clientHeight);
          const distance = Math.max(size.y, size.x / aspect, .5) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.2;
          controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(.18, .08, .98).normalize().multiplyScalar(distance));
          controls.update();
        }
        succeeded = true; loaded = true;
        exporter.current = async () => {
          if (!exportSnapshot) throw new Error('动作还没有加载');
          return exportMotion(exportSnapshot, current.current.edits);
        };
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '加载失败'); }
      finally { if (!disposed) { setLoading(false); controls.enabled = succeeded; onLoadState(succeeded ? 'ready' : 'error'); } }
    }
    void load();
    function draw(now: number) {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      const p = current.current; const dt = Math.min((now - lastTime) / 1000, .1); lastTime = now;
      const key = JSON.stringify(p.edits);
      if (key !== editKey && !transform.dragging && !directDrag) { rebuild(p.edits); editKey = key; }
      if (clip) {
        if (Math.abs(p.time - lastSent) > .025) playTime = p.time;
        if (p.playing && !p.boneEditing) playTime = p.edits.loop ? (playTime + dt) % clip.duration : Math.min(clip.duration, playTime + dt);
        pose(playTime, p.edits);
        if (p.playing && !p.boneEditing) { lastSent = playTime; p.onTime(playTime); }
      }
      if (helper) helper.visible = p.skeleton || (loaded && p.boneEditing);
      avatar?.update(dt); syncEditor(); renderer.domElement.style.cursor = p.boneEditing && p.boneMode === 'drag' ? directDrag ? 'grabbing' : 'grab' : '';  if (!directDrag && !transform.dragging) {
        if (loaded && document.activeElement === el && heldKeys.size) {
          const directions = [...heldKeys].map(code => panKeys[code]);
          const x = Math.sign(directions.reduce((sum, value) => sum + value[0], 0)); const y = Math.sign(directions.reduce((sum, value) => sum + value[1], 0));
          panView(x, y, dt * .5 / (x && y ? Math.SQRT2 : 1));
        }
        controls.update();
      } renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true; clearKeys(); el.removeEventListener('keydown', keyDown); el.removeEventListener('keyup', keyUp); el.removeEventListener('blur', clearKeys); window.removeEventListener('blur', clearKeys); cancelAnimationFrame(frame); resize.disconnect(); exporter.current = null;
      for (const { binding } of bindings) binding.unbind(); controls.dispose(); transform.detach(); transform.dispose(); proxy.removeFromParent(); renderer.domElement.removeEventListener('pointerdown', pointerDown, true); renderer.domElement.removeEventListener('pointermove', pointerMove, true); renderer.domElement.removeEventListener('pointerup', pointerUp, true); renderer.domElement.removeEventListener('pointercancel', pointerCancel, true); helper?.dispose(); disposeTree(scene);
      if (source && avatar) disposeTree(source);
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [props.url, props.target]);
  return <div className="viewport" ref={mount} tabIndex={0} role="region" aria-label="动作预览，可聚焦后使用方向键或 WASD 平移视图">
    {!props.url && <div className="stage-message"><span className="stage-icon">↗</span><strong>让动作有自己的迭代空间</strong><span>添加一个动作，生成或导入 FBX 开始预览</span></div>}
    {loading && <div className="stage-message loading-message" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true"/><strong>Loading…</strong><span>正在加载模型与动作，请稍候</span></div>}
    {error && <div className="preview-error">{error}</div>}
    <div className="stage-caption">{props.boneEditing ? `${BONE_LABELS[props.bone]} · 点击关节选择 · 拖动${props.boneMode === 'rotate' ? '圆环旋转' : '关节点，上游骨骼随之弯曲'}` : '鼠标拖动旋转 · 滚轮缩放 · 点击预览聚焦后，方向键 / WASD 上下左右平移'}</div>
  </div>;
}
