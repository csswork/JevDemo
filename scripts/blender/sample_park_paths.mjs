// Sample the exact runtime curves for offline Blender board fitting.
import fs from 'node:fs';
import * as THREE from 'three';
const source=fs.readFileSync('src/vrm/scenes/park.ts','utf8');
const near=18.2,pitch=.14,paths=[];
for(const key of ['MAIN_PATH','BRANCH_PATH','FRONT_PATH']){
  const points=JSON.parse(source.match(new RegExp(`const ${key}: V2\\[\\] = (\\[[\\s\\S]*?\\n\\]);`))[1].replace(/,\s*]/g,']'));
  const c=new THREE.CatmullRomCurve3(points.map(([x,z])=>new THREE.Vector3(x,0,z)),false,'centripetal');
  const len=c.getLength(),boards=[];
  const edge=d=>{const p=c.getPointAt(d/len),t=c.getTangentAt(d/len);return [[p.x-t.z*1.15,-p.z-t.x*1.15],[p.x+t.z*1.15,-p.z+t.x*1.15]];};
  for(let d=0;d<near-.001;d+=pitch){const a=edge(d+.002),b=edge(d+pitch-.002);boards.push([a[0],a[1],b[1],b[0]]);}
  paths.push({name:key.toLowerCase(),boards});
}
fs.mkdirSync('design/park-timber',{recursive:true});
fs.writeFileSync('design/park-timber/layout.json',JSON.stringify({near,pitch,paths}));
