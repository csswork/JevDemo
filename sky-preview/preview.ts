import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createStreet } from '../src/vrm/scenes/street';
import { createSkyMapping } from '../src/vrm/scenes/streetTime';
import { REFLECT_LAYER } from '../src/vrm/scenes/water';
import { TimeOfDay } from '../src/vrm/timeOfDay';
import { createSkyRenderer } from '../design/sky-preview/skyRenderer';

const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const canvas=document.querySelector('canvas')!;
const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const world=new THREE.Scene(),background=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(60,1,.1,4000);
const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.maxDistance=180;controls.minDistance=2;
const sky=createSkyRenderer();background.add(sky.group);
const time=new TimeOfDay();time.setMode(15,true);
const mapping=createSkyMapping([2,2.3,.9]);
const directions={sun:new THREE.Vector3(),moon:new THREE.Vector3()};
const key=new THREE.DirectionalLight(),fill=new THREE.DirectionalLight(),rim=new THREE.DirectionalLight();
const hemi=new THREE.HemisphereLight();fill.position.set(-1.6,1.2,1);rim.position.set(-.6,1.6,-2);
key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.normalBias=.04;key.shadow.radius=3;
Object.assign(key.shadow.camera,{left:-22,right:22,top:22,bottom:-22,near:-40,far:40});key.shadow.camera.updateProjectionMatrix();
world.add(key,key.target,fill,rim,hemi);
const hour=el<HTMLInputElement>('hour'),coverage=el<HTMLInputElement>('coverage'),phase=el<HTMLInputElement>('phase');
const follow=el<HTMLInputElement>('follow'),visible=el<HTMLInputElement>('street-visible');
const status=el('status'),loadState=el('load-state'),play=el<HTMLButtonElement>('play');
const windDirection=el<HTMLInputElement>('wind-direction'),windSpeed=el<HTMLInputElement>('wind-speed');
let assetsPending=0,assetsFailed=0;
const manager=THREE.DefaultLoadingManager;
manager.onStart=()=>{assetsPending++;loadState.textContent='载入街景资源…';};
manager.onProgress=(_url,loaded,total)=>{assetsPending=total-loaded;loadState.textContent=`街景资源 ${loaded}/${total}`;};
manager.onError=()=>assetsFailed++;
manager.onLoad=()=>{assetsPending=0;loadState.textContent=assetsFailed?`资源缺失 ${assetsFailed} 项`:'街景资源已就绪';};
const street=createStreet();world.add(street.group,...street.lights);world.fog=street.fog;
// Identify only the legacy sky and cirrus by their shader interfaces, keeping all far land/town.
let legacySkyCount=0;
street.group.traverse(o=>{const mesh=o as THREE.Mesh;if(!mesh.isMesh)return;
 const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
 if(materials.some(m=>{const u=(m as THREE.ShaderMaterial).uniforms;return !!u&&(!!u.uZenith||!!u.uCirrus);})){mesh.visible=false;legacySkyCount++;}
});
status.dataset.legacySkyCount=String(legacySkyCount);
const reflectedSky=sky.environmentScene.clone();
reflectedSky.traverse(o=>o.layers.set(REFLECT_LAYER));world.add(reflectedSky);
const pmrem=new THREE.PMREMGenerator(renderer);let environment:THREE.WebGLRenderTarget|null=null,envSignature='',lastBake=-Infinity;
const frustum=new THREE.Frustum(),shadowFrustum=new THREE.Frustum(),matrix=new THREE.Matrix4(),size=new THREE.Vector2();
world.onBeforeRender=(_renderer,_scene,cam)=>{
 if(cam!==camera)return;
 matrix.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);frustum.setFromProjectionMatrix(matrix);
 key.shadow.updateMatrices(key);const sc=key.shadow.camera;
 matrix.multiplyMatrices(sc.projectionMatrix,sc.matrixWorldInverse);shadowFrustum.setFromProjectionMatrix(matrix);
 renderer.getDrawingBufferSize(size);street.beforeRender?.(frustum,key.castShadow?shadowFrustum:null,cam,size);
};
function setView(kind:string){follow.checked=false;
 if(kind==='sea'){camera.position.set(0,2.2,5);controls.target.set(55,9,-48);}
 else if(kind==='wide'){camera.position.set(9,9,28);controls.target.set(-5,5,-38);}
 else{camera.position.set(0,2.4,12);controls.target.set(-4,6,-45);}
 controls.update();}
setView('street');el('street-view').onclick=()=>setView('street');el('sea-view').onclick=()=>setView('sea');el('wide-view').onclick=()=>setView('wide');
el('toggle-controls').onclick=()=>{const panel=el('sky-controls');panel.hidden=!panel.hidden;el('toggle-controls').textContent=panel.hidden?'展开天空控制':'收起天空控制';};
controls.addEventListener('start',()=>follow.checked=false);
let playing=false,last=performance.now(),frameId=0;
function setHour(h:number){hour.value=String(h);time.setMode(h,true);envSignature='';}
hour.oninput=()=>{playing=false;play.textContent='播放一天';setHour(Number(hour.value));};
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-hour]'))b.onclick=()=>{playing=false;play.textContent='播放一天';setHour(Number(b.dataset.hour));};
play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放一天';play.setAttribute('aria-pressed',String(playing));};
coverage.oninput=()=>{el('coverage-value').textContent=Math.round(Number(coverage.value)*100)+'%';};
el<HTMLSelectElement>('quality').onchange=e=>sky.setQuality((e.target as HTMLSelectElement).value as 'low'|'balanced'|'high');
function applyWind(){sky.setWind(Number(windDirection.value),Number(windSpeed.value));el('wind-info').textContent=`风向 ${windDirection.value}° · 风速 ${Number(windSpeed.value).toFixed(1)} m/s`;}
windDirection.oninput=windSpeed.oninput=applyWind;applyWind();
function resize(){renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();
function frame(now:number){const dt=Math.min((now-last)/1000,.1);last=now;
 if(playing)setHour((Number(hour.value)+dt*.25)%24);time.update(dt);
 time.state.moonPhase=Number(phase.value);street.update?.(dt,time.state);
 mapping.sun(time.state,directions.sun);mapping.moon(time.state,directions.moon);
 controls.enabled=!follow.checked;if(follow.checked)camera.lookAt(camera.position.clone().add(time.state.sunElev>-3?directions.sun:directions.moon));else controls.update();
 sky.update(time.state,dt,camera,Number(coverage.value),Number(phase.value),directions);
 const L=street.lighting!;key.color.copy(L.sun.color);key.intensity=L.sun.intensity;key.position.copy(L.sun.position);key.shadow.intensity=L.sun.shadow;
 fill.color.copy(L.fill.color);fill.intensity=L.fill.intensity;rim.color.copy(L.rim.color);rim.intensity=L.rim.intensity;
 hemi.color.copy(L.hemisphere.sky);hemi.groundColor.copy(L.hemisphere.ground);hemi.intensity=L.hemisphere.intensity;world.environmentIntensity=L.environmentIntensity;
 reflectedSky.children.forEach((child,i)=>{const source=sky.environmentScene.children[i];child.position.copy(source.position);child.quaternion.copy(source.quaternion);child.scale.copy(source.scale);child.visible=source.visible;});
 const signature=`${Math.round(time.state.sunElev*2)}|${Math.round(Number(coverage.value)*100)}|${phase.value}`;
 // Bake on a control/time change at most once per second, never every wind frame.
 if(signature!==envSignature&&now-lastBake>1000){const previous=renderer.getRenderTarget();
  const next=pmrem.fromScene(sky.environmentScene,0,.1,4000,{size:128});renderer.setRenderTarget(previous);
  environment?.dispose();environment=next;world.environment=next.texture;envSignature=signature;lastBake=now;
 }
 street.group.visible=visible.checked;for(const l of street.lights)l.visible=visible.checked;
 renderer.autoClear=true;sky.renderClouds(renderer,camera);renderer.render(background,camera);
 if(visible.checked){renderer.autoClear=false;renderer.clearDepth();renderer.render(world,camera);renderer.autoClear=true;}
 const h=Number(hour.value);el<HTMLOutputElement>('clock').value=`${String(Math.floor(h)).padStart(2,'0')}:${String(Math.floor(h%1*60)).padStart(2,'0')}`;
 status.textContent=time.state.sunElev>-3?'街景 · 新天空 · 日光':'街景 · 新天空 · 夜色';status.dataset.ready=String(assetsPending===0);status.dataset.assetsFailed=String(assetsFailed);
 frameId=requestAnimationFrame(frame);
}
frameId=requestAnimationFrame(frame);
addEventListener('pagehide',()=>{cancelAnimationFrame(frameId);controls.dispose();street.dispose();sky.dispose();environment?.dispose();pmrem.dispose();renderer.dispose();manager.onStart=manager.onLoad=manager.onProgress=manager.onError=()=>{};},{once:true});
