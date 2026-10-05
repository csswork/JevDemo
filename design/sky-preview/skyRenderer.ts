import * as THREE from 'three';
import { sunPosition, type TimeState } from '../../src/vrm/timeOfDay';
import { createPalette, samplePalette, morningTint, dirOf } from '../../src/vrm/scenes/streetTime';

// Isolated prototype. No backdrop registration, stage mutation or production imports.
const noise = `
float hash(vec3 p){p=fract(p*.3183099+vec3(.11,.23,.37));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float s=0.,a=.55;for(int i=0;i<4;i++){s+=a*noise3(p);p=p*2.03+vec3(11.7,7.3,1.9);a*=.48;}return s;}
`;
const vertex = `varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const output = `\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n`;
export function createSkyRenderer() {
  const group = new THREE.Group();
  const resources: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(v: T) => { resources.push(v); return v; };
  // A fixed tile of scalar lattice noise replaces thousands of procedural hashes per pixel.
  const size=64, data=new Uint8Array(size**3);
  const fract=(x:number)=>x-Math.floor(x);
  for(let z=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const a=fract(x*.3183099+.11)*17,b=fract(y*.3183099+.23)*17,c=fract(z*.3183099+.37)*17;
    data[x+size*(y+size*z)]=Math.round(fract(a*b*c*(a+b+c))*255);
  }
  const noiseMap=keep(new THREE.Data3DTexture(data,size,size,size));
  noiseMap.format=THREE.RedFormat;noiseMap.type=THREE.UnsignedByteType;
  noiseMap.minFilter=noiseMap.magFilter=THREE.LinearFilter;
  noiseMap.wrapS=noiseMap.wrapT=noiseMap.wrapR=THREE.RepeatWrapping;noiseMap.unpackAlignment=1;noiseMap.needsUpdate=true;
  // Calibrate the weather threshold by the distribution of the same sampled noise.
  // Percentiles turn a concentrated noise range into a useful 0..100% coverage control.
  const at=(x:number,y:number,z:number)=>data[((x%64+64)%64)+64*(((y%64+64)%64)+64*((z%64+64)%64))]/255;
  function sampleNoise(x:number,y:number,z:number){
    const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);
    const smooth=(v:number)=>v*v*(3-2*v),fx=smooth(x-ix),fy=smooth(y-iy),fz=smooth(z-iz);
    const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
    return mix(mix(mix(at(ix,iy,iz),at(ix+1,iy,iz),fx),mix(at(ix,iy+1,iz),at(ix+1,iy+1,iz),fx),fy),mix(mix(at(ix,iy,iz+1),at(ix+1,iy,iz+1),fx),mix(at(ix,iy+1,iz+1),at(ix+1,iy+1,iz+1),fx),fy),fz);
  }
  const weatherSamples:number[]=[];
  for(let z=0;z<128;z++)for(let x=0;x<128;x++){
    const sx=(x+.37)*.5,sz=(z+.61)*.5;
    let px=.8*sx+.6*sz,py=-.36*sx+.48*sz,pz=.48*sx-.64*sz,weight=.55,value=0;
    for(let octave=0;octave<4;octave++){value+=weight*sampleNoise(px,py,pz);px=px*2.03+11.7;py=py*2.03+7.3;pz=pz*2.03+1.9;weight*=.48;}
    weatherSamples.push(value);
  }
  weatherSamples.sort((a,b)=>a-b);
  const weatherThreshold=(amount:number)=>{
    if(amount<=0)return 1.1;if(amount>=1)return -.1;
    const index=(1-amount)*(weatherSamples.length-1),lo=Math.floor(index);
    return THREE.MathUtils.lerp(weatherSamples[lo],weatherSamples[Math.min(lo+1,weatherSamples.length-1)],index-lo);
  };
  const cloudNoise=`uniform highp sampler3D noiseMap;
  float hash(vec3 p){return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453);}
  float noise3(vec3 p){vec3 f=fract(p);return texture(noiseMap,(floor(p)+f*f*(3.-2.*f)+.5)/64.).r;}
  float fbm(vec3 p){float s=0.,a=.55;for(int i=0;i<4;i++){s+=a*noise3(p);p=p*2.03+vec3(11.7,7.3,1.9);a*=.48;}return s;}`;
  const palette = createPalette();
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
  const u = {
    zenith:{value:new THREE.Color()}, mid:{value:new THREE.Color()}, horizon:{value:new THREE.Color()},
    glow:{value:new THREE.Color()}, sunColor:{value:new THREE.Color()}, sunDir:{value:sunDir}, moonDir:{value:moonDir},
    noiseMap:{value:noiseMap}, windOffset:{value:new THREE.Vector2()}, steps:{value:32}, night:{value:0}, time:{value:0}, coverage:{value:.48}, weatherThreshold:{value:weatherThreshold(.48)}, cloudLight:{value:new THREE.Color()},
    cloudShade:{value:new THREE.Color()}, glowAmount:{value:0}, phase:{value:.38}, moonOn:{value:0}, cirrusCoverage:{value:0},
  };
  const dome = keep(new THREE.SphereGeometry(1000,32,20));
  const skyMat = keep(new THREE.ShaderMaterial({uniforms:u,vertexShader:vertex,side:THREE.BackSide,depthWrite:false,depthTest:false,
    fragmentShader:`varying vec3 vDir;uniform vec3 zenith,mid,horizon,glow,sunDir;uniform float night,glowAmount;${noise}
    void main(){vec3 d=normalize(vDir);float h=max(d.y,0.);vec3 c=mix(horizon,mid,smoothstep(0.,.3,h));c=mix(c,zenith,pow(h,.7));
    float toward=pow(max(dot(d,sunDir),0.),5.);c+=glow*glowAmount*toward*exp(-h*5.)*.55;
    float band=exp(-pow((d.x*.35+d.y*.55+d.z*.76-.22)*7.,2.));float dust=night>.001?fbm(d*27.):0.;c+=vec3(.014,.019,.04)*band*pow(dust,2.)*night;
    vec3 ground=mix(horizon*.18,vec3(.012,.022,.038),smoothstep(0.,.15,-d.y));c=mix(ground,c,smoothstep(-.018,.018,d.y));
    gl_FragColor=vec4(c,1.);${output}}` }));
  const sky = new THREE.Mesh(dome,skyMat); sky.renderOrder=-30; group.add(sky);

  // Stars are seeded 3D points, not camera-facing noise: a pan keeps constellations stable.
  let seed=71237; const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const positions:number[]=[], sizes:number[]=[], temperatures:number[]=[], phases:number[]=[];
  for(let i=0;i<6400;i++){const y=random()*2-1,a=random()*Math.PI*2,r=Math.sqrt(1-y*y);positions.push(r*Math.cos(a)*900,y*900,r*Math.sin(a)*900);sizes.push(1.5+Math.pow(random(),7)*2.8);temperatures.push(random());phases.push(random()*6.28);}
  const starsGeo=keep(new THREE.BufferGeometry()); starsGeo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));starsGeo.setAttribute('size',new THREE.Float32BufferAttribute(sizes,1));starsGeo.setAttribute('temp',new THREE.Float32BufferAttribute(temperatures,1));starsGeo.setAttribute('phase',new THREE.Float32BufferAttribute(phases,1));
  const starsMat=keep(new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,depthTest:false,
    vertexShader:`attribute float size,temp,phase;varying float t,p,h;void main(){t=temp;p=phase;h=normalize(position).y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_PointSize=size;}`,
    fragmentShader:`uniform float night,time;varying float t,p,h;void main(){float r=length(gl_PointCoord-.5)*2.;float a=exp(-r*r*4.)*(1.-smoothstep(.5,1.,r))*night*smoothstep(0.,.13,h)*(.88+.12*sin(time*.7+p));vec3 c=mix(vec3(.66,.79,1.),vec3(1.,.87,.69),t);gl_FragColor=vec4(c*1.4,a);${output}}` }));
  const stars=new THREE.Points(starsGeo,starsMat);stars.renderOrder=-25;group.add(stars);

  // Independent celestial discs: separate geometry, phase, halo and cloud occlusion.
  const discGeo=keep(new THREE.PlaneGeometry(1,1));
  const sunMat=keep(new THREE.ShaderMaterial({uniforms:u,transparent:true,depthTest:false,depthWrite:false,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec2 vUv;uniform vec3 glow,sunColor;void main(){float r=length(vUv-.5)*2.;float disc=1.-smoothstep(.145,.16,r);float halo=exp(-r*8.)*.35*(1.-smoothstep(.8,1.,r));gl_FragColor=vec4(mix(glow,sunColor,disc)*1.5,max(disc,halo));${output}}` }));
  const sun=new THREE.Mesh(discGeo,sunMat);sun.name='sun-disc';sun.scale.setScalar(150);sun.renderOrder=-20;group.add(sun);
  const moonMat=keep(new THREE.ShaderMaterial({uniforms:u,transparent:true,depthTest:false,depthWrite:false,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec2 vUv;uniform float phase,moonOn;${noise}
    void main(){vec2 q=(vUv-.5)*2.;float r=length(q);float disc=1.-smoothstep(.31,.33,r);vec2 xy=q/.32;float z=sqrt(max(0.,1.-dot(xy,xy)));vec3 n=vec3(xy,z);float a=phase*6.2831853;vec3 light=vec3(sin(a),.12,-cos(a));float lit=smoothstep(-.045,.075,dot(n,normalize(light)));
    float maria=fbm(vec3(xy*9.,2.));float craters=noise3(vec3(xy*37.,4.));vec3 c=vec3(.74,.81,.94)*(.68+.24*maria+.08*craters)*(lit*.95+.045);
    float halo=exp(-r*9.)*.12*(1.-smoothstep(.8,1.,r));gl_FragColor=vec4(mix(vec3(.4,.55,.82),c,disc),max(disc,halo)*moonOn);${output}}` }));
  const moon=new THREE.Mesh(discGeo,moonMat);moon.name='moon-disc';moon.scale.setScalar(70);moon.renderOrder=-20;group.add(moon);

  // High, optically thin ice-cloud layer: aligned anisotropic filaments, no volume march.
  const cirrusMat=keep(new THREE.ShaderMaterial({uniforms:u,vertexShader:vertex,side:THREE.BackSide,transparent:true,depthTest:false,depthWrite:false,
    fragmentShader:`varying vec3 vDir;uniform float cirrusCoverage,night;uniform vec2 windOffset;uniform vec3 cloudLight,cloudShade,sunDir,moonDir;${cloudNoise}
    void main(){vec3 d=normalize(vDir);if(d.y<.035||cirrusCoverage<.001)discard;
      vec2 p=d.xz/max(d.y,.035)*1.5-windOffset/1800.;
      vec2 s=vec2(dot(p,vec2(.94,.342)),dot(p,vec2(-.342,.94)));
      // Gentle, low-frequency shear keeps fibres aligned rather than curling each strand.
      s.y+=(noise3(vec3(s.x*.22,0.,17.))-.5)*.06;
      vec3 wp=vec3(s.x*1.3,s.y*3.,8.);
      float weather=fbm(wp);
      float threshold=mix(.68,.30,cirrusCoverage);
      float plume=smoothstep(threshold-.045,threshold+.045,weather);
      if(plume<.001)discard;
      float fibres=fbm(vec3(s.x*1.4,s.y*28.,13.));
      float aa=max(fwidth(fibres),.008);
      float strand=smoothstep(.34-aa,.66+aa,fibres);
      float taper=smoothstep(.22,.62,noise3(vec3(s.x*2.3,s.y*6.,23.)));
      float alpha=plume*strand*taper*.27*smoothstep(.06,.23,d.y)*smoothstep(0.,.08,cirrusCoverage);
      vec3 light=normalize(mix(sunDir,moonDir,night));
      vec3 color=mix(cloudShade,cloudLight,.82)+cloudLight*pow(max(dot(d,light),0.),10.)*.12;
      gl_FragColor=vec4(color,alpha);${output}}`}));
  const cirrus=new THREE.Mesh(dome,cirrusMat);cirrus.name='high-cirrus-layer';cirrus.renderOrder=-15;group.add(cirrus);
  const cloudMat=keep(new THREE.ShaderMaterial({uniforms:u,vertexShader:vertex,side:THREE.BackSide,transparent:true,depthTest:false,depthWrite:false,
    fragmentShader:`varying vec3 vDir;uniform vec3 sunDir,moonDir,cloudLight,cloudShade;uniform vec2 windOffset;uniform int steps;uniform float coverage,weatherThreshold,time,night;${cloudNoise}
    float density(vec3 p){float h=(p.y-120.)/135.;float layer=smoothstep(0.,.15,h)*(1.-smoothstep(.65,1.,h));p.xz-=windOffset;
    // An oblique slice crosses all lattice axes; an axis-aligned slice exposed square cells.
    vec3 weatherP=vec3(.8*p.x+.6*p.z,-.36*p.x+.48*p.z,.48*p.x-.64*p.z)/280.;
    float weather=fbm(weatherP);
    float cover=smoothstep(weatherThreshold-.035,weatherThreshold+.035,weather);
    if(cover<.001)return 0.;
    vec3 q=vec3(.8*p.x+.6*p.z,-.36*p.x+.8*p.y+.48*p.z,.48*p.x+.6*p.y-.64*p.z);
    float volume=fbm(q/85.);float erosion=noise3(q/24.);
    // Weather selects regions; a 3D isosurface shapes their edges instead of extruding a mask.
    float shape=max(0.,(volume-.30)*2.2-(1.-cover)*.65-erosion*.12);
    return layer*shape*2.;}

    void main(){vec3 d=normalize(vDir);if(coverage<.001||d.y<.025){gl_FragColor=vec4(0.);return;}float near=120./d.y,far=min(255./d.y,near+1600.);float stepSize=(far-near)/float(steps);float jitter=hash(vec3(gl_FragCoord.xy,0.));float silver=pow(max(dot(d,normalize(mix(sunDir,moonDir,night))),0.),12.)*.5;float alpha=0.;vec3 col=vec3(0.);vec3 light=normalize(mix(sunDir,moonDir,night));
    for(int i=0;i<64;i++){if(i>=steps)break;vec3 p=d*(near+(float(i)+jitter)*stepSize);float den=density(p);if(den<.001)continue;float a=1.-exp(-den*stepSize*.065);float shadow=density(p+light*32.);float bright=clamp(1.-shadow*2.5,.2,1.);vec3 c=mix(cloudShade,cloudLight,bright*.45+.15+clamp((p.y-120.)/135.,0.,1.)*.25)+cloudLight*silver;col+=(1.-alpha)*a*c;alpha+=(1.-alpha)*a;if(alpha>.985)break;}
    float fade=smoothstep(.025,.095,d.y);gl_FragColor=vec4(col*fade,alpha*fade);}` }));
  cloudMat.toneMapped=false;cloudMat.blending=THREE.NoBlending;
  const clouds=new THREE.Mesh(dome,cloudMat);clouds.name='cloud-layer';
  const cloudScene=new THREE.Scene();cloudScene.add(clouds);
  const target=keep(new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,stencilBuffer:false,type:THREE.HalfFloatType}));
  const cloudTexel=new THREE.Vector2();
  const compositeMat=keep(new THREE.ShaderMaterial({uniforms:{cloudMap:{value:target.texture},cloudTexel:{value:cloudTexel}},transparent:true,depthTest:false,depthWrite:false,
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    // Filter premultiplied radiance and opacity together to avoid dark fringes at clear edges.
    fragmentShader:`varying vec2 vUv;uniform sampler2D cloudMap;uniform vec2 cloudTexel;
    void main(){vec4 c=vec4(0.);for(int y=-1;y<=1;y++){for(int x=-1;x<=1;x++){
      float w=(x==0?2.:1.)*(y==0?2.:1.)/16.;c+=texture2D(cloudMap,vUv+vec2(float(x),float(y))*cloudTexel*1.5)*w;
    }}gl_FragColor=vec4(c.rgb/max(c.a,.00001),c.a);${output}}`}));
  const composite=new THREE.Mesh(keep(new THREE.PlaneGeometry(2,2)),compositeMat);composite.frustumCulled=false;composite.renderOrder=-10;group.add(composite);
  const dimensions=new THREE.Vector2(), savedClear=new THREE.Color();
  // Geometry-only sky for PMREM and the street's mirror camera. No screen-space composite.
  const environmentScene=new THREE.Scene();
  const envCirrusMat=keep(cirrusMat.clone());envCirrusMat.uniforms=u;envCirrusMat.depthTest=true;
  const envCirrus=new THREE.Mesh(dome,envCirrusMat);envCirrus.scale.setScalar(2.98);envCirrus.renderOrder=-15;
  const envSky=new THREE.Mesh(dome,skyMat);envSky.scale.setScalar(3);envSky.renderOrder=-30;
  const envCloudMat=keep(cloudMat.clone());envCloudMat.uniforms=u;envCloudMat.transparent=true;
  envCloudMat.blending=THREE.NormalBlending;envCloudMat.toneMapped=true;envCloudMat.depthTest=true;
  envCloudMat.fragmentShader=cloudMat.fragmentShader.replace('vec4(col*fade,alpha*fade)','vec4(col/max(alpha,.001),alpha*fade)').replace('alpha*fade);}',`alpha*fade);${output}}`);
  const envCloud=new THREE.Mesh(dome,envCloudMat);envCloud.scale.setScalar(2.95);envCloud.renderOrder=-10;
  const envSun=sun.clone(),envMoon=moon.clone();
  const envSunMat=keep(sunMat.clone()),envMoonMat=keep(moonMat.clone());
  envSunMat.uniforms=u;envMoonMat.uniforms=u;envSunMat.depthTest=envMoonMat.depthTest=true;
  envSun.material=envSunMat;envMoon.material=envMoonMat;
  environmentScene.add(envSky,envCloud,envSun,envMoon,envCirrus);
  let resolution=.5;
  function renderClouds(renderer:THREE.WebGLRenderer,camera:THREE.Camera){
    composite.visible=u.coverage.value>.001;if(!composite.visible)return;
    renderer.getDrawingBufferSize(dimensions);
    const width=Math.max(1,Math.ceil(dimensions.x*resolution)),height=Math.max(1,Math.ceil(dimensions.y*resolution));
    if(target.width!==width||target.height!==height)target.setSize(width,height);
    cloudTexel.set(1/width,1/height);
    const previous=renderer.getRenderTarget(),alpha=renderer.getClearAlpha();renderer.getClearColor(savedClear);
    const autoClear=renderer.autoClear;
    try{renderer.autoClear=false;renderer.setRenderTarget(target);renderer.setClearColor(0,0);renderer.clear();renderer.render(cloudScene,camera);}
    finally{renderer.setRenderTarget(previous);renderer.setClearColor(savedClear,alpha);renderer.autoClear=autoClear;}
  }
  let elapsed=0;const windVelocity=new THREE.Vector2(1.768,.884);
  const lighting={sunDirection:sunDir,moonDirection:moonDir,palette};
  return {group,environmentScene,lighting,sunDir,moonDir,windOffset:u.windOffset.value,renderClouds,
    setCirrusCoverage(amount:number){u.cirrusCoverage.value=THREE.MathUtils.clamp(amount,0,1);},
    setQuality(quality:'low'|'balanced'|'high'){resolution=quality==='low'?.35:quality==='high'?.75:.5;u.steps.value=quality==='low'?20:quality==='high'?48:32;},
    setWind(degrees:number,speed:number){const a=THREE.MathUtils.degToRad(degrees);windVelocity.set(Math.cos(a),Math.sin(a)).multiplyScalar(Math.max(0,speed));},
    setAnimationTime(seconds:number){elapsed=Math.max(0,seconds);u.windOffset.value.copy(windVelocity).multiplyScalar(elapsed);},
    update(state:TimeState,dt:number,camera:THREE.Camera,coverage=.48,phase=state.moonPhase,directions?:{sun:THREE.Vector3;moon:THREE.Vector3}){
      elapsed+=Math.max(0,dt);u.windOffset.value.addScaledVector(windVelocity,Math.max(0,dt));clouds.position.copy(camera.position);samplePalette(state.sunElev,palette);morningTint(palette,state.hours,state.sunElev);
      dirOf(state.sunAz-90,state.sunElev,sunDir);
      const lunar=sunPosition(state.day,((state.hours-phase*24)%24+24)%24);dirOf(lunar.az-90,lunar.elev,moonDir);
      if(directions){sunDir.copy(directions.sun);moonDir.copy(directions.moon);}
      const night=1-THREE.MathUtils.smoothstep(state.sunElev,-14,-4);
      u.zenith.value.copy(palette.zenith);u.mid.value.copy(palette.mid);u.horizon.value.copy(palette.horizon);u.glow.value.copy(palette.glow);u.sunColor.value.copy(palette.sunCol);
      u.cloudLight.value.copy(palette.cloud);u.cloudShade.value.copy(palette.cloudShade);u.glowAmount.value=palette.glowAmt;
      u.time.value=elapsed;u.coverage.value=THREE.MathUtils.clamp(coverage,0,1);u.weatherThreshold.value=weatherThreshold(u.coverage.value);u.night.value=night;stars.visible=night>.001;u.phase.value=phase;u.moonOn.value=(1-THREE.MathUtils.smoothstep(state.sunElev,-5,15))*THREE.MathUtils.smoothstep(moonDir.y,-.025,.04);
      group.position.copy(camera.position);
      sun.position.copy(sunDir).multiplyScalar(700);moon.position.copy(moonDir).multiplyScalar(700);
      group.updateMatrixWorld(true);sun.lookAt(camera.position);moon.lookAt(camera.position);sun.visible=sunDir.y>-.02;moon.visible=u.moonOn.value>.001;
      envSun.position.copy(sunDir).multiplyScalar(2800);envMoon.position.copy(moonDir).multiplyScalar(2800);
      envSun.scale.copy(sun.scale).multiplyScalar(4);envMoon.scale.copy(moon.scale).multiplyScalar(4);
      envSun.lookAt(0,0,0);envMoon.lookAt(0,0,0);envSun.visible=sun.visible;envMoon.visible=moon.visible;envCloud.visible=coverage>.001;
      cirrus.visible=envCirrus.visible=u.cirrusCoverage.value>.001;
    },dispose(){for(const resource of resources)resource.dispose();group.clear();},
  };
}
