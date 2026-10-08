import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { createPark } from '../../src/vrm/scenes/park';
import { TimeOfDay } from '../../src/vrm/timeOfDay';
const original=new URLSearchParams(location.search).has('original');
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
function frame(now:number){const dt=Math.min((now-last)/1000,.1);last=now;park.update?.(dt,clock.state);controls.update();camera.updateMatrixWorld();sun.shadow.updateMatrices(sun);frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));shadow.setFromProjectionMatrix(matrix.multiplyMatrices(sun.shadow.camera.projectionMatrix,sun.shadow.camera.matrixWorldInverse));park.beforeRender?.(frustum,shadow,camera,renderer.getDrawingBufferSize(size));renderer.render(scene,camera);stats.textContent=`${original?'原模型':park.group.userData.timberReady?'新模型已加载':'模型加载中'} · ${renderer.info.render.calls} draws · ${renderer.info.render.triangles.toLocaleString()} triangles`;requestAnimationFrame(frame);}requestAnimationFrame(frame);
