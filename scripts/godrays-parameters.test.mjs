import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GodraysPass} from 'three-good-godrays';

// Inspect the pinned library's actual shader uniforms, not a mock of the API.
test('GodraysPass.setParams updates illumination, composite color and render resolution',()=>{
 const light=new THREE.DirectionalLight();
 const camera=new THREE.PerspectiveCamera(43,1,.08,230);
 const pass=new GodraysPass(light,camera,{gammaCorrection:false});
 try {
  pass.setSize(800,600);
  pass.setParams({density:.025,maxDensity:.65,distanceAttenuation:0,raymarchSteps:80,resolutionScale:.25,color:new THREE.Color('#ff0000'),gammaCorrection:false});
  const u=pass.illumPass.fullscreenMaterial.uniforms;
  assert.equal(u.density.value,.025);assert.equal(u.maxDensity.value,.65);
  assert.equal(u.distanceAttenuation.value,0);assert.equal(u.raymarchSteps.value,80);
  assert.equal(pass.compositorPass.fullscreenMaterial.uniforms.color.value.getHexString(),'ff0000');
  assert.equal(pass.godraysRenderTarget.width,200);assert.equal(pass.godraysRenderTarget.height,150);
  pass.setParams({density:0,maxDensity:0,resolutionScale:.5,gammaCorrection:false});
  assert.equal(u.density.value,0);assert.equal(u.maxDensity.value,0);
  assert.equal(pass.godraysRenderTarget.width,400);
 } finally {pass.dispose();}
});


test('preview shadow projection agrees with the depth range used by godrays',async()=>{
 const {createPreviewSun,setPreviewSunElevation}=await import('../design/light-shafts/sun.ts');
 const sun=createPreviewSun();
 for(const angle of [10,35,70]){
  setPreviewSunElevation(sun,angle);
  const camera=sun.shadow.camera;
  assert.ok(Math.abs(new THREE.Vector3(0,0,-camera.near).applyMatrix4(camera.projectionMatrix).z+1)<1e-10);
  assert.ok(Math.abs(new THREE.Vector3(0,0,-camera.far).applyMatrix4(camera.projectionMatrix).z-1)<1e-10);
  assert.ok(Math.abs(new THREE.Vector3(camera.right,0,-camera.near).applyMatrix4(camera.projectionMatrix).x-1)<1e-10);
 }
 sun.dispose();
});

test('canopy extension supports pinned shader and retains depth/shadow pipeline',async()=>{
 const {applyCanopyScattering}=await import('../src/vrm/godrays/canopyScattering.ts');
 const pass=new GodraysPass(new THREE.DirectionalLight(),new THREE.PerspectiveCamera());
 try{
  const material=pass.illumPass.fullscreenMaterial;
  const targets=pass.godraysRenderTarget;
  applyCanopyScattering(pass);
  pass.setParams({density:.022,raymarchSteps:64,resolutionScale:.5});
  assert.match(material.fragmentShader,/inShadow\(samplePos\)/);
  assert.match(material.fragmentShader,/sceneDepth/);
  assert.match(material.fragmentShader,/adjacentShadow/);
  assert.equal(pass.godraysRenderTarget,targets);
  // An upstream shader change must fail explicitly, never silently lose the enhancement.
  material.fragmentShader='changed upstream shader';
  assert.throws(()=>applyCanopyScattering(pass),/Unsupported godrays shader/);
 }finally{pass.dispose();}
});
