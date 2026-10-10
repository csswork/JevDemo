export interface Capsule {a:[number,number,number];b:[number,number,number];radius:number;}
export interface Anchor {index:number;x:number;y:number;z:number;}
/** Fixed-step position-based cloth. Constraints share the authored rest lengths. */
export class Cloth {
 readonly position:Float32Array;private previous:Float32Array;private edges:Array<[number,number,number,number]>=[];
 readonly fixed:Set<number>;contacts=0;maxPenetration=0;
 constructor(rest:Float32Array,anchors:number[],triangles:Uint32Array){
  this.position=rest.slice();this.previous=rest.slice();this.fixed=new Set(anchors);
  const pairs=new Set<string>();const adjacency=new Map<string,number[]>();
  const add=(a:number,b:number,stiffness:number)=>{if(a>b)[a,b]=[b,a];const key=a+':'+b;if(pairs.has(key))return;pairs.add(key);const dx=rest[a*3]-rest[b*3],dy=rest[a*3+1]-rest[b*3+1],dz=rest[a*3+2]-rest[b*3+2];this.edges.push([a,b,Math.hypot(dx,dy,dz),stiffness]);};
  for(let t=0;t<triangles.length;t+=3){const ids=[triangles[t],triangles[t+1],triangles[t+2]];for(let k=0;k<3;k++){const a=ids[k],b=ids[(k+1)%3],c=ids[(k+2)%3];add(a,b,1);const key=Math.min(a,b)+':'+Math.max(a,b);const adjacent=adjacency.get(key)??[];adjacent.push(c);adjacency.set(key,adjacent);}}
  for(const adjacent of adjacency.values())if(adjacent.length===2)add(adjacent[0],adjacent[1],.22);
 }
 reset(rest:Float32Array){this.position.set(rest);this.previous.set(rest);}
 step(dt:number,anchors:Anchor[],capsules:Capsule[],wind:number,time:number,shape?:Float32Array){
  const p=this.position,old=this.previous;this.contacts=0;this.maxPenetration=0;
  for(let i=0;i<p.length;i+=3){if(this.fixed.has(i/3))continue;const x=p[i],y=p[i+1],z=p[i+2];p[i]+=(x-old[i])*.985+Math.sin(time*.8+y*2.5)*wind*.5*dt*dt;p[i+1]+=(y-old[i+1])*.985-9.81*dt*dt;p[i+2]+=(z-old[i+2])*.985+Math.cos(time*.65+x*2)*wind*dt*dt;old[i]=x;old[i+1]=y;old[i+2]=z;}
  for(let iteration=0;iteration<8;iteration++){
   for(const [a,b,length,stiffness] of this.edges){const ia=a*3,ib=b*3;const dx=p[ib]-p[ia],dy=p[ib+1]-p[ia+1],dz=p[ib+2]-p[ia+2],d=Math.hypot(dx,dy,dz);if(d<1e-9)continue;const wa=this.fixed.has(a)?0:1,wb=this.fixed.has(b)?0:1;if(!wa&&!wb)continue;const f=(d-length)/d*stiffness/(wa+wb);p[ia]+=dx*f*wa;p[ia+1]+=dy*f*wa;p[ia+2]+=dz*f*wa;p[ib]-=dx*f*wb;p[ib+1]-=dy*f*wb;p[ib+2]-=dz*f*wb;}
   // Weak animated bending reference keeps deep poses from inverting the cloth.
   if(shape)for(let i=0;i<p.length;i+=3){if(this.fixed.has(i/3))continue;for(let k=0;k<3;k++)p[i+k]+=(shape[i+k]-p[i+k])*.025;}
   for(const a of anchors){const i=a.index*3;p[i]=a.x;p[i+1]=a.y;p[i+2]=a.z;old[i]=a.x;old[i+1]=a.y;old[i+2]=a.z;}
   this.collide(capsules,iteration===7);
  }
 }
 private collide(capsules:Capsule[],measure:boolean){
  const p=this.position;
  for(let i=0;i<p.length;i+=3){if(this.fixed.has(i/3))continue;
   for(const c of capsules){const dx=c.b[0]-c.a[0],dy=c.b[1]-c.a[1],dz=c.b[2]-c.a[2];const den=dx*dx+dy*dy+dz*dz;const t=den>1e-10?Math.max(0,Math.min(1,((p[i]-c.a[0])*dx+(p[i+1]-c.a[1])*dy+(p[i+2]-c.a[2])*dz)/den)):0;const x=c.a[0]+t*dx,y=c.a[1]+t*dy,z=c.a[2]+t*dz;let nx=p[i]-x,ny=p[i+1]-y,nz=p[i+2]-z;const d=Math.hypot(nx,ny,nz);if(d>=c.radius)continue;if(measure){this.contacts++;this.maxPenetration=Math.max(this.maxPenetration,c.radius-d);}if(d<1e-7){nx=1;ny=0;nz=0;}else{nx/=d;ny/=d;nz/=d;}p[i]=x+nx*c.radius;p[i+1]=y+ny*c.radius;p[i+2]=z+nz*c.radius;}
   if(p[i+1]<.012){p[i+1]=.012;this.previous[i+1]=.012;}
  }
 }
 /** Diagnostic after projection, not the pre-solve overlap. */
 penetration(capsules:Capsule[]){let max=0;for(let i=0;i<this.position.length;i+=3){if(this.fixed.has(i/3))continue;const p=this.position;for(const c of capsules){const dx=c.b[0]-c.a[0],dy=c.b[1]-c.a[1],dz=c.b[2]-c.a[2];const den=dx*dx+dy*dy+dz*dz;const t=den>1e-10?Math.max(0,Math.min(1,((p[i]-c.a[0])*dx+(p[i+1]-c.a[1])*dy+(p[i+2]-c.a[2])*dz)/den)):0;max=Math.max(max,c.radius-Math.hypot(p[i]-c.a[0]-t*dx,p[i+1]-c.a[1]-t*dy,p[i+2]-c.a[2]-t*dz));}}return Math.max(0,max);}
}
