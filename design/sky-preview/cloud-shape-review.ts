import * as THREE from 'three';
import { createSkyRenderer } from '../../src/vrm/sky/skyRenderer';
import { TimeOfDay } from '../../src/vrm/timeOfDay';

const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas')!,antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.outputColorSpace=THREE.SRGBColorSpace;
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,2000);
camera.lookAt(.72,.23,-1);
const sky=createSkyRenderer();sky.setCirrusCoverage(0);sky.setWind(27,0);scene.add(sky.group);
const time=new TimeOfDay();time.setMode(15,true);
const coverage=document.getElementById('coverage') as HTMLInputElement;
const age=document.getElementById('age') as HTMLInputElement;
const wind=document.getElementById('wind') as HTMLInputElement;
const play=document.getElementById('play')!;
let playing=false,seconds=0,last=performance.now(),frameId=0;
function render(){
  sky.setAnimationTime(seconds);sky.update(time.state,0,camera,Number(coverage.value),.5);
  sky.renderClouds(renderer,camera);renderer.render(scene,camera);
  document.getElementById('amount')!.textContent=`${Math.round(Number(coverage.value)*100)}%`;
  document.getElementById('seconds')!.textContent=`${Math.round(seconds)} 秒`;
}
function resize(){renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();render();}
coverage.oninput=render;
age.oninput=()=>{playing=false;play.textContent='播放形变';seconds=Number(age.value);render();};
wind.onchange=()=>{sky.setWind(27,wind.checked?2:0);render();};
play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放形变';last=performance.now();};
document.getElementById('reset')!.onclick=()=>{seconds=0;age.value='0';render();};
function frame(now:number){const dt=Math.min((now-last)/1000,.1);last=now;
  if(playing){seconds=(seconds+dt)%300;age.value=String(seconds);render();}
  frameId=requestAnimationFrame(frame);
}
addEventListener('resize',resize);resize();frameId=requestAnimationFrame(frame);
addEventListener('pagehide',()=>{cancelAnimationFrame(frameId);sky.dispose();renderer.dispose();},{once:true});
