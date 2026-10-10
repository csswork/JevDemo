import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {VRMLoaderPlugin,VRMUtils,type VRM,type VRMHumanBoneName} from '@pixiv/three-vrm';
import {Cloth,type Capsule,type Anchor} from './cloth';

const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;document.body.prepend(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#d9dfd7');scene.add(new THREE.HemisphereLight(0xffffff,0x78856a,2));
const light=new THREE.DirectionalLight(0xfff3df,3);light.position.set(-2,4,3);light.castShadow=true;light.shadow.mapSize.set(1024,1024);Object.assign(light.shadow.camera,{left:-2,right:2,top:2,bottom:-2,near:.1,far:10});light.shadow.normalBias=.02;scene.add(light);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0xaab8a3,roughness:.95}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const camera=new THREE.PerspectiveCamera(34,innerWidth/innerHeight,.05,100);camera.position.set(2.1,1.3,3.2);const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.92,0);controls.enableDamping=true;controls.minDistance=1;controls.maxDistance=5;controls.maxPolarAngle=Math.PI*.48;controls.update();
window.addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();});
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
let mode='idle',physics=true,collisions=true,debug=false,wind=.8,time=0,accumulator=0;
let vrm:VRM;let cloth:Cloth;let clothMesh:THREE.Mesh;let rigid:THREE.Group;let rest:Float32Array;let anchorIds:number[];let mapping:number[];let baseHip:THREE.Vector3;let hip:THREE.Object3D;
const original:THREE.Mesh[]=[];const clothing:THREE.Mesh[]=[];const proxies:THREE.Mesh[]=[];const overlay=new THREE.Group();scene.add(overlay);const tmp=new THREE.Vector3(),hipMatrix=new THREE.Matrix4();
const loader=new GLTFLoader();loader.register(p=>new VRMLoaderPlugin(p));
const caps:Capsule[]=[];const anchors:Anchor[]=[];
function bone(name:VRMHumanBoneName){return vrm.humanoid.getNormalizedBoneNode(name)!;}
function pose(){
 vrm.humanoid.resetNormalizedPose();bone('hips').position.copy(baseHip);
 bone('leftUpperArm').rotation.z=1.25;bone('rightUpperArm').rotation.z=-1.25;
 bone('leftLowerArm').rotation.y=-.08;bone('rightLowerArm').rotation.y=.08;
 const wave=Math.sin(time*3.4);
 if(mode==='walk'){bone('leftUpperLeg').rotation.x=wave*.42;bone('rightUpperLeg').rotation.x=-wave*.42;bone('leftLowerLeg').rotation.x=-Math.max(0,wave)*.55;bone('rightLowerLeg').rotation.x=-Math.max(0,-wave)*.55;bone('hips').position.y+=Math.abs(wave)*.012;bone('leftUpperArm').rotation.x=-wave*.15;bone('rightUpperArm').rotation.x=wave*.15;}
 if(mode==='squat'||mode==='squatHold'){const t=mode==='squatHold'?1:(1-Math.cos(time*1.8))*.5;bone('hips').position.y-=t*.27;for(const side of ['left','right'] as const){bone(`${side}UpperLeg`).rotation.x=t*1.05;bone(`${side}LowerLeg`).rotation.x=-t*1.8;bone(`${side}Foot`).rotation.x=t*.6;}bone('spine').rotation.x=-t*.18;}
 vrm.scene.rotation.y=Math.PI+(mode==='turn'?Math.sin(time*1.2)*1.9:0);
 vrm.expressionManager?.setValue('blink',Math.pow(Math.max(0,Math.cos(time*1.2)),45));
 vrm.update(1/60);vrm.scene.updateMatrixWorld(true);hipMatrix.copy(hip.matrixWorld);
 rigid.position.setFromMatrixPosition(hipMatrix);rigid.quaternion.setFromRotationMatrix(hipMatrix);
}
function point(name:VRMHumanBoneName):[number,number,number]{vrm.humanoid.getRawBoneNode(name)!.getWorldPosition(tmp);return [tmp.x,tmp.y,tmp.z];}
function updateCapsules(){
 caps.length=0;
 for(const side of ['left','right'] as const){const a=point(`${side}UpperLeg`),b=point(`${side}LowerLeg`),c=point(`${side}Foot`);caps.push({a,b,radius:.066},{a:b,b:c,radius:.05});}
 const a=point('leftUpperLeg'),b=point('rightUpperLeg');a[1]+=.025;b[1]+=.025;caps.push({a,b,radius:.062});
 if(debug)proxies.forEach((mesh,i)=>{const c=caps[i];const a=new THREE.Vector3(...c.a),b=new THREE.Vector3(...c.b),d=b.clone().sub(a);mesh.position.copy(a).add(b).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.clone().normalize());mesh.geometry.dispose();mesh.geometry=new THREE.CapsuleGeometry(c.radius,d.length(),6,12);mesh.scale.set(1,1,1);});overlay.visible=debug&&collisions;
}
function worldRest(){
 const p=rest.slice(),inverse=new THREE.Quaternion().setFromRotationMatrix(hipMatrix).invert();
 const rotations=(['left','right'] as const).map(side=>{const a=new THREE.Vector3(...point(`${side}UpperLeg`)),b=new THREE.Vector3(...point(`${side}LowerLeg`));const direction=b.sub(a).normalize().applyQuaternion(inverse);return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,-1,0),direction);});
 const rotated=new THREE.Vector3();
 for(let i=0;i<p.length;i+=3){tmp.set(rest[i],rest[i+1],rest[i+2]);const blend=THREE.MathUtils.smoothstep(.034-rest[i+1],0,.23);rotated.copy(tmp).applyQuaternion(rotations[rest[i]<0?0:1]);tmp.lerp(rotated,blend*.9).applyMatrix4(hipMatrix);p[i]=tmp.x;p[i+1]=tmp.y;p[i+2]=tmp.z;}return p;
}
function updateAnchors(){anchors.length=0;for(const index of anchorIds){tmp.set(rest[index*3],rest[index*3+1],rest[index*3+2]).applyMatrix4(hipMatrix);anchors.push({index,x:tmp.x,y:tmp.y,z:tmp.z});}}
function reset(){if(!cloth)return;cloth.reset(worldRest());accumulator=0;}
async function init(){
 const gltf=await loader.loadAsync('/models/AvatarSample_A.vrm');vrm=gltf.userData.vrm;VRMUtils.rotateVRM0(vrm);scene.add(vrm.scene);
 vrm.scene.traverse(o=>{if(!(o instanceof THREE.Mesh))return;o.frustumCulled=false;o.castShadow=true;const mats=Array.isArray(o.material)?o.material:[o.material];if(mats.some(m=>/_(Tops|Bottoms|Shoes)_/.test(m.name)))clothing.push(o);if(mats.some(m=>m.name.includes('_Bottoms_'))){original.push(o);o.visible=false;}});
 if(!original.length)throw new Error('Original skirt primitive was not found');
 baseHip=bone('hips').position.clone();hip=vrm.humanoid.getRawBoneNode('hips')!;
 const asset=await new GLTFLoader().loadAsync('./skirt.glb');asset.scene.updateMatrixWorld(true);
 const source=asset.scene.getObjectByName('ClothPanel');if(!source)throw new Error('Missing cloth mesh');
 const panels:THREE.Mesh[]=[];source.traverse(o=>{if(o instanceof THREE.Mesh)panels.push(o);});
 const geometry=mergeGeometries(panels.map(m=>m.geometry.clone().applyMatrix4(m.matrixWorld)),true)!;const positions=geometry.getAttribute('position');mapping=[];const unique:number[]=[],lookup=new Map<string,number>();
 for(let i=0;i<positions.count;i++){const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i),key=[x,y,z].map(v=>Math.round(v*1e6)).join(':');let id=lookup.get(key);if(id===undefined){id=unique.length/3;lookup.set(key,id);unique.push(x,y,z);}mapping.push(id);}
 rest=new Float32Array(unique);anchorIds=[];for(let i=0;i<rest.length;i+=3)if(rest[i+1]>.034)anchorIds.push(i/3);
 const indices=geometry.index?.array??Array.from({length:positions.count},(_,i)=>i);const triangles=new Uint32Array(Array.from(indices,i=>mapping[i]));
 cloth=new Cloth(rest,anchorIds,triangles);const materials=panels.flatMap(m=>Array.isArray(m.material)?m.material:[m.material]).map(m=>{const mat=m.clone() as THREE.MeshStandardMaterial;mat.side=THREE.DoubleSide;mat.roughness=.88;mat.transparent=false;mat.depthWrite=true;mat.alphaTest=.18;mat.alphaToCoverage=true;return mat;});
 clothMesh=new THREE.Mesh(geometry,materials);clothMesh.frustumCulled=false;clothMesh.castShadow=true;clothMesh.receiveShadow=true;scene.add(clothMesh);
 source.removeFromParent();rigid=asset.scene;scene.add(rigid);
 for(let i=0;i<5;i++){const mesh=new THREE.Mesh(new THREE.CapsuleGeometry(1,1,6,12),new THREE.MeshBasicMaterial({color:0xd29347,wireframe:true,transparent:true,opacity:.55,depthTest:false}));overlay.add(mesh);proxies.push(mesh);}
 pose();updateCapsules();reset();el('load').hidden=true;requestAnimationFrame(frame);
}
let last=performance.now(),frames=0,lastStats=last,solveMs=0;
function frame(now:number){const dt=Math.min((now-last)/1000,.08);last=now;controls.update();const start=performance.now();accumulator=Math.min(accumulator+dt,4/60);let steps=0;
 while(accumulator>=1/60){time+=1/60;pose();updateCapsules();updateAnchors();if(physics)cloth.step(1/60,anchors,collisions?caps:[],wind,time,worldRest());else cloth.reset(worldRest());accumulator-=1/60;steps++;}
 solveMs+=(performance.now()-start);const position=clothMesh.geometry.getAttribute('position');for(let i=0;i<position.count;i++){const j=mapping[i]*3;position.setXYZ(i,cloth.position[j],cloth.position[j+1],cloth.position[j+2]);}position.needsUpdate=true;clothMesh.geometry.computeVertexNormals();renderer.render(scene,camera);frames++;
 if(now-lastStats>1000){el('stats').textContent=`${Math.round(frames*1000/(now-lastStats))} FPS · ${rest.length/3} 布料节点\n`;el('stats').innerText+=`CPU 动作＋求解 ${(solveMs/frames).toFixed(2)} ms/帧\n碰撞后最大侵入 ${(cloth.penetration(caps)*1000).toFixed(2)} mm\n固定 60 Hz · 8 次约束迭代`;solveMs=0;frames=0;lastStats=now;}
 requestAnimationFrame(frame);
}
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-pose]'))button.onclick=()=>{mode=button.dataset.pose!;time=0;pose();updateCapsules();for(const b of document.querySelectorAll('[data-pose]'))b.classList.toggle('active',b===button);reset();};
el<HTMLSelectElement>('outfit').onchange=e=>{const outfit=(e.target as HTMLSelectElement).value,isNew=outfit==='new',isBody=outfit==='body';for(const mesh of clothing)mesh.visible=!isBody;for(const mesh of original)mesh.visible=outfit==='original';clothMesh.visible=isNew;rigid.visible=isNew;overlay.visible=debug&&collisions&&!isBody;el('inspection-note').hidden=!isBody;reset();};
el<HTMLInputElement>('physics').onchange=e=>{physics=(e.target as HTMLInputElement).checked;reset();};el<HTMLInputElement>('collision').onchange=e=>{collisions=(e.target as HTMLInputElement).checked;reset();};el<HTMLInputElement>('debug').onchange=e=>debug=(e.target as HTMLInputElement).checked;el<HTMLInputElement>('wind').oninput=e=>wind=Number((e.target as HTMLInputElement).value);el('reset').onclick=reset;
const panel=document.querySelector('aside')!;if(innerWidth<650)panel.hidden=true;el('panel-toggle').onclick=()=>panel.hidden=!panel.hidden;
init().catch(error=>{el('load').innerText='加载失败：'+error.message;console.error(error);});
