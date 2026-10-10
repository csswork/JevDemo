import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as THREE from 'three';

// Exercise the real layer with controlled downloads, without DOM/WebGL or network.
function fixture() {
  const requests = [];
  const source = fs.readFileSync(new URL('../src/vrm/motion.ts', import.meta.url), 'utf8').replaceAll('import.meta.env.BASE_URL', "'/'");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  const animation = { duration: 6 };
  const dependencies = {
    three: THREE,
    './gltfLoader': { GLTFLoader: class {
      register() {}
      loadAsync(url) { return download(url); }
      parseAsync(data) { return data; }
    } },
    '@pixiv/three-vrm-animation': {
      VRMAnimationLoaderPlugin: class {},
      createVRMAnimationHumanoidTracks: () => ({ rotation: new Map(), translation: new Map() }),
    },
    './gestures': { GESTURES: {} },
    './protect': { isProtected: () => false },
    '../act/schema': { isProceduralMotion: () => false },
  };
  function download(url) {
    return new Promise((resolve, reject) => requests.push({ url, resolve: () => resolve({ userData: { vrmAnimations: [animation] } }), reject }));
  }
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => { assert.ok(id in dependencies, id); return dependencies[id]; } });
  const vrm = () => ({ meta: { metaVersion: '1' }, humanoid: { normalizedRestPose: {} } });
  const layer = new exports.MotionLayer();
  layer.bind(vrm());
  return { requests, layer, vrm, MotionLayer: exports.MotionLayer };
}

test('bind is lazy; first use downloads once and subsequent characters reuse the source', async () => {
  const { layer, requests, vrm, MotionLayer } = fixture();
  assert.equal(requests.length, 0);
  const idle = layer.setBase('idle_loop');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /idle_loop\.vrma$/);
  requests[0].resolve(); assert.equal(await idle, true);
  const first = layer.play('greeting');
  const second = layer.play('greeting');
  assert.equal(requests.length, 2, 'in-flight request is shared');
  requests[1].resolve();
  assert.equal(await first, false, 'newer play request takes precedence');
  assert.equal(await second, true);
  assert.equal(layer.current.id, 'greeting');
  assert.equal(await layer.play('greeting'), true);
  const next = new MotionLayer(); next.bind(vrm());
  assert.equal(await next.play('greeting'), true);
  assert.equal(requests.length, 2);
});

test('stop, newer actions and disposing a model cancel delayed playback; failed fetch can retry', async () => {
  const { layer, requests } = fixture();
  const play = layer.play('greeting'); layer.stop(); requests[0].resolve();
  assert.equal(await play, false); assert.equal(layer.current, null);
  const failed = layer.play('shoot'); requests[1].reject(new Error('offline'));
  assert.equal(await failed, false);
  const retried = layer.play('shoot'); assert.equal(requests.length, 3);
  requests[2].resolve(); assert.equal(await retried, true);
  const late = layer.play('spin'); layer.unbind(); requests[3].resolve();
  assert.equal(await late, false); assert.equal(layer.current, null);
});
