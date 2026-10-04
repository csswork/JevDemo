import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Backdrop } from './common';
import { clearGlassMaterial, frostedGlassMaterial } from './glass';

const BASE = `${import.meta.env.BASE_URL}scene/models/anime_cafe/`;
/** Authored porcelain top is 26 mm above Blender's slab origin; the avatar stands at y=0. */
const FLOOR_OFFSET = -0.026;

type Fixture = { id: string; position: [number, number, number]; color: string; watts: number; type: string };

/**
 * 潮汐咖啡馆：scripts/blender/anime_cafe_room.py 的精细场景。
 * 独立可复用的 PBR 纹理保留木纹与装饰画；场景使用实时灯光。
 * 相机使用有真实开口的独立低面数碰撞体。
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

  // A small contact receiver supports the avatar without replacing the room's real shadow receivers.
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
    const clearGlass = clearGlassMaterial(own);
    clearGlass.side = THREE.DoubleSide;
    const windowGlass = frostedGlassMaterial(own);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const kind = mesh.userData.runtimeKind as string | undefined;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (kind === 'collision') {
        mesh.visible = false;
        colliders.push(mesh);
        return;
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        // Joining imported props with authored geometry can create zero-filled
        // color attributes. Only materials that actually use paint should read them.
        material.vertexColors = material.userData.usesVertexColors === true
          || (material.userData.usesVertexColors === undefined && ['paint', 'metal', 'glow', 'glass'].includes(material.name));
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.map) standard.map.anisotropy = 8;
      }
      if (kind === 'glass' || kind === 'window-glass') {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.material = kind === 'window-glass' ? windowGlass : clearGlass;
      }
    });
    group.add(root);
    group.updateMatrixWorld(true);

    // Authored pendant positions softly warm the room and avatar.
    const nearby = manifest.fixtures
      .filter((fixture) => fixture.id.startsWith('pendant fixture'))
      .sort((a, b) => Math.hypot(a.position[0], a.position[1]) - Math.hypot(b.position[0], b.position[1]))
      .slice(0, 5);
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
    hemisphere: { sky: 0xfff3dd, ground: 0xb7a48f, intensity: 1.1 },
    environment: { url: `${import.meta.env.BASE_URL}scene/hdri/wooden_lounge_1k.hdr`, intensity: 0.65 },
    fog: null,
    shadowBounds: 3,
    sun: { color: 0xffefd9, intensity: 1.6, bounds: 9, position: [-10, 6.2, 4], fill: 0.35, rim: 0.45 },
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
