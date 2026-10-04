import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Backdrop } from './common';

const BASE = `${import.meta.env.BASE_URL}scene/models/anime_cafe/`;
/** Authored porcelain top is 26 mm above Blender's slab origin; the avatar stands at y=0. */
const FLOOR_OFFSET = -0.026;

type Fixture = { id: string; position: [number, number, number]; color: string; watts: number; type: string };

/**
 * 潮汐咖啡馆：scripts/blender/anime_cafe_room.py 的精细场景。
 * 静态材质与日光/灯光由 export_anime_cafe.py 从同一份灯具清单烘焙。
 * 金属和玻璃保留 PBR；相机使用有真实开口的独立低面数碰撞体。
 */
export function createAnimeCafe(): Backdrop {
  const group = new THREE.Group();
  group.name = 'anime-cafe';
  group.userData.ready = false;
  group.userData.status = 'loading';
  const colliders: THREE.Object3D[] = [];
  const lights: THREE.Light[] = [];
  const owned = new Set<{ dispose(): void }>();
  let disposed = false;
  const own = <T extends { dispose(): void }>(value: T): T => {
    if (!owned.has(value)) {
      owned.add(value);
      if (disposed) value.dispose();
    }
    return value;
  };
  const ownMaterial = (material: THREE.Material) => {
    own(material);
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) own(value);
  };

  // Only the avatar's changing contact shadow is dynamic; the room's light and window shadows are baked.
  const contact = new THREE.Mesh(
    own(new THREE.PlaneGeometry(5.8, 5.8)),
    own(new THREE.ShadowMaterial({ color: 0x4c3b2b, opacity: 0.25, depthWrite: false })),
  );
  contact.name = 'avatar-contact-shadow';
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.002;
  contact.receiveShadow = true;
  group.add(contact);

  const loader = new GLTFLoader();
  const model = loader.loadAsync(`${BASE}room.glb`).catch(() => loader.loadAsync(`${BASE}room-low.glb`));
  const fixtureManifest = fetch(`${BASE}fixtures.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Cafe fixture manifest: ${response.status}`);
    return (await response.json()) as { fixtures: Fixture[] };
  });
  // A late load after changing backgrounds must still release its geometry, materials and textures.
  void model.then((gltf) => {
    gltf.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      own(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) ownMaterial(material);
    });
  }).catch(() => undefined);

  void Promise.all([model, fixtureManifest]).then(([gltf, manifest]) => {
    if (disposed) return;
    const root = gltf.scene;
    root.position.y += FLOOR_OFFSET;
    const bakedMaterials = new Map<THREE.Material, THREE.MeshBasicMaterial>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const kind = mesh.userData.runtimeKind as string | undefined;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if (kind === 'collision') {
        mesh.visible = false;
        colliders.push(mesh);
        return;
      }
      if (kind === 'baked') {
        const convert = (source: THREE.Material) => {
          let result = bakedMaterials.get(source);
          if (!result) {
            const original = source as THREE.MeshStandardMaterial;
            result = own(new THREE.MeshBasicMaterial({
              map: original.map,
              color: 0xffffff,
              // Vertex colors have already contributed to the baked atlas.
              vertexColors: false,
              side: THREE.DoubleSide,
              toneMapped: false,
            }));
            result.name = `${source.name}-baked`;
            if (result.map) result.map.anisotropy = 4;
            bakedMaterials.set(source, result);
          }
          return result;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
      } else if (kind === 'glass') {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          material.transparent = true;
          material.opacity = 0.15;
          material.depthWrite = false;
          material.side = THREE.DoubleSide;
        }
      }
    });
    group.add(root);
    group.updateMatrixWorld(true);

    // Two nearby authored pendant positions softly warm the avatar; all fixtures are already in the atlases.
    const nearby = manifest.fixtures
      .filter((fixture) => fixture.id.startsWith('pendant fixture'))
      .sort((a, b) => Math.hypot(a.position[0], a.position[1]) - Math.hypot(b.position[0], b.position[1]))
      .slice(0, 2);
    for (const fixture of nearby) {
      const point = new THREE.PointLight(fixture.color, Math.min(3.5, fixture.watts / 16), 5, 2);
      point.name = fixture.id;
      const [x, y, z] = fixture.position;
      point.position.set(x, z + FLOOR_OFFSET, -y);
      // Backdrop.lights is added synchronously by the stage, so asynchronously loaded lights belong to the group.
      group.add(point);
    }
    group.userData.ready = true;
    group.userData.status = 'ready';
    group.userData.fixtureCount = manifest.fixtures.length;
    group.userData.colliderCount = colliders.length;
  }).catch((error: unknown) => {
    if (disposed) return;
    group.userData.status = 'error';
    group.userData.error = error instanceof Error ? error.message : String(error);
    console.error('潮汐咖啡馆加载失败', error);
  });

  return {
    group,
    lights,
    colliders,
    hemisphere: { sky: 0xffe9cf, ground: 0x897865, intensity: 0.65 },
    environment: { url: `${import.meta.env.BASE_URL}scene/hdri/wooden_lounge_1k.hdr`, intensity: 0.5 },
    fog: null,
    shadowBounds: 3,
    sun: { color: 0xffeac9, intensity: 1.65, bounds: 4, position: [-4, 2.48, 1.6], fill: 0.35, rim: 0.45 },
    far: 100,
    ambience: `${import.meta.env.BASE_URL}audio/cafe.ogg`,
    dispose() {
      disposed = true;
      for (const resource of owned) resource.dispose();
      group.clear();
      colliders.length = 0;
    },
  };
}
