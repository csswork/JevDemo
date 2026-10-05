import * as THREE from 'three';
import { createCelestialBodies } from '../../src/vrm/sky/celestialBodies';

const owned:Array<{dispose():void}>=[];
const keep=<T extends {dispose():void}>(v:T)=>{owned.push(v);return v;};
const u={glow:{value:new THREE.Color(0xffbd78)},sunColor:{value:new THREE.Color(0xfff4d5)},
  sunDir:{value:new THREE.Vector3(0,.55,1).normalize()},phase:{value:.5},moonOn:{value:1}};
const bodies=createCelestialBodies(keep,u);
bodies.sun.scale.setScalar(1000);bodies.moon.scale.setScalar(500);
const stages=[['sun',bodies.sun,0x7197bc],['moon',bodies.moon,0x071124]] as const;
const views=stages.map(([id,body,color])=>{
  const canvas=document.getElementById(id) as HTMLCanvasElement;
  const renderer=keep(new THREE.WebGLRenderer({canvas,antialias:true}));
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(color);
  const camera=new THREE.PerspectiveCamera(40,1,.1,2000);camera.position.z=700;
  const scene=new THREE.Scene();scene.add(body);
  return {renderer,camera,scene,canvas};
});
function render(){for(const {renderer,camera,scene,canvas} of views){
  const {width,height}=canvas.getBoundingClientRect();
  renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();renderer.render(scene,camera);
}}
const phase=document.getElementById('phase') as HTMLInputElement;
phase.oninput=()=>{u.phase.value=Number(phase.value);render();};
document.getElementById('full')!.onclick=()=>{phase.value='.5';u.phase.value=.5;render();};
document.getElementById('quarter')!.onclick=()=>{phase.value='.25';u.phase.value=.25;render();};
document.getElementById('day')!.onclick=()=>{u.sunDir.value.y=.55;u.sunColor.value.set(0xfff4d5);views[0].renderer.setClearColor(0x7197bc);render();};
document.getElementById('sunset')!.onclick=()=>{u.sunDir.value.y=.035;u.sunColor.value.set(0xffd19b);views[0].renderer.setClearColor(0xb18487);render();};
addEventListener('resize',render);render();
addEventListener('pagehide',()=>{for(const item of owned)item.dispose();},{once:true});
