import * as THREE from 'three';
import {createPalette,samplePalette,morningTint} from '../../src/vrm/scenes/streetTime';
import type {TimeState} from '../../src/vrm/timeOfDay';

export interface OceanOptions {
 y:number;
 shore:{map:THREE.Texture;bounds:THREE.Vector4;max:number};
 breakwater:THREE.Vector4;
 reflectionLayer?:number;
 /** Coast location used to choose a stable incoming direction; defaults to the origin. */
 shoreAnchor?:THREE.Vector2;
 waveDirection?:THREE.Vector2;
}
export interface OceanParameters {waves:number;roughness:number;foam:number;reflection:number;glitter:number;}
// Distance increases offshore, so its negative gradient is the incoming wave direction.
function incomingWaveDirection(options:OceanOptions){
 if(options.waveDirection&&options.waveDirection.lengthSq()>1e-6)return options.waveDirection.clone().normalize();
 const image=options.shore.map.image as {data?:Uint8Array;width:number;height:number};
 const incoming=new THREE.Vector2();
 if(image?.data&&options.shore.map.format===THREE.RedFormat){
  const {data,width,height}=image,b=options.shore.bounds,anchor=options.shoreAnchor??new THREE.Vector2();
  const dx=1/(b.z*width),dz=1/(b.w*height);
  for(let z=1;z<height-1;z++)for(let x=1;x<width-1;x++){
   const index=z*width+x,d=data[index]/255*options.shore.max;if(d<2||d>14)continue;
   const gx=(data[index+1]-data[index-1])/dx,gz=(data[index+width]-data[index-width])/dz;
   const length=Math.hypot(gx,gz);if(length<1e-5)continue;
   const px=b.x+(x+.5)*dx-anchor.x,pz=b.y+(z+.5)*dz-anchor.y;
   const weight=Math.exp(-(px*px+pz*pz)/(80*80));incoming.x-=gx/length*weight;incoming.y-=gz/length*weight;
  }
 }
 return incoming.lengthSq()>1e-6?incoming.normalize():incoming.set(-1,0);
}
// A separate periodic foam atlas: soft breakup in R, cellular bubble rims in G.
let cachedFoam:Uint8Array|undefined;
function foamTexture(){
 const n=256;
 if(!cachedFoam){
  const hash=(x:number,y:number,c:number)=>{let v=Math.imul(x,374761393)^Math.imul(y,668265263)^c;v=Math.imul(v^(v>>>13),1274126177);return((v^(v>>>16))>>>0)/4294967296;};
  const noise=(x:number,y:number,period:number)=>{const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);const h=(a:number,b:number)=>hash((a+period)%period,(b+period)%period,971);return THREE.MathUtils.lerp(THREE.MathUtils.lerp(h(ix,iy),h(ix+1,iy),u),THREE.MathUtils.lerp(h(ix,iy+1),h(ix+1,iy+1),u),v);};
  cachedFoam=new Uint8Array(n*n*4);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
   const u=x/n,v=y/n,broad=noise(u*8,v*8,8)*.55+noise(u*16,v*16,16)*.3+noise(u*32,v*32,32)*.15;
   const px=u*32,py=v*32,ix=Math.floor(px),iy=Math.floor(py);let d=10;
   for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const cx=ix+ox,cy=iy+oy,hx=(cx+32)%32,hy=(cy+32)%32;d=Math.min(d,Math.hypot(px-cx-.15-.7*hash(hx,hy,124),py-cy-.15-.7*hash(hx,hy,775)));}
   const rim=1-THREE.MathUtils.smoothstep(Math.abs(d-.27),.035,.13),i=(x+y*n)*4;
   cachedFoam[i]=Math.round(broad*255);cachedFoam[i+1]=Math.round(rim*255);cachedFoam[i+2]=0;cachedFoam[i+3]=255;
  }
 }
 const texture=new THREE.DataTexture(cachedFoam,n,n,THREE.RGBAFormat);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=true;texture.anisotropy=4;texture.needsUpdate=true;return texture;
}
// Shared analytic waves keep per-pixel normals independent of the tessellation.
const waveFunctions=`
 void wave(vec2 p,vec2 dir,float wavelength,float a,float speed,inout float h,inout vec2 slope){
  float k=6.2831853/wavelength,phase=dot(p,dir)*k-oceanTime*speed;
  h+=a*sin(phase);slope+=dir*k*a*cos(phase);
 }
 void surface(vec2 p,out float h,out vec2 slope){h=0.;slope=vec2(0.);
  wave(p,wind,43.,.45,.72,h,slope);
  wave(p,mat2(.94,-.342,.342,.94)*wind,25.,.24,1.08,h,slope);
  wave(p,mat2(.883,.469,-.469,.883)*wind,17.,.105,1.52,h,slope);
  wave(p,mat2(.990,-.139,.139,.990)*wind,12.,.045,2.0,h,slope);
 }
`;
const vertex=`
 uniform float oceanTime,waveAmount,waterY,nearPatch;uniform vec2 patchCenter,wind;
 varying vec3 vWorld;varying vec2 vSlope;varying float vCrest;
 #include <fog_pars_vertex>
 ${waveFunctions}
 void main(){vec4 wp=modelMatrix*vec4(position,1.);vec2 p=wp.xz;float h;vec2 slope;surface(p,h,slope);
   float edge=1.-smoothstep(105.,127.,max(abs(p.x-patchCenter.x),abs(p.y-patchCenter.y)));
   float amount=waveAmount*nearPatch*edge;wp.y=waterY+h*amount;
   vSlope=slope*nearPatch*edge;vCrest=h*amount;vWorld=wp.xyz;
   vec4 mvPosition=viewMatrix*wp;gl_Position=projectionMatrix*mvPosition;
   #include <fog_vertex>
 }`;
const fragment=`
 uniform sampler2D foamAtlas,reflectionMap,shoreMap;uniform mat4 reflectionMatrix;
 uniform vec4 shoreBounds,breakwater;uniform float shoreMax,oceanTime,waveAmount,roughness,foamAmount,reflectionAmount,nearPatch,night,glitterAmount;
 uniform vec2 patchCenter,wind,reflectionTexel,rippleTravel;uniform vec3 deepColor,shallowColor,scatterColor,lightDirection,lightColor,skyColor,foamColor;
 varying vec3 vWorld;varying vec2 vSlope;varying float vCrest;
 #include <common>
 #include <fog_pars_fragment>
 ${waveFunctions}
 float segmentDistance(vec2 p,vec2 a,vec2 b){vec2 ab=b-a;return length(p-a-ab*clamp(dot(p-a,ab)/max(dot(ab,ab),.001),0.,1.));}
 // Incommensurate short waves, gently stretched by the parent swell height field.
 // The phase gradient includes that deformation, so all shading uses the same slope.
 void shortWave(vec2 p,vec2 dir,float wavelength,float amplitude,float speed,float offset,float swell,vec2 swellSlope,inout vec2 slope,inout float variance){
  float k=6.2831853/wavelength;
  float phase=dot(p,dir)*k-oceanTime*speed+offset+swell*1.8;
  vec2 gradient=dir*k+swellSlope*1.8;
  float filtered=1.-smoothstep(.6,3.14,fwidth(phase));
  slope+=gradient*amplitude*cos(phase)*filtered;
  variance+=.5*dot(gradient,gradient)*amplitude*amplitude*(1.-filtered*filtered);
 }
 void smallWaves(vec2 p,float swell,vec2 swellSlope,out vec2 slope,out float variance){slope=vec2(0.);variance=0.;
  vec2 a=wind,b=mat2(.94,-.342,.342,.94)*wind;
  vec2 c=mat2(.883,.469,-.469,.883)*wind,d=mat2(.990,-.139,.139,.990)*wind;
  shortWave(p,a,2.37,.042,5.10,.7,swell,swellSlope,slope,variance);
  shortWave(p,b,1.61,.033,6.19,2.1,swell,swellSlope,slope,variance);
  shortWave(p,c,.97,.020,7.97,4.4,swell,swellSlope,slope,variance);
  shortWave(p,d,.73,.016,9.19,1.3,swell,swellSlope,slope,variance);
  shortWave(p,normalize(a+vec2(.13,-.27)),.51,.010,10.99,3.8,swell,swellSlope,slope,variance);
  shortWave(p,normalize(b+vec2(-.26,-.13)),.37,.007,12.91,5.2,swell,swellSlope,slope,variance);
  shortWave(p,mat2(.86,-.51,.51,.86)*a,1.13,.014,7.39,2.7,swell,swellSlope,slope,variance);
  shortWave(p,mat2(.80,.60,-.60,.80)*b,.63,.009,9.89,5.8,swell,swellSlope,slope,variance);
 }
 void main(){
  vec2 delta=abs(vWorld.xz-patchCenter);if(nearPatch<.5&&max(delta.x,delta.y)<127.)discard;
  vec3 V=normalize(cameraPosition-vWorld);float distanceToEye=length(cameraPosition-vWorld);
  vec2 travel=rippleTravel;
  float height;vec2 macroSlope;surface(vWorld.xz,height,macroSlope);
  vec2 smallSlope;float unresolvedVariance;smallWaves(vWorld.xz,height,macroSlope,smallSlope,unresolvedVariance);
  // One surface normal drives Fresnel, reflected-image distortion AND sun/moon highlights.
  vec2 slope=(macroSlope+smallSlope)*waveAmount;
  vec3 N=normalize(vec3(-slope.x,1.,-slope.y));float nv=max(dot(N,V),.001);
  float fresnel=.0204+.9796*pow(1.-nv,5.);
  vec4 project=reflectionMatrix*vec4(vWorld,1.);vec2 uv=project.xy/max(project.w,.001);
  uv+=slope*vec2(.025,.045)*mix(1.,.3,smoothstep(20.,600.,distanceToEye));
  uv=clamp(uv,reflectionTexel*2.,1.-reflectionTexel*2.);
  vec2 blur=reflectionTexel*(1.+roughness*7.);
  float lod=roughness*4.;
  vec3 reflected=textureLod(reflectionMap,uv,lod).rgb*.4;
  reflected+=(textureLod(reflectionMap,uv+vec2(blur.x,0.),lod).rgb+textureLod(reflectionMap,uv-vec2(blur.x,0.),lod).rgb+textureLod(reflectionMap,uv+vec2(0.,blur.y),lod).rgb+textureLod(reflectionMap,uv-vec2(0.,blur.y),lod).rgb)*.15;
  vec2 suv=(vWorld.xz-shoreBounds.xy)*shoreBounds.zw;
  float shore=shoreMax;if(all(greaterThanEqual(suv,vec2(0.)))&&all(lessThanEqual(suv,vec2(1.))))shore=texture2D(shoreMap,suv).r*shoreMax;
  float depth=1.2+shore*.26;
  // Beer-Lambert approximation using coastline depth; no invented screen-space seabed.
  vec3 transmittance=exp(-vec3(.30,.10,.06)*depth);
  vec3 body=deepColor+(shallowColor-deepColor)*transmittance;
  float scatter=pow(max(dot(V,-lightDirection)*.5+.5,0.),3.)*max(vCrest+.1,0.);
  body+=scatterColor*scatter*.17;body+=skyColor*.025;
  vec3 color=mix(body,reflected,clamp(fresnel*reflectionAmount,0.,.92));
  vec3 L=normalize(lightDirection),H=normalize(L+V);float nl=max(dot(N,L),0.),nh=max(dot(N,H),0.),vh=max(dot(V,H),0.);
  float variance=dot(fwidth(slope),fwidth(slope));
  float surfaceRoughness=.07+roughness*.45;
  float a2=max(pow(surfaceRoughness,4.)+variance*.25+unresolvedVariance*waveAmount*waveAmount,.00015);
  float den=nh*nh*(a2-1.)+1.;float D=a2/(3.14159265*den*den);
  float Gv=2.*nv/(nv+sqrt(a2+(1.-a2)*nv*nv)),Gl=2.*nl/(nl+sqrt(a2+(1.-a2)*nl*nl));
  float F=.0204+.9796*pow(1.-vh,5.);
  float spec=D*Gv*Gl*F/max(4.*nv,.02);
  color+=lightColor*min(spec,3.5)*glitterAmount*smoothstep(0.,.06,L.y);
  float edge=min(shore,max(0.,segmentDistance(vWorld.xz,breakwater.xy,breakwater.zw)-1.7));
  vec2 foamUV=vWorld.xz/5.-travel*.002;
  vec2 foamTex=texture2D(foamAtlas,foamUV).rg;
  float breakup=texture2D(foamAtlas,mat2(.8,-.6,.6,.8)*vWorld.xz/23.+travel*.001).r;
  float phase=oceanTime*.42;
  float reach=.65+(.5+.5*sin(phase))*1.5;
  float front=edge-reach-(breakup-.5)*.65;
  float aa=max(fwidth(front),.045);
  float ribbon=1.-smoothstep(.09,.28+aa,abs(front));
  // Thin advancing front plus a diffuse, broken film behind it.
  float trail=(1.-smoothstep(.1,reach+.3,edge))*(.35+.3*(.5+.5*cos(phase-1.2)));
  float maskAA=max(fwidth(foamTex.r),.025);
  float patches=smoothstep(.38-maskAA,.62+maskAA,foamTex.r);
  float shoreFoam=(ribbon*.65+trail*patches*.45)*(.35+.65*patches);
  float bubbles=mix(.82,1.,foamTex.g)*(1.-smoothstep(16.,70.,distanceToEye));
  // Wave foam needs a high crest AND a steep face; it is never a height-only white blotch.
  float crest=smoothstep(.17,.32,height*waveAmount)*smoothstep(.022,.060,length(macroSlope)*waveAmount);
  float foam=(shoreFoam+crest*patches*.12)*mix(.72,bubbles,1.-smoothstep(12.,60.,distanceToEye));
  foam*=foamAmount*(1.-smoothstep(100.,480.,distanceToEye));
  color=mix(color,foamColor,clamp(foam,0.,.8));
  gl_FragColor=vec4(color,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
 }`;

export function createOceanRenderer(options:OceanOptions){
 const resources:Array<{dispose():void}>=[];const keep=<T extends {dispose():void}>(v:T)=>{resources.push(v);return v;};
 const foamAtlas=keep(foamTexture()),shore=keep(options.shore.map.clone());shore.needsUpdate=true;
 const target=keep(new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:true}));
 target.texture.generateMipmaps=true;target.texture.minFilter=THREE.LinearMipmapLinearFilter;
 const parameters:OceanParameters={waves:.55,roughness:.28,foam:.32,reflection:.88,glitter:.6};
 const uniforms={...THREE.UniformsLib.fog,oceanTime:{value:0},waterY:{value:options.y},waveAmount:{value:parameters.waves},roughness:{value:parameters.roughness},foamAmount:{value:parameters.foam},reflectionAmount:{value:parameters.reflection},night:{value:0},glitterAmount:{value:parameters.glitter},
  nearPatch:{value:1},patchCenter:{value:new THREE.Vector2()},wind:{value:incomingWaveDirection(options)},rippleTravel:{value:new THREE.Vector2()},foamAtlas:{value:foamAtlas},shoreMap:{value:shore},shoreBounds:{value:options.shore.bounds.clone()},shoreMax:{value:options.shore.max},breakwater:{value:options.breakwater.clone()},
  reflectionMap:{value:target.texture},reflectionMatrix:{value:new THREE.Matrix4()},reflectionTexel:{value:new THREE.Vector2()},deepColor:{value:new THREE.Color()},shallowColor:{value:new THREE.Color()},scatterColor:{value:new THREE.Color()},lightDirection:{value:new THREE.Vector3()},lightColor:{value:new THREE.Color()},skyColor:{value:new THREE.Color()},foamColor:{value:new THREE.Color()}};
 const nearMaterial=keep(new THREE.ShaderMaterial({uniforms,vertexShader:vertex,fragmentShader:fragment,fog:true}));
 const farMaterial=keep(nearMaterial.clone());farMaterial.uniforms={...uniforms,nearPatch:{value:0}};
 const nearGeometry=keep(new THREE.PlaneGeometry(256,256,128,128));nearGeometry.rotateX(-Math.PI/2);
 const farGeometry=keep(new THREE.PlaneGeometry(6000,6000));farGeometry.rotateX(-Math.PI/2);
 const near=new THREE.Mesh(nearGeometry,nearMaterial),far=new THREE.Mesh(farGeometry,farMaterial);near.frustumCulled=false;far.frustumCulled=false;
 near.name='ocean-near-waves';far.name='ocean-horizon';const group=new THREE.Group();group.name='ocean-renderer';group.add(far,near);
 const mirror=new THREE.PerspectiveCamera();mirror.layers.set(options.reflectionLayer??1);
 const plane=new THREE.Plane(),normal=new THREE.Vector3(0,1,0),point=new THREE.Vector3(0,options.y,0),cameraPosition=new THREE.Vector3(),direction=new THREE.Vector3(),look=new THREE.Vector3(),clip=new THREE.Vector4(),q=new THREE.Vector4(),size=new THREE.Vector2();
 const palette=createPalette(),moonColor=new THREE.Color(.10,.14,.23),windVelocity=new THREE.Vector2(.94,.342).multiplyScalar(2);
 let reflectionScale=.5,reflecting=false,paused=false;
 function renderReflection(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.PerspectiveCamera){
  if(reflecting||!group.visible||parameters.reflection<=0)return;
  camera.updateMatrixWorld();cameraPosition.setFromMatrixPosition(camera.matrixWorld);if(cameraPosition.y<=options.y)return;
  renderer.getDrawingBufferSize(size);const w=Math.max(16,Math.min(1024,Math.ceil(size.x*reflectionScale))),h=Math.max(16,Math.min(1024,Math.ceil(size.y*reflectionScale)));
  if(target.width!==w||target.height!==h)target.setSize(w,h);uniforms.reflectionTexel.value.set(1/w,1/h);
  mirror.position.copy(cameraPosition);mirror.position.y=2*options.y-cameraPosition.y;
  camera.getWorldDirection(direction);look.copy(cameraPosition).add(direction);look.y=2*options.y-look.y;
  mirror.up.copy(camera.up);mirror.up.y*=-1;mirror.lookAt(look);mirror.far=camera.far;mirror.near=camera.near;mirror.projectionMatrix.copy(camera.projectionMatrix);mirror.updateMatrixWorld();
  uniforms.reflectionMatrix.value.set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
  plane.setFromNormalAndCoplanarPoint(normal,point).applyMatrix4(mirror.matrixWorldInverse);clip.set(plane.normal.x,plane.normal.y,plane.normal.z,plane.constant);
  const p=mirror.projectionMatrix.elements;q.set((Math.sign(clip.x)+p[8])/p[0],(Math.sign(clip.y)+p[9])/p[5],-1,(1+p[10])/p[14]);clip.multiplyScalar(2/clip.dot(q));
  p[2]=clip.x;p[6]=clip.y;p[10]=clip.z+1;p[14]=clip.w;mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
  const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear,shadow=renderer.shadowMap.autoUpdate,xr=renderer.xr.enabled;
  const wasVisible=group.visible;
  try{reflecting=true;group.visible=false;renderer.xr.enabled=false;renderer.shadowMap.autoUpdate=false;renderer.autoClear=true;renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,mirror);}
  finally{renderer.setRenderTarget(previous);renderer.autoClear=autoClear;renderer.shadowMap.autoUpdate=shadow;renderer.xr.enabled=xr;group.visible=wasVisible;reflecting=false;}
 }
 return {group,parameters,renderReflection,get reflecting(){return reflecting;},
  setParameters(values:Partial<OceanParameters>){
   if(values.waves!==undefined)parameters.waves=THREE.MathUtils.clamp(values.waves,0,1.5);
   if(values.roughness!==undefined)parameters.roughness=THREE.MathUtils.clamp(values.roughness,.08,.6);
   if(values.foam!==undefined)parameters.foam=THREE.MathUtils.clamp(values.foam,0,1);
   if(values.reflection!==undefined)parameters.reflection=THREE.MathUtils.clamp(values.reflection,0,1);
   if(values.glitter!==undefined)parameters.glitter=THREE.MathUtils.clamp(values.glitter,0,2);
   uniforms.glitterAmount.value=parameters.glitter;uniforms.waveAmount.value=parameters.waves;uniforms.roughness.value=parameters.roughness;uniforms.foamAmount.value=parameters.foam;uniforms.reflectionAmount.value=parameters.reflection;
  },
  setPaused(value:boolean){paused=value;},
  setQuality(quality:'low'|'balanced'|'high'){reflectionScale=quality==='low'?.3:quality==='high'?.75:.5;},
  setWind(degrees:number,speed:number){const angle=THREE.MathUtils.degToRad(degrees);windVelocity.set(Math.cos(angle),Math.sin(angle)).multiplyScalar(Math.max(speed,0));},
  update(state:TimeState,dt:number,camera:THREE.Camera,directions:{sun:THREE.Vector3;moon:THREE.Vector3}){
   const waveDt=paused?0:Math.max(0,dt);
   uniforms.rippleTravel.value.addScaledVector(windVelocity,waveDt*.5);
   uniforms.oceanTime.value+=waveDt;samplePalette(state.sunElev,palette);morningTint(palette,state.hours,state.sunElev);
   const night=1-THREE.MathUtils.smoothstep(state.sunElev,-8,-3);uniforms.night.value=night;
   uniforms.lightDirection.value.copy(state.sunElev>-3?directions.sun:directions.moon);
   uniforms.lightColor.value.copy(night>.5?moonColor:palette.sunCol).multiplyScalar(night>.5?1:palette.sunI);
   uniforms.deepColor.value.copy(palette.deep).multiplyScalar(.60);uniforms.shallowColor.value.copy(palette.shallow).multiplyScalar(.82);uniforms.scatterColor.value.copy(palette.scatter);uniforms.skyColor.value.copy(palette.mid);
   uniforms.foamColor.value.copy(palette.cloud).multiplyScalar(.8);
   const x=Math.round(camera.position.x/16)*16,z=Math.round(camera.position.z/16)*16;near.position.set(x,0,z);uniforms.patchCenter.value.set(x,z);
  },
  dispose(){for(const resource of resources)resource.dispose();group.clear();}
 };
}
