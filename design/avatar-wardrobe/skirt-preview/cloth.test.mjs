import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Cloth} from './cloth.ts';
import fs from 'node:fs';
const bytes=fs.readFileSync(new URL('./skirt.glb',import.meta.url));
const jsonLength=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+jsonLength).toString()),bin=20+jsonLength+8;
function read(id){const a=gltf.accessors[id],v=gltf.bufferViews[a.bufferView],offset=bin+(v.byteOffset??0)+(a.byteOffset??0),types={5126:Float32Array,5123:Uint16Array,5125:Uint32Array},n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];const T=types[a.componentType];return new T(bytes.buffer.slice(bytes.byteOffset+offset,bytes.byteOffset+offset+a.count*n*T.BYTES_PER_ELEMENT));}
const primitive=gltf.meshes.find(m=>m.name==='LaceCloth').primitives[0],raw=read(primitive.attributes.POSITION),lookup=new Map(),map=[],unique=[];
for(let i=0;i<raw.length;i+=3){const key=Array.from(raw.slice(i,i+3),v=>Math.round(v*1e6)).join(':');let id=lookup.get(key);if(id===undefined){id=unique.length/3;lookup.set(key,id);unique.push(...raw.slice(i,i+3));}map.push(id);}
const rest=new Float32Array(unique),triangles=new Uint32Array(Array.from(read(primitive.indices),i=>map[i]));const fixed=[];for(let i=0;i<rest.length;i+=3)if(rest[i+1]>.034)fixed.push(i/3);
test('actual lace garment stays finite and collides with a moving leg without moving waist anchors',()=>{
 const sim=new Cloth(rest,fixed,triangles);const world=rest.slice();for(let i=1;i<world.length;i+=3)world[i]+=.896;sim.reset(world);
 let contacts=0;
 for(let frame=0;frame<180;frame++){
  const phase=frame/60,shift=Math.sin(phase*2)*.025;
  const anchors=fixed.map(index=>({index,x:rest[index*3]+shift,y:rest[index*3+1]+.896,z:rest[index*3+2]}));
  const capsule={a:[.065+shift,.86,0],b:[.065+shift,.50,Math.sin(phase)*.07],radius:.066};
  sim.step(1/60,anchors,[capsule],.8,phase);contacts+=sim.contacts;
  assert.ok(sim.position.every(Number.isFinite));assert.ok(sim.penetration([capsule])<.00001);
  for(const a of anchors){assert.ok(Math.abs(sim.position[a.index*3]-a.x)<1e-6);assert.ok(Math.abs(sim.position[a.index*3+1]-a.y)<1e-6);}
 }
 assert.ok(contacts>0,'collision must actually be exercised');
 assert.equal(rest.length/3,1040);assert.ok(sim.position.every(v=>Math.abs(v)<2));
});
