import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMMetaLoaderPlugin } from '@pixiv/three-vrm';

// The tool's downloaded mannequin keeps its original CC0 license metadata.
// Other bundled/local VRMs continue using their own VRM license metadata.
export function avatarLoader() {
  return new GLTFLoader().register(parser => new VRMLoaderPlugin(parser, {
    metaPlugin: new VRMMetaLoaderPlugin(parser, { acceptLicenseUrls: ['https://vrm.dev/licenses/1.0/', 'https://creativecommons.org/publicdomain/zero/1.0/'] }),
  }));
}
