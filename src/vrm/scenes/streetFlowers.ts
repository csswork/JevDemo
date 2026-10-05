import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { windDepth, windShader, type Wind } from './foliage';

type Keep = <T extends { dispose():void }>(resource:T)=>T;
export interface FlowerSpot { matrix:THREE.Matrix4; type:number }

/** Existing ez-tree flowers, normalized to one metre and one material per species.
 * Bake their material colors/maps into vertex colors + a small atlas rather than
 * multiplying six or seven material draws by every individual flower pot.
 */
export function loadStreetFlowers(options:{
  keep:Keep; wind:Wind; spots:FlowerSpot[]; alive:()=>boolean;
  batch:(geometry:THREE.BufferGeometry,material:THREE.Material,matrices:THREE.Matrix4[],depth:THREE.MeshDepthMaterial)=>void;
}) {
  const {keep,wind,spots,alive,batch}=options;
  ['flower_white','flower_blue','flower_yellow'].forEach((name,type)=>{
    const matrices=spots.filter(spot=>spot.type===type).map(spot=>spot.matrix);
    if(!matrices.length)return;
    new GLTFLoader().load(`/scene/eztree/${name}.glb`,gltf=>{
      gltf.scene.updateMatrixWorld(true);
      const meshes:THREE.Mesh[]=[];
      const resources=new Set<THREE.Material|THREE.Texture|THREE.BufferGeometry>();
      gltf.scene.traverse(object=>{
        const mesh=object as THREE.Mesh;
        if(!mesh.isMesh)return;
        meshes.push(mesh);resources.add(mesh.geometry);
        for(const mat of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
          resources.add(mat);
          for(const value of Object.values(mat))if(value instanceof THREE.Texture)resources.add(value);
        }
      });
      // An async import can finish after the user has switched scenes.
      if(!alive()){for(const resource of resources)resource.dispose();return;}
      for(const resource of resources)keep(resource);
      const bounds=new THREE.Box3().setFromObject(gltf.scene);
      const height=Math.max(.001,bounds.max.y-bounds.min.y);
      const center=bounds.getCenter(new THREE.Vector3());
      const atlas=document.createElement('canvas');atlas.width=atlas.height=512;
      const context=atlas.getContext('2d')!;
      context.fillStyle='white';context.fillRect(0,0,512,512);
      const tiles=new Map<THREE.Texture,number>();
      const parts:THREE.BufferGeometry[]=[];
      for(const mesh of meshes){
        // GLTFLoader splits this library's material primitives into separate meshes.
        if(Array.isArray(mesh.material))continue;
        const source=mesh.material as THREE.MeshStandardMaterial;
        let tile=0;
        if(source.map){
          if(!tiles.has(source.map)){
            tile=tiles.size+1;tiles.set(source.map,tile);
            const x=(tile%4)*128,y=Math.floor(tile/4)*128;
            // Two pixel gutters, including duplicated border texels, protect mip edges.
            const image=source.map.image as CanvasImageSource;
            context.drawImage(image,x+2,y+2,124,124);
            context.drawImage(atlas,x+2,y+2,124,1,x+2,y,124,2);
            context.drawImage(atlas,x+2,y+125,124,1,x+2,y+126,124,2);
            context.drawImage(atlas,x+2,y,1,128,x,y,2,128);
            context.drawImage(atlas,x+125,y,1,128,x+126,y,2,128);
          }else tile=tiles.get(source.map)!;
        }
        const part=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();
        part.applyMatrix4(mesh.matrixWorld);
        part.translate(-center.x,-bounds.min.y,-center.z);part.scale(1/height,1/height,1/height);
        const count=part.attributes.position.count;
        const uv=part.attributes.uv;
        const colors=new Float32Array(count*3),coords=new Float32Array(count*2);
        const original=part.attributes.color;
        for(let i=0;i<count;i++){
          colors[i*3]=source.color.r*(original?.getX(i)??1);
          colors[i*3+1]=source.color.g*(original?.getY(i)??1);
          colors[i*3+2]=source.color.b*(original?.getZ(i)??1);
          coords[i*2]=((tile%4)*128+2+(uv?.getX(i)??.5)*124)/512;
          coords[i*2+1]=(Math.floor(tile/4)*128+2+(uv?.getY(i)??.5)*124)/512;
        }
        for(const attribute of Object.keys(part.attributes))if(!['position','normal'].includes(attribute))part.deleteAttribute(attribute);
        part.setAttribute('color',new THREE.BufferAttribute(colors,3));
        part.setAttribute('uv',new THREE.BufferAttribute(coords,2));
        parts.push(part);
      }
      const geometry=mergeGeometries(parts);
      for(const part of parts)part.dispose();
      if(!geometry)return;
      const map=keep(new THREE.CanvasTexture(atlas));map.flipY=false;map.colorSpace=THREE.SRGBColorSpace;
      const material=keep(new THREE.MeshStandardMaterial({
        map,vertexColors:true,roughness:.85,side:THREE.DoubleSide,alphaTest:.35,alphaToCoverage:true,
      }));
      windShader(material,wind,1,.014);
      batch(keep(geometry),material,matrices,keep(windDepth(wind,1,.014)));
    },undefined,error=>console.warn(`Flower asset ${name} failed to load`,error));
  });
}
