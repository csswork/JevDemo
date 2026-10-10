import { GLTFLoader as ThreeGLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import type { LoadingManager } from 'three';

/** All scene loaders support the required meshopt extension, including nested prop models. */
export class GLTFLoader extends ThreeGLTFLoader {
  constructor(manager?: LoadingManager) {
    super(manager);
    this.setMeshoptDecoder(MeshoptDecoder);
  }
}
