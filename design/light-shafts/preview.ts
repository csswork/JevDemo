import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { createPark } from '../../src/vrm/scenes/park';
import { TimeOfDay } from '../../src/vrm/timeOfDay';
const original=false;
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;document.body.prepend(renderer.domElement);
const scene=new THREE.Scene(),park=createPark({timber:!original});scene.add(park.group,...park.lights);scene.fog=park.fog;
scene.add(new THREE.HemisphereLight(park.hemisphere.sky,park.hemisphere.ground,park.hemisphere.intensity));
const sun=new THREE.DirectionalLight(0xfff1dc,2.2);sun.position.set(21,20,5);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-18,right:18,top:18,bottom:-18,near:1,far:70});sun.shadow.bias=-.0002;sun.shadow.normalBias=.025;scene.add(sun);
const env=park.environment;if(env&&'url' in env)new RGBELoader().load(env.url,t=>{const p=new THREE.PMREMGenerator(renderer);scene.environment=p.fromEquirectangular(t).texture;scene.environmentIntensity=env.intensity;scene.environmentRotation.y=env.rotation??0;t.dispose();p.dispose();});
const camera=new THREE.PerspectiveCamera(43,innerWidth/innerHeight,.08,230),controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
function view(kind:string){if(kind==='furniture'){camera.position.set(3.5,1.25,2.5);controls.target.set(1.72,.36,-.18);}else if(kind==='bench'){camera.position.set(.1,1.35,13.8);controls.target.set(3.55,.56,11.55);}else{camera.position.set(3.7,2.1,4.4);controls.target.set(-.8,-.02,-3.4);}controls.update();}
for(const id of ['deck','furniture','bench'])document.getElementById(id)!.onclick=()=>view(id);view('deck');
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
const frustum=new THREE.Frustum(),shadow=new THREE.Frustum(),matrix=new THREE.Matrix4(),size=new THREE.Vector2(),clock=new TimeOfDay();
let last=performance.now();const stats=document.getElementById('stats')!;
function frame(now:number){const dt=Math.min((now-last)/1000,.1);last=now;park.update?.(dt,clock.state);controls.update();camera.updateMatrixWorld();sun.shadow.updateMatrices(sun);frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));shadow.setFromProjectionMatrix(matrix.multiplyMatrices(sun.shadow.camera.projectionMatrix,sun.shadow.camera.matrixWorldInverse));park.beforeRender?.(frustum,shadow,camera,renderer.getDrawingBufferSize(size));renderer.render(scene,camera);stats.textContent=`${renderer.info.render.calls} draws · 光束 1 draw / ${park.lightShafts.mesh.geometry.instanceCount*2} triangles`; requestAnimationFrame(frame);}requestAnimationFrame(frame);

const shaftControls = [
  ['intensity','亮度',0,2,.01],['width','光束宽度',.2,3,.01],['softness','边缘柔和度',0,1,.01],
  ['breakup','细束层次',0,1,.01],['haze','柔雾比例',0,1,.01],['speed','流动速度',0,2,.01],['spread','下方扩散',0,1,.01],
] as const;
const panel=document.getElementById('parameters')!;
function sync(){const p=park.lightShafts.getParameters();for(const [key] of shaftControls){(document.getElementById(key) as HTMLInputElement).value=String(p[key]);document.getElementById(key+'-value')!.textContent=p[key].toFixed(2);}const color='#'+park.lightShafts.getColor().getHexString();(document.getElementById('color') as HTMLInputElement).value=color;document.getElementById('config')!.textContent=JSON.stringify({parameters:p,color},null,2);}
for(const [key,label,min,max,step] of shaftControls){
 const row=document.createElement('label');row.innerHTML=`<span>${label}<output id="${key}-value"></output></span><input id="${key}" aria-label="${label}" type="range" min="${min}" max="${max}" step="${step}">`;panel.append(row);
 row.querySelector('input')!.oninput=e=>{park.lightShafts.setParameters({[key]:Number((e.target as HTMLInputElement).value)});sync();};
}
const natural=park.lightShafts.getParameters();
(document.getElementById('color') as HTMLInputElement).value='#fff6e3';
document.getElementById('natural')!.onclick=()=>{park.lightShafts.setParameters(natural);sync();};
document.getElementById('mist')!.onclick=()=>{park.lightShafts.setParameters({...natural,intensity:.57,width:1.65,haze:.62,softness:.92,breakup:.38});sync();};
document.getElementById('rays')!.onclick=()=>{park.lightShafts.setParameters({...natural,intensity:.95,width:1.05,haze:.12,softness:.55,breakup:.8});sync();};
document.getElementById('enabled')!.onchange=e=>park.lightShafts.mesh.visible=(e.target as HTMLInputElement).checked;
document.getElementById('color')!.oninput=e=>{park.lightShafts.setColor((e.target as HTMLInputElement).value);sync();};
sync();

document.getElementById('toggle')!.onclick=()=>{const panel=document.querySelector('aside')!;panel.hidden=!panel.hidden;};
