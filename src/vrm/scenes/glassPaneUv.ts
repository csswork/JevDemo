import * as THREE from 'three';

/** Window-local UVs from connected pane triangles. Blender's regular UVs are
 * in metres; using them as 0..1 made curtains and glass-edge shading repeat. */
export function glassPaneUv(geometry: THREE.BufferGeometry): Float32Array {
  const pos = geometry.attributes.position, uv = geometry.attributes.uv, idx = geometry.index;
  const parent = Int32Array.from({ length: pos.count }, (_,i)=>i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const count = idx?.count ?? pos.count;
  for (let k=0;k<count;k+=3) {
    const a=idx?idx.getX(k):k, b=idx?idx.getX(k+1):k+1, c=idx?idx.getX(k+2):k+2;
    parent[root(b)]=root(a); parent[root(c)]=root(a);
  }
  const bounds = new Map<number,number[]>();
  for (let i=0;i<pos.count;i++) {
    const key=root(i), u=uv?.getX(i)??pos.getX(i), v=pos.getY(i);
    const b=bounds.get(key);
    if(b){b[0]=Math.min(b[0],u);b[1]=Math.min(b[1],v);b[2]=Math.max(b[2],u);b[3]=Math.max(b[3],v);}
    else bounds.set(key,[u,v,u,v]);
  }
  const out = new Float32Array(pos.count*2);
  for(let i=0;i<pos.count;i++){
    const b=bounds.get(root(i))!;
    out[i*2]=((uv?.getX(i)??pos.getX(i))-b[0])/Math.max(1e-5,b[2]-b[0]);
    out[i*2+1]=(pos.getY(i)-b[1])/Math.max(1e-5,b[3]-b[1]);
  }
  return out;
}
