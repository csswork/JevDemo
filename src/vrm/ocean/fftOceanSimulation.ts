import * as THREE from 'three';

/*!
Packed spectral fields and butterfly layout adapted from abyssal-ocean.
MIT License

Copyright (c) 2026 Sacha (@squall01337)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export type FftResolution = 128 | 256;
export const OCEAN_TILE_LENGTHS = [192, 23] as const;
type Uniforms = Record<string, THREE.IUniform>;
const header = `precision highp float;precision highp int;
 const float PI=3.141592653589793;
 vec2 cmul(vec2 a,vec2 b){return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
`;
const vertex = `in vec3 position;void main(){gl_Position=vec4(position.xy,0.,1.);}`;
const evolution = `${header}
 uniform sampler2D initial;uniform float size,tile,time;
 layout(location=0) out vec4 field0;layout(location=1) out vec4 field1;
 void main(){ivec2 id=ivec2(gl_FragCoord.xy);vec2 k=(vec2(id)-size*.5)*(2.*PI/tile);float kl=length(k);
  if(kl<1e-6){field0=vec4(0.);field1=vec4(0.);return;}
  vec4 h0=texelFetch(initial,id,0);float omega=sqrt(9.81*kl*tanh(min(kl*25.,20.)));
  float c=cos(omega*time),s=sin(omega*time);
  // Negative temporal phase with positive spatial IDFT propagates along +k.
  vec2 h=cmul(h0.xy,vec2(c,-s))+cmul(h0.zw,vec2(c,s));vec2 kn=k/kl;
  field0=vec4(cmul(h,vec2(kn.y,-kn.x)),cmul(h,vec2(1.,k.x*k.y/kl)));
  field1=vec4(cmul(h,vec2(-k.y,k.x)),cmul(h,vec2(k.x*k.x/kl,k.y*k.y/kl)));
 }`;
const butterflyShader = `${header}
 uniform sampler2D source0,source1,butterfly;uniform int stage,axis;
 layout(location=0) out vec4 field0;layout(location=1) out vec4 field1;
 void main(){ivec2 id=ivec2(gl_FragCoord.xy);int i=axis==0?id.x:id.y;
  vec4 b=texelFetch(butterfly,ivec2(stage,i),0);
  ivec2 aIndex=axis==0?ivec2(int(b.z),id.y):ivec2(id.x,int(b.z));
  ivec2 bIndex=axis==0?ivec2(int(b.w),id.y):ivec2(id.x,int(b.w));
  vec4 a0=texelFetch(source0,aIndex,0),b0=texelFetch(source0,bIndex,0);
  vec4 a1=texelFetch(source1,aIndex,0),b1=texelFetch(source1,bIndex,0);
  field0=vec4(a0.rg+cmul(b.xy,b0.rg),a0.ba+cmul(b.xy,b0.ba));
  field1=vec4(a1.rg+cmul(b.xy,b1.rg),a1.ba+cmul(b.xy,b1.ba));
 }`;
const assemble = `${header}
 uniform sampler2D source0,source1;uniform float strength,chop;
 layout(location=0) out vec4 displacement;layout(location=1) out vec4 derivatives;
 void main(){ivec2 id=ivec2(gl_FragCoord.xy);float shift=((id.x+id.y)%2)==0?1.:-1.;
  vec4 a=texelFetch(source0,id,0)*shift*strength,b=texelFetch(source1,id,0)*shift*strength;
  float xx=b.z*chop,zz=b.w*chop,xz=a.w*chop;
  float jacobian=(1.+xx)*(1.+zz)-xz*xz;
  displacement=vec4(a.x*chop,a.z,a.y*chop,jacobian);
  derivatives=vec4(b.x,b.y,xx,zz);
 }`;
const foam = `${header}
 uniform sampler2D displacement,previousDisplacement,history;
 uniform float size,tile,dt;layout(location=0) out vec4 result;
 void main(){vec2 uv=gl_FragCoord.xy/size;vec4 d=texture(displacement,uv);
  vec2 movement=(d.xz-texture(previousDisplacement,uv).xz)/tile;
  vec2 p=uv-movement;float e=1./size;
  // Backtrace the orbital displacement. Diffusion rate is bounded by elapsed time.
  float old=texture(history,p).r;
  float neighbours=(texture(history,p+vec2(e,0.)).r+texture(history,p-vec2(e,0.)).r+
                    texture(history,p+vec2(0.,e)).r+texture(history,p-vec2(0.,e)).r)*.25;
  old=mix(old,neighbours,min(dt*2.,.12))*exp(-dt*.65);
  float injection=clamp((.82-d.w)*2.5,0.,1.);
  result=vec4(clamp(old+(1.-old)*injection*(1.-exp(-dt*12.)),0.,1.),0.,0.,1.);
 }`;

export function butterflyData(n:number){
 const stages=Math.log2(n),reversed=new Int32Array(n),data=new Float32Array(stages*n*4);
 for(let i=0;i<n;i++){let x=i,r=0;for(let bit=0;bit<stages;bit++){r=(r<<1)|(x&1);x>>=1;}reversed[i]=r;}
 for(let stage=0;stage<stages;stage++)for(let i=0;i<n;i++){
  const half=1<<stage,first=(i%(half*2))<half,k=i*(n>>(stage+1))%n;
  let a=first?i:i-half,b=first?i+half:i;
  if(stage===0){a=reversed[a];b=reversed[b];}
  const at=(i*stages+stage)*4,angle=2*Math.PI*k/n;
  data[at]=Math.cos(angle);data[at+1]=Math.sin(angle);data[at+2]=a;data[at+3]=b;
 }
 return data;
}

// CPU initialization avoids repeating the costly spectrum pass every frame.
export function spectrumData(n:number,tile:number,cascade:number,direction:THREE.Vector2,singleWave=false){
 const h=new Float32Array(n*n*2),result=new Float32Array(n*n*4),dk=2*Math.PI/tile;
 let seed=1337+cascade*157;
 const random=()=>((seed=Math.imul(seed,1664525)+1013904223)>>>0)/4294967296;
 const cut=2*Math.PI/6;
 for(let z=0;z<n;z++)for(let x=0;x<n;x++){
  const nx=x-n/2,nz=z-n/2,kx=nx*dk,kz=nz*dk,k=Math.hypot(kx,kz),at=(z*n+x)*2;
  const r=Math.sqrt(-2*Math.log(Math.max(random(),1e-8))),angle=random()*2*Math.PI;
  if(singleWave){if(nx===-1&&nz===0)h[at]=.5;continue;}
  if(k<1e-6||(cascade===0?k>=cut:k<cut))continue;
  const omega=Math.sqrt(9.81*k*Math.tanh(Math.min(k*25,20))),wind=8,fetch=30000;
  const peak=22*Math.cbrt(9.81*9.81/(wind*fetch)),alpha=.076*Math.pow(wind*wind/(fetch*9.81),.22);
  const sigma=omega<=peak?.07:.09,enhance=Math.exp(-Math.pow(omega-peak,2)/(2*sigma*sigma*peak*peak));
  const jonswap=alpha*9.81*9.81*Math.pow(omega,-5)*Math.exp(-1.25*Math.pow(peak/omega,4))*Math.pow(3.3,enhance);
  const wh=omega*Math.sqrt(25/9.81),tma=wh<1?.5*wh*wh:wh<2?1-.5*Math.pow(2-wh,2):1;
  // One-way directional energy with a soft spread around the incoming coastline direction.
  const alignment=(kx*direction.x+kz*direction.y)/k;
  const spread=3*Math.pow(Math.max(alignment,0),cascade===0?8:3);
  const kh=Math.min(k*25,20),derivative=9.81*(Math.tanh(kh)+kh/Math.pow(Math.cosh(kh),2))/(2*omega);
  const energy=.13*jonswap*tma*derivative/k*dk*dk*spread*Math.exp(-k*k*.012*.012);
  const amplitude=Math.sqrt(Math.max(energy,0));h[at]=r*Math.cos(angle)*amplitude;h[at+1]=r*Math.sin(angle)*amplitude;
 }
 for(let z=0;z<n;z++)for(let x=0;x<n;x++){
  const at=(z*n+x)*4,a=(z*n+x)*2,b=(((n-z)%n)*n+(n-x)%n)*2;
  result[at]=h[a];result[at+1]=h[a+1];result[at+2]=h[b];result[at+3]=-h[b+1];
 }
 return result;
}

export function createFftOceanSimulation(direction:THREE.Vector2,resolution:FftResolution=128,singleWave=false){
 const resources:Array<{dispose():void}>=[];
 const keep=<T extends {dispose():void}>(v:T)=>{resources.push(v);return v;};
 const geometry=keep(new THREE.PlaneGeometry(2,2)),camera=new THREE.Camera(),scene=new THREE.Scene();
 const mesh=new THREE.Mesh<THREE.BufferGeometry,THREE.Material>(geometry,keep(new THREE.MeshBasicMaterial()));mesh.frustumCulled=false;scene.add(mesh);
 const makePass=(fragmentShader:string,uniforms:Uniforms)=>keep(new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:vertex,fragmentShader,uniforms,depthTest:false,depthWrite:false}));
 const evolutionPass=makePass(evolution,{initial:{value:null},size:{value:resolution},tile:{value:0},time:{value:0}});
 const butterflyPass=makePass(butterflyShader,{source0:{value:null},source1:{value:null},butterfly:{value:null},stage:{value:0},axis:{value:0}});
 const assemblePass=makePass(assemble,{source0:{value:null},source1:{value:null},strength:{value:1},chop:{value:singleWave?0:1.2}});
 const foamPass=makePass(foam,{displacement:{value:null},previousDisplacement:{value:null},history:{value:null},size:{value:resolution},tile:{value:0},dt:{value:0}});
 const dynamicResources:Array<{dispose():void}>=[];
 const targets:THREE.WebGLRenderTarget[]=[];
 let ping:THREE.WebGLRenderTarget[]=[];
 let cascades:Array<{initial:THREE.DataTexture;result:THREE.WebGLRenderTarget[];foam:THREE.WebGLRenderTarget[]}>=[];
 let n=resolution,index=0,initialized=false,dirty=true,lastTime=-1,lastStrength=-1;
 const viewport=new THREE.Vector4(),scissor=new THREE.Vector4();
 function allocate(size:FftResolution){
  for(const r of dynamicResources)r.dispose();dynamicResources.length=0;targets.length=0;n=size;index=0;initialized=false;dirty=true;
  const own=<T extends {dispose():void}>(v:T)=>{dynamicResources.push(v);return v;};
  const target=(count:number,type:THREE.TextureDataType,smooth:boolean)=>{
   const t=own(new THREE.WebGLRenderTarget(n,n,{count,type,format:THREE.RGBAFormat,depthBuffer:false,stencilBuffer:false}));
   for(const texture of t.textures){texture.minFilter=texture.magFilter=smooth?THREE.LinearFilter:THREE.NearestFilter;
    texture.wrapS=texture.wrapT=smooth?THREE.RepeatWrapping:THREE.ClampToEdgeWrapping;texture.generateMipmaps=smooth;if(smooth)texture.minFilter=THREE.LinearMipmapLinearFilter;}
   targets.push(t);return t;
  };
  ping=[target(2,THREE.FloatType,false),target(2,THREE.FloatType,false)];
  const bf=own(new THREE.DataTexture(butterflyData(n),Math.log2(n),n,THREE.RGBAFormat,THREE.FloatType));bf.needsUpdate=true;
  butterflyPass.uniforms.butterfly.value=bf;
  cascades=OCEAN_TILE_LENGTHS.map((tile,c)=>{
   const initial=own(new THREE.DataTexture(spectrumData(n,tile,c,direction,singleWave),n,n,THREE.RGBAFormat,THREE.FloatType));initial.needsUpdate=true;
   return {initial,result:[target(2,THREE.HalfFloatType,true),target(2,THREE.HalfFloatType,true)],foam:[target(1,THREE.HalfFloatType,true),target(1,THREE.HalfFloatType,true)]};
  });
  evolutionPass.uniforms.size.value=foamPass.uniforms.size.value=n;
 }
 allocate(resolution);
 function draw(renderer:THREE.WebGLRenderer,material:THREE.RawShaderMaterial,target:THREE.WebGLRenderTarget){mesh.material=material;renderer.setRenderTarget(target);renderer.render(scene,camera);}
 return {
  get resolution(){return n;},
  get fields(){return cascades.map(c=>({displacement:c.result[index].textures[0],derivatives:c.result[index].textures[1],foam:c.foam[index].texture}));},
  get memoryBytes(){return n*n*(96+96*4/3)+Math.log2(n)*n*16;},
  get drawCalls(){return 2*(2*Math.log2(n)+3);},
  setResolution(size:FftResolution){if(size!==n)allocate(size);},
  render(renderer:THREE.WebGLRenderer,time:number,dt:number,strength:number){
   if(!dirty&&time===lastTime&&strength===lastStrength)return false;
   if(!renderer.extensions.has('EXT_color_buffer_float'))throw new Error('FFT 海洋需要浮点渲染目标支持。');
   const previous=renderer.getRenderTarget(),auto=renderer.autoClear,xr=renderer.xr.enabled,scissorTest=renderer.getScissorTest();
   renderer.getViewport(viewport);renderer.getScissor(scissor);
   try{
    renderer.autoClear=false;renderer.xr.enabled=false;renderer.setScissorTest(false);
    if(!initialized){for(const target of targets){renderer.setRenderTarget(target);renderer.clear();}initialized=true;}
    const next=1-index;
    for(let c=0;c<cascades.length;c++){
     const cascade=cascades[c],tile=OCEAN_TILE_LENGTHS[c];
     Object.assign(evolutionPass.uniforms.initial,{value:cascade.initial});evolutionPass.uniforms.tile.value=tile;evolutionPass.uniforms.time.value=time;
     draw(renderer,evolutionPass,ping[0]);let source=ping[0],dest=ping[1];
     for(let axis=0;axis<2;axis++)for(let stage=0;stage<Math.log2(n);stage++){
      butterflyPass.uniforms.source0.value=source.textures[0];butterflyPass.uniforms.source1.value=source.textures[1];
      butterflyPass.uniforms.axis.value=axis;butterflyPass.uniforms.stage.value=stage;draw(renderer,butterflyPass,dest);[source,dest]=[dest,source];
     }
     assemblePass.uniforms.source0.value=source.textures[0];assemblePass.uniforms.source1.value=source.textures[1];assemblePass.uniforms.strength.value=strength;
     draw(renderer,assemblePass,cascade.result[next]);
     foamPass.uniforms.displacement.value=cascade.result[next].textures[0];foamPass.uniforms.previousDisplacement.value=cascade.result[index].textures[0];
     foamPass.uniforms.history.value=cascade.foam[index].texture;foamPass.uniforms.tile.value=tile;foamPass.uniforms.dt.value=Math.max(0,Math.min(dt,.1));
     draw(renderer,foamPass,cascade.foam[next]);
    }
    index=next;dirty=false;lastTime=time;lastStrength=strength;return true;
   }finally{
    renderer.setRenderTarget(previous);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.autoClear=auto;renderer.xr.enabled=xr;
   }
  },
  // Readback is only used by explicit validation; never during animation.
  readHeight(renderer:THREE.WebGLRenderer,x:number,z:number){const data=new Uint16Array(4);renderer.readRenderTargetPixels(cascades[0].result[index],x,z,1,1,data);return THREE.DataUtils.fromHalfFloat(data[1]);},
  readSlope(renderer:THREE.WebGLRenderer,x:number,z:number){const data=new Uint16Array(4);renderer.readRenderTargetPixels(cascades[0].result[index],x,z,1,1,data,undefined,1);return [THREE.DataUtils.fromHalfFloat(data[0]),THREE.DataUtils.fromHalfFloat(data[1])];},
  dispose(){for(const r of dynamicResources)r.dispose();for(const r of resources)r.dispose();scene.clear();}
 };
}

export function validateFftOcean(renderer:THREE.WebGLRenderer){
 const simulation=createFftOceanSimulation(new THREE.Vector2(-1,0),128,true),errors:number[]=[],slopeErrors:number[]=[];
 const k=2*Math.PI/OCEAN_TILE_LENGTHS[0],omega=Math.sqrt(9.81*k*Math.tanh(k*25));
 try{
  let skippedPaused=true;
  for(const resolution of [128,256] as const){simulation.setResolution(resolution);
  for(const time of [0,.35]){
   simulation.render(renderer,time,.016,1);
   for(const x of [0,11,37,64,93]){const actual=simulation.readHeight(renderer,x,32),expected=Math.cos(-2*Math.PI*x/resolution-omega*time);errors.push(Math.abs(actual-expected));const slope=simulation.readSlope(renderer,x,32);slopeErrors.push(Math.abs(slope[0]-k*Math.sin(-2*Math.PI*x/resolution-omega*time)),Math.abs(slope[1]));}
  }
   skippedPaused=skippedPaused&&!simulation.render(renderer,.35,0,1);
  }
  simulation.render(renderer,.35,.016,0);const zeroHeight=simulation.readHeight(renderer,11,32);
  if(!skippedPaused||zeroHeight!==0)throw new Error('FFT 暂停/零波浪验证失败');
  const maxError=Math.max(...errors);if(!Number.isFinite(maxError)||maxError>.002)throw new Error(`FFT 数值验证失败：${maxError}`);
  const maxSlopeError=Math.max(...slopeErrors);if(!Number.isFinite(maxSlopeError)||maxSlopeError>.0001)throw new Error('FFT 坡度验证失败：'+maxSlopeError);
  return {passed:true,maxHeightError:maxError,maxSlopeError,samples:errors.length,resolutions:[128,256],skippedPaused,zeroHeight,propagation:'toward -X (shore)'};
 }finally{simulation.dispose();}
}
