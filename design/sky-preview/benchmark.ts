import * as THREE from 'three';
import {TimeOfDay} from '../../src/vrm/timeOfDay';
import {createSkyRenderer as baseline} from './baselineRenderer';
import {createSkyRenderer as optimized} from './skyRenderer';
const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas')!,antialias:true});
renderer.setPixelRatio(1);renderer.setSize(1280,720,false);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.info.autoReset=false;
const gl=renderer.getContext() as WebGL2RenderingContext,ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
const camera=new THREE.PerspectiveCamera(65,1280/720,.1,2000),clock=new TimeOfDay();
const nextFrame=()=>new Promise<number>(resolve=>requestAnimationFrame(resolve));
function stats(values:number[]){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return {median:Number(sorted[Math.floor(sorted.length*.5)].toFixed(3)),p95:Number(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))].toFixed(3)),samples:values.length};}
const progress=document.querySelector('#progress')!,report=document.querySelector('#report')!,button=document.querySelector<HTMLButtonElement>('#run')!;
button.onclick=async()=>{
 button.disabled=true;report.textContent='';
 const debug=gl.getExtension('WEBGL_debug_renderer_info');
 const result:{[key:string]:unknown}={viewport:[1280,720],dpr:1,userAgent:navigator.userAgent,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'not exposed',gpuTimer:!!ext,warmup:16,samplesPerScenario:48,results:[]};
 const results:unknown[]=[];
 try{
 for(const mode of ['baseline','balanced','high','low'] as const){
  const sky:ReturnType<typeof baseline> & Partial<Pick<ReturnType<typeof optimized>,'setQuality'|'renderClouds'|'setCirrusCoverage'>>=mode==='baseline'?baseline():optimized();const scene=new THREE.Scene();scene.add(sky.group);
  if(sky.setQuality)sky.setQuality(mode==='low'?'low':mode==='high'?'high':'balanced');
  for(const scenario of [{name:'day-clouds',hours:15,coverage:.32,cirrus:0},{name:'sunset-clouds',hours:18.8,coverage:.22,cirrus:0},{name:'night-clouds',hours:22,coverage:.32,cirrus:0},{name:'clear-night',hours:22,coverage:0,cirrus:0},{name:'day-layered-clouds',hours:15,coverage:.32,cirrus:.65},{name:'day-cirrus-only',hours:15,coverage:0,cirrus:.65}]){
   if(mode==='baseline'&&scenario.cirrus>0)continue;
   sky.setCirrusCoverage?.(scenario.cirrus);
   progress.textContent=`运行中：${mode} / ${scenario.name}`;
   clock.setMode(scenario.hours,true);
   sky.update(clock.state,0,camera,scenario.coverage,.5);
   const d=scenario.hours===22?sky.moonDir:sky.sunDir;
   const yaw=Math.atan2(d.z,d.x),pitch=THREE.MathUtils.clamp(Math.asin(d.y),.12,1.16);
   camera.lookAt(Math.cos(yaw)*Math.cos(pitch),Math.sin(pitch),Math.sin(yaw)*Math.cos(pitch));
   const cpu:number[]=[],interval:number[]=[],gpu:number[]=[],pending:WebGLQuery[]=[];let previous=0,calls=0,triangles=0;
   function collect(){if(!ext)return;if(gl.getParameter(ext.GPU_DISJOINT_EXT)){for(const q of pending)gl.deleteQuery(q);pending.length=0;return;}for(let i=pending.length-1;i>=0;i--){const q=pending[i];if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)){gpu.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(q);pending.splice(i,1);}}}
   for(let i=0;i<64;i++){
    const now=await nextFrame();if(i>=16&&previous)interval.push(now-previous);previous=now;
    collect();const measured=i>=16;const query=ext&&measured&&pending.length<8?gl.createQuery():null;
    if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    const start=performance.now();renderer.info.reset();
    if(sky.renderClouds)sky.renderClouds(renderer,camera);
    renderer.render(scene,camera);
    if(measured){cpu.push(performance.now()-start);calls=renderer.info.render.calls;triangles=renderer.info.render.triangles;}
    if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);pending.push(query);}
   }
   for(let i=0;i<20&&pending.length;i++){await nextFrame();collect();}
   for(const q of pending)gl.deleteQuery(q);
   results.push({mode,scenario:scenario.name,coverage:scenario.coverage,cirrusCoverage:scenario.cirrus,cpuSubmissionMs:stats(cpu),frameIntervalMs:stats(interval),gpuMs:stats(gpu),drawCalls:calls,triangles});
   result.results=results;report.textContent=JSON.stringify(result,null,2);
  }
  sky.dispose();scene.clear();
 }
 progress.textContent='比较完成';report.setAttribute('data-ready','true');
 }catch(error){progress.textContent=`比较失败：${String(error)}`;throw error;}finally{button.disabled=false;}
};
