import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createLightShafts } from '../src/vrm/scenes/lightShafts.ts';
const shaft={ground:[0,0,-5],length:12,width:1,intensity:.8};

test('speed changes preserve the animated phase, including pause and resume',()=>{
  const light=createLightShafts([shaft],new THREE.Vector3(1,1,0));
  light.update(10);light.update(11);
  const phase=light.mesh.material.uniforms.uTime.value;
  light.setParameters({speed:0});light.update(30);
  assert.equal(light.mesh.material.uniforms.uTime.value,phase);
  light.setParameters({speed:1});light.update(31);
  assert.equal(light.mesh.material.uniforms.uTime.value,phase+1);
  light.dispose();
});
test('invalid inputs cannot poison GPU uniforms and configurations are isolated',()=>{
  const light=createLightShafts([shaft],new THREE.Vector3());
  light.setSunDirection(new THREE.Vector3(NaN,0,1));
  assert.deepEqual(light.mesh.material.uniforms.uSunDir.value.toArray(),[0,1,0]);
  const p=light.getParameters();p.intensity=900;
  assert.notEqual(light.getParameters().intensity,900);
  light.setParameters({intensity:NaN,width:Infinity,speed:-1});
  assert.equal(light.getParameters().speed,0);
  assert.ok(Number.isFinite(light.getParameters().intensity));
  light.dispose();
});
test('placement replacement handles an empty list and rejects degenerate shafts',()=>{
  const light=createLightShafts([shaft],new THREE.Vector3(0,1,0));
  assert.equal(light.mesh.geometry.instanceCount,1);
  light.setShafts([{...shaft,width:0},{...shaft,length:NaN}]);
  assert.equal(light.mesh.geometry.instanceCount,0);
  light.setShafts([shaft,{...shaft,ground:[1,0,-2]}]);
  assert.equal(light.mesh.geometry.instanceCount,2);
  assert.equal(light.mesh.geometry.index.count,6);
  light.dispose();
});

test('layout grows without reshuffling, scales ground positions and obeys terrain',async()=>{
 const {makeLightShaftLayout}=await import('../src/vrm/scenes/lightShaftLayout.ts');
 const anchors=[[1,-2,1,.5],[-3,-5,2,.7]];
 const ground=(x,z)=>x+z;
 const a=makeLightShaftLayout(anchors,2,1,1,ground);
 const b=makeLightShaftLayout(anchors,5,1,1,ground);
 assert.deepEqual(b.slice(0,2),a);
 assert.deepEqual(makeLightShaftLayout(anchors,5,1,1,ground),b);
 const scaled=makeLightShaftLayout(anchors,2,2,1,ground);
 assert.ok(Math.abs(scaled[0].ground[0]-2)<1e-10);
 assert.ok(Math.abs(scaled[0].ground[2]+4)<1e-10);
 assert.ok(Math.abs(scaled[0].ground[1]+2)<1e-10);
 assert.equal(scaled[0].width,a[0].width);
 const surround=makeLightShaftLayout(anchors,15,1,1,ground);
 for(const sx of [-1,1])for(const sz of [-1,1])assert.ok(surround.some(s=>s.ground[0]*sx>0&&s.ground[2]*sz>0));
 assert.equal(makeLightShaftLayout(anchors,0,1,1,ground).length,0);
 assert.equal(makeLightShaftLayout(anchors,100,1,1,ground).length,48);
});
