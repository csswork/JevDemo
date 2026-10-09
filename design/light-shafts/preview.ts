import {createPreviewSun,setPreviewSunElevation} from './sun';
import {createParkGodrays,GODRAY_DEFAULTS,type GodraySettings} from './godrays';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { createPark } from '../../src/vrm/scenes/park';
import { TimeOfDay } from '../../src/vrm/timeOfDay';
const original=false;
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.NoToneMapping;renderer.info.autoReset=false;document.body.prepend(renderer.domElement);
const scene=new THREE.Scene(),park=createPark({timber:!original,volumetricShadows:true});scene.add(park.group,...park.lights);scene.fog=park.fog;
scene.add(new THREE.HemisphereLight(park.hemisphere.sky,park.hemisphere.ground,park.hemisphere.intensity));
const sun=createPreviewSun();scene.add(sun);
function setSunElevation(degrees:number){setPreviewSunElevation(sun,degrees);}
setSunElevation(35);
const env=park.environment;if(env&&'url' in env)new HDRLoader().load(env.url,t=>{const p=new THREE.PMREMGenerator(renderer);scene.environment=p.fromEquirectangular(t).texture;scene.environmentIntensity=env.intensity;scene.environmentRotation.y=env.rotation??0;t.dispose();p.dispose();});
const camera=new THREE.PerspectiveCamera(43,innerWidth/innerHeight,.08,230),controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
function view(kind:string){if(kind==='sunlight'){camera.position.set(-3,2,4);controls.target.set(8,5,0);}else if(kind==='furniture'){camera.position.set(3.5,1.25,2.5);controls.target.set(1.72,.36,-.18);}else if(kind==='bench'){camera.position.set(.1,1.35,13.8);controls.target.set(3.55,.56,11.55);}else{camera.position.set(3.7,2.1,4.4);controls.target.set(-.8,-.02,-3.4);}controls.update();}
for(const id of ['deck','furniture','bench','sunlight'])document.getElementById(id)!.onclick=()=>view(id);view('deck');
const godrays=createParkGodrays(renderer,scene,camera,sun);godrays.resize(innerWidth,innerHeight);park.lightShafts.mesh.visible=false;
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);godrays.resize(innerWidth,innerHeight);});
const frustum=new THREE.Frustum(),shadow=new THREE.Frustum(),matrix=new THREE.Matrix4(),size=new THREE.Vector2(),clock=new TimeOfDay();
let last=performance.now(),sampleStart=last,frames=0;const stats=document.getElementById('stats')!;
function frame(now:number){const dt=Math.min((now-last)/1000,.1);last=now;park.update?.(dt,clock.state);controls.update();camera.updateMatrixWorld();sun.shadow.updateMatrices(sun);frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));shadow.setFromProjectionMatrix(matrix.multiplyMatrices(sun.shadow.camera.projectionMatrix,sun.shadow.camera.matrixWorldInverse));park.beforeRender?.(frustum,shadow,camera,renderer.getDrawingBufferSize(size));renderer.info.reset();godrays.render(dt);frames++;if(now-sampleStart>1000){stats.textContent=`${Math.round(frames*1000/(now-sampleStart))} FPS · ${renderer.info.render.calls} draws · ${settings.raymarchSteps} 步 / ${settings.resolutionScale}×分辨率（FPS 非 GPU 耗时）`;frames=0;sampleStart=now;} requestAnimationFrame(frame);}requestAnimationFrame(frame);

const settings:GodraySettings={...GODRAY_DEFAULTS};
const shaftControls = [
 ['density','雾密度',0,.03,.0005],['maxDensity','散射上限（限幅）',0,.7,.01],['distanceAttenuation','距离衰减',0,5,.05],['raymarchSteps','采样步数（细节）',16,96,1],
] as const;
const panel=document.getElementById('parameters')!;
function sync(){godrays.configure(settings);(document.getElementById('quality') as HTMLSelectElement).value=String(settings.resolutionScale);for(const [key] of shaftControls){(document.getElementById(key) as HTMLInputElement).value=String(settings[key]);document.getElementById(key+'-value')!.textContent=String(settings[key]);}(document.getElementById('color') as HTMLInputElement).value=settings.color;document.getElementById('config')!.textContent=JSON.stringify(settings,null,2);}
for(const [key,label,min,max,step] of shaftControls){
 const row=document.createElement('label');row.innerHTML=`<span>${label}<output id="${key}-value"></output></span><input id="${key}" aria-label="${label}" type="range" min="${min}" max="${max}" step="${step}">`;panel.append(row);
 row.querySelector('input')!.oninput=e=>{settings[key]=Number((e.target as HTMLInputElement).value);sync();};
}
document.getElementById('natural')!.onclick=()=>{Object.assign(settings,GODRAY_DEFAULTS);setSunElevation(35);(document.getElementById('sunElevation') as HTMLInputElement).value='35';document.getElementById('sunElevation-value')!.textContent='35°';sync();};
document.getElementById('mist')!.onclick=()=>{Object.assign(settings,GODRAY_DEFAULTS,{density:.02,maxDensity:.38,distanceAttenuation:.3});sync();};
document.getElementById('rays')!.onclick=()=>{Object.assign(settings,GODRAY_DEFAULTS,{density:.018,maxDensity:.45,distanceAttenuation:.15,raymarchSteps:80});sync();};
document.getElementById('mode')!.onchange=e=>{const mode=(e.target as HTMLSelectElement).value;godrays.setEnabled(mode==='volume');park.lightShafts.mesh.visible=mode==='legacy';(document.getElementById('volume-controls') as HTMLFieldSetElement).disabled=mode!=='volume';document.getElementById('mode-hint')!.textContent=mode==='volume'?'参数作用于树叶遮挡体积光。密度为 0 时无散射；散射上限只限制过亮区域。':'当前为'+(mode==='legacy'?'原光束面片':'关闭光束')+'，下方体积光参数暂不生效。';};
document.getElementById('quality')!.onchange=e=>{settings.resolutionScale=Number((e.target as HTMLSelectElement).value);sync();};
document.getElementById('color')!.oninput=e=>{settings.color=(e.target as HTMLInputElement).value;sync();};
document.getElementById('sunElevation')!.oninput=e=>{const angle=Number((e.target as HTMLInputElement).value);setSunElevation(angle);document.getElementById('sunElevation-value')!.textContent=angle+'°';};
sync();
document.getElementById('toggle')!.onclick=()=>{const panel=document.querySelector('aside')!;panel.hidden=!panel.hidden;};
window.addEventListener('pagehide',()=>{godrays.dispose();park.dispose();controls.dispose();renderer.dispose();},{once:true});
