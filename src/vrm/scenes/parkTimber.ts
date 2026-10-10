import * as THREE from 'three';
import { GLTFLoader } from '../gltfLoader';

/** Blender-authored, fitted near surfaces. Original geometry stays available as load fallback. */
export function loadParkTimber({ group, keep, disposed, wood, deck, paths, furniture, benches }: {
  group: THREE.Group;
  keep: <T extends { dispose(): void }>(x: T) => T;
  disposed: () => boolean;
  wood: THREE.MeshStandardMaterial;
  deck: THREE.Mesh;
  paths: Array<{ mesh: THREE.Mesh; length: number }>;
  furniture: THREE.Object3D[];
  benches: Array<{ x: number; y: number; z: number; angle: number }>;
}) {
  new GLTFLoader().load(`${import.meta.env.BASE_URL}scene/models/park/timber.glb`, gltf => {
    gltf.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      keep(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) keep(mat);
    });
    if (disposed()) return;
    const names = ['deck_boards', 'main_path_boards', 'branch_path_boards', 'front_path_boards', 'low_table', 'round_stool', 'garden_bench'];
    if (names.some(name => !gltf.scene.getObjectByName(name))) return;
    const timber = keep(wood.clone());
    timber.vertexColors = true;
    const iron = keep(new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: .5, metalness: .6, vertexColors: true }));
    const place = (name: string, pos: [number, number, number] = [0, 0, 0], angle = 0, shadow = false) => {
      const obj = gltf.scene.getObjectByName(name)!.clone();
      obj.position.set(...pos); obj.rotation.y = angle;
      obj.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = (m.material as THREE.Material).name === 'park_metal' ? iron : timber;
        m.receiveShadow = true; m.castShadow = shadow;
      });
      group.add(obj);
    };
    for (const name of names.slice(0, 4)) place(name);
    place('round_stool', [1.2, 0, -1.25], .15, true);
    place('low_table', [2.15, 0, .45], -.25, true);
    for (const b of benches) place('garden_bench', [b.x, b.y, b.z], b.angle, true);
    deck.visible = false;
    furniture.forEach(o => o.visible = false);
    // Keep full original collision surfaces; lower rendered underlay below real near boards.
    for (const { mesh, length } of paths) {
      const geo = keep(mesh.geometry.clone());
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const distance = Math.floor(i / 2) / (p.count / 2 - 1) * length;
        const blend = THREE.MathUtils.smoothstep(distance, 18.06, 18.34);
        p.setY(i, p.getY(i) - .068 * (1 - blend));
      }
      geo.computeBoundingSphere();
      const underlay = new THREE.Mesh(geo, wood);
      underlay.receiveShadow = true;
      underlay.name = 'park-timber-underlay';
      group.add(underlay); mesh.visible = false;
    }
    group.userData.timberReady = true;
  }, undefined, error => console.warn('Park timber: original surfaces retained after asset load failure', error));
}
