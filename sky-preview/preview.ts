import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createStreet } from '../src/vrm/scenes/street';
import { createSkyMapping } from '../src/vrm/scenes/streetTime';
import { REFLECT_LAYER } from '../src/vrm/scenes/water';
import { TimeOfDay } from '../src/vrm/timeOfDay';
import { createSkyRenderer } from '../design/sky-preview/skyRenderer';
import {createOceanRenderer as createAnalyticOcean} from '../design/ocean-preview/analyticOceanRenderer';
import {validateFftOcean} from '../design/ocean-preview/fftOceanSimulation';
import { createOceanRenderer } from '../design/ocean-preview/oceanRenderer';

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
const cirrus=el<HTMLInputElement>('cirrus');
function applyCirrus(){sky.setCirrusCoverage(Number(cirrus.value));el('cirrus-value').textContent=Math.round(Number(cirrus.value)*100)+'%';}
cirrus.oninput=applyCirrus;applyCirrus();
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
const originalSea=street.group.getObjectByName('sea') as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
const waterUniforms=originalSea.material.uniforms;
const oceanOptions={y:originalSea.position.y,shore:{map:waterUniforms.uShore.value,bounds:waterUniforms.uShoreBounds.value,max:waterUniforms.uShoreMax.value},breakwater:waterUniforms.uBreakwater.value,reflectionLayer:REFLECT_LAYER};
let ocean:ReturnType<typeof createOceanRenderer>|ReturnType<typeof createAnalyticOcean>=createOceanRenderer(oceanOptions);
world.add(ocean.group);originalSea.visible=false;
let benchmarking=false;
const oceanEnabled=el<HTMLInputElement>('new-ocean');
const model=el<HTMLSelectElement>('ocean-model'),resolution=el<HTMLSelectElement>('ocean-resolution');
function switchOcean(){
 const parameters={...ocean.parameters};world.remove(ocean.group);ocean.dispose();
 ocean=model.value==='fft'?createOceanRenderer(oceanOptions):createAnalyticOcean(oceanOptions);
 ocean.setParameters(parameters);ocean.setPaused(el<HTMLInputElement>('ocean-paused').checked);
 ocean.setQuality(el<HTMLSelectElement>('ocean-quality').value as 'low'|'balanced'|'high');
 ocean.setWind(Number(el<HTMLInputElement>('wind-direction').value),Number(el<HTMLInputElement>('wind-speed').value));
 if(model.value==='fft')(ocean as ReturnType<typeof createOceanRenderer>).setResolution(Number(resolution.value) as 128|256);
 world.add(ocean.group);
}
model.onchange=switchOcean;
resolution.onchange=()=>{if('setResolution' in ocean)ocean.setResolution(Number(resolution.value) as 128|256);};
el('ocean-validate').onclick=()=>{
 try{el('ocean-report').textContent=JSON.stringify(validateFftOcean(renderer),null,2);}
 catch(error){el('ocean-report').textContent=String(error);}
};
el('ocean-benchmark').onclick=async()=>{
 const report=el('ocean-report'),button=el<HTMLButtonElement>('ocean-benchmark');button.disabled=true;benchmarking=true;
 const savedModel=model.value,savedResolution=resolution.value;
 const pausedInput=el<HTMLInputElement>('ocean-paused'),wasPaused=pausedInput.checked;pausedInput.checked=false;
 const gl=renderer.getContext() as WebGL2RenderingContext,ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
 const results=[];
 const settings={hour:Number(el<HTMLInputElement>('hour').value),camera:camera.position.toArray(),reflectionQuality:el<HTMLSelectElement>('ocean-quality').value,parameters:{...ocean.parameters}};
 try{
  for(const variant of ['analytic','128','256']){
   model.value=variant==='analytic'?'analytic':'fft';resolution.value=variant==='256'?'256':'128';switchOcean();
   report.textContent='测量 '+variant+'…';
   const samples:number[]=[],queries:WebGLQuery[]=[];
   for(let i=0;i<64;i++){
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const q=ext?gl.createQuery():null;
    if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
    const start=performance.now();
    ocean.update(time.state,1/60,camera,directions);
    if('renderSimulation' in ocean)ocean.renderSimulation(renderer);
    // Measure the complete visible scene as well as the simulation and mirror.
    ocean.renderReflection(renderer,world,camera);
    renderer.setRenderTarget(null);renderer.autoClear=true;sky.renderClouds(renderer,camera);renderer.render(background,camera);renderer.autoClear=false;renderer.clearDepth();renderer.render(world,camera);renderer.autoClear=true;
    const cpu=performance.now()-start;
    if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);if(i>=16)queries.push(q);else gl.deleteQuery(q);}
    if(i>=16)samples.push(cpu);
   }
   const gpu:number[]=[];
   for(let attempt=0;attempt<60&&queries.length;attempt++){
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    for(let i=queries.length-1;i>=0;i--){const q=queries[i];if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)){
     if(!gl.getParameter(ext.GPU_DISJOINT_EXT))gpu.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
     gl.deleteQuery(q);queries.splice(i,1);
    }}
   }
   for(const q of queries)gl.deleteQuery(q);
   const median=(a:number[])=>a.length?a.sort((x,y)=>x-y)[Math.floor(a.length/2)]:null;
   results.push({variant,cpuSubmissionMedianMs:median(samples),gpuFrameMedianMs:median(gpu),gpuSamples:gpu.length,simulation:'simulationStats' in ocean?ocean.simulationStats:null});
  }
  report.textContent=JSON.stringify({viewport:[canvas.width,canvas.height],samples:48,settings,results},null,2);
 }catch(error){report.textContent=String(error);}
 finally{pausedInput.checked=wasPaused;model.value=savedModel;resolution.value=savedResolution;switchOcean();button.disabled=false;benchmarking=false;}
};
el<HTMLInputElement>('ocean-paused').onchange=e=>ocean.setPaused((e.target as HTMLInputElement).checked);
for(const name of ['waves','roughness','foam','reflection','glitter'] as const){const input=el<HTMLInputElement>('ocean-'+name);input.oninput=()=>{ocean.setParameters({[name]:Number(input.value)});el('ocean-'+name+'-value').textContent=Number(input.value).toFixed(2);};}
el<HTMLSelectElement>('ocean-quality').onchange=e=>ocean.setQuality((e.target as HTMLSelectElement).value as 'low'|'balanced'|'high');
el('toggle-ocean').onclick=()=>{const panel=el('ocean-controls');panel.hidden=!panel.hidden;el('toggle-ocean').textContent=panel.hidden?'海洋控制':'收起海洋控制';if(!panel.hidden){el('sky-controls').hidden=true;el('toggle-controls').textContent='展开天空控制';}};
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
 if(kind==='glints'){camera.position.set(14,2.4,-12);const light=time.state.sunElev>-3?directions.sun:directions.moon;controls.target.set(camera.position.x+light.x*110,-1.2,camera.position.z+light.z*110);}
 else if(kind==='shore'){camera.position.set(14,2,0);controls.target.set(6,-1.2,-10);}
 else if(kind==='flowers'){const anchor=world.getObjectByName('street-flower-preview');if(anchor){controls.target.copy(anchor.position);camera.position.fromArray(anchor.userData.camera);}}
 else if(kind==='plants'){const anchor=world.getObjectByName('street-potted-preview');if(anchor){controls.target.copy(anchor.position);camera.position.fromArray(anchor.userData.camera);}}
 else if(kind==='town'){camera.position.set(145,22,-700);controls.target.set(270,8,-1050);}
 else if(kind==='ocean'){camera.position.set(20,2,4);controls.target.set(85,-.2,-85);}
 else if(kind==='sea'){camera.position.set(0,2.2,5);controls.target.set(55,9,-48);}
 else if(kind==='wide'){camera.position.set(9,9,28);controls.target.set(-5,5,-38);}
 else{camera.position.set(0,2.4,12);controls.target.set(-4,6,-45);}
 controls.update();}
setView('street');el('street-view').onclick=()=>setView('street');el('sea-view').onclick=()=>setView('sea');el('wide-view').onclick=()=>setView('wide');
el<HTMLSelectElement>('building-review').onchange=e=>{
 const id=(e.target as HTMLSelectElement).value,anchor=world.getObjectByName(`street-building-preview-${id}`);
 if(!anchor)return;follow.checked=false;controls.target.copy(anchor.position);camera.position.fromArray(anchor.userData.camera);controls.update();
};
el('flower-view').onclick=()=>setView('flowers');el('plant-view').onclick=()=>setView('plants');el('town-view').onclick=()=>setView('town');el('ocean-view').onclick=()=>setView('ocean');el('shore-view').onclick=()=>setView('shore');el('glint-view').onclick=()=>setView('glints');
el('toggle-controls').onclick=()=>{const panel=el('sky-controls');panel.hidden=!panel.hidden;el('toggle-controls').textContent=panel.hidden?'展开天空控制':'收起天空控制';if(!panel.hidden){el('ocean-controls').hidden=true;el('toggle-ocean').textContent='海洋控制';}};
controls.addEventListener('start',()=>follow.checked=false);
let playing=false,last=performance.now(),frameId=0;
function setHour(h:number){hour.value=String(h);time.setMode(h,true);envSignature='';}
hour.oninput=()=>{playing=false;play.textContent='播放一天';setHour(Number(hour.value));};
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-hour]'))b.onclick=()=>{playing=false;play.textContent='播放一天';setHour(Number(b.dataset.hour));};
play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放一天';play.setAttribute('aria-pressed',String(playing));};
coverage.oninput=()=>{el('coverage-value').textContent=Math.round(Number(coverage.value)*100)+'%';};
el<HTMLSelectElement>('quality').onchange=e=>sky.setQuality((e.target as HTMLSelectElement).value as 'low'|'balanced'|'high');
function applyWind(){sky.setWind(Number(windDirection.value),Number(windSpeed.value));ocean.setWind(Number(windDirection.value),Number(windSpeed.value));el('wind-info').textContent=`风向 ${windDirection.value}° · 风速 ${Number(windSpeed.value).toFixed(1)} m/s`;}
windDirection.oninput=windSpeed.oninput=applyWind;applyWind();
function resize(){renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();
function frame(now:number){const dt=Math.min((now-last)/1000,.1);last=now;
 if(benchmarking){frameId=requestAnimationFrame(frame);return;}
 if(playing)setHour((Number(hour.value)+dt*.25)%24);time.update(dt);
 time.state.moonPhase=Number(phase.value);street.update?.(dt,time.state);
 mapping.sun(time.state,directions.sun);mapping.moon(time.state,directions.moon);
 controls.enabled=!follow.checked;if(follow.checked)camera.lookAt(camera.position.clone().add(time.state.sunElev>-3?directions.sun:directions.moon));else controls.update();
 sky.update(time.state,dt,camera,Number(coverage.value),Number(phase.value),directions);
 ocean.update(time.state,dt,camera,directions);
 const L=street.lighting!;key.color.copy(L.sun.color);key.intensity=L.sun.intensity;key.position.copy(L.sun.position);key.shadow.intensity=L.sun.shadow;
 fill.color.copy(L.fill.color);fill.intensity=L.fill.intensity;rim.color.copy(L.rim.color);rim.intensity=L.rim.intensity;
 hemi.color.copy(L.hemisphere.sky);hemi.groundColor.copy(L.hemisphere.ground);hemi.intensity=L.hemisphere.intensity;world.environmentIntensity=L.environmentIntensity;
 reflectedSky.children.forEach((child,i)=>{const source=sky.environmentScene.children[i];child.position.copy(source.position);child.quaternion.copy(source.quaternion);child.scale.copy(source.scale);child.visible=source.visible;});
 const signature=`${Math.round(time.state.sunElev*2)}|${Math.round(Number(coverage.value)*100)}|${cirrus.value}|${phase.value}`;
 // Bake on a control/time change at most once per second, never every wind frame.
 if(signature!==envSignature&&now-lastBake>1000){const previous=renderer.getRenderTarget();
  const next=pmrem.fromScene(sky.environmentScene,0,.1,4000,{size:128});renderer.setRenderTarget(previous);
  environment?.dispose();environment=next;world.environment=next.texture;envSignature=signature;lastBake=now;
 }
 street.group.visible=visible.checked;for(const l of street.lights)l.visible=visible.checked;
 originalSea.visible=!oceanEnabled.checked;ocean.group.visible=visible.checked&&oceanEnabled.checked;
 if(ocean.group.visible&&'renderSimulation' in ocean)ocean.renderSimulation(renderer);
 if(ocean.group.visible)ocean.renderReflection(renderer,world,camera);
 renderer.autoClear=true;sky.renderClouds(renderer,camera);renderer.render(background,camera);
 if(visible.checked){renderer.autoClear=false;renderer.clearDepth();renderer.render(world,camera);renderer.autoClear=true;}
 const h=Number(hour.value);el<HTMLOutputElement>('clock').value=`${String(Math.floor(h)).padStart(2,'0')}:${String(Math.floor(h%1*60)).padStart(2,'0')}`;
 status.dataset.drawCalls=String(renderer.info.render.calls);status.dataset.triangles=String(renderer.info.render.triangles);
 status.textContent=time.state.sunElev>-3?'街景 · 新天空 · 日光':'街景 · 新天空 · 夜色';status.dataset.ready=String(assetsPending===0);status.dataset.assetsFailed=String(assetsFailed);
 frameId=requestAnimationFrame(frame);
}
frameId=requestAnimationFrame(frame);
addEventListener('pagehide',()=>{cancelAnimationFrame(frameId);controls.dispose();ocean.dispose();street.dispose();sky.dispose();environment?.dispose();pmrem.dispose();renderer.dispose();manager.onStart=manager.onLoad=manager.onProgress=manager.onError=()=>{};},{once:true});
