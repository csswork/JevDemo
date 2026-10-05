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
  const palette = createPalette();
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
  const u = {
    zenith:{value:new THREE.Color()}, mid:{value:new THREE.Color()}, horizon:{value:new THREE.Color()},
    glow:{value:new THREE.Color()}, sunColor:{value:new THREE.Color()}, sunDir:{value:sunDir}, moonDir:{value:moonDir},
    night:{value:0}, time:{value:0}, coverage:{value:.48}, cloudLight:{value:new THREE.Color()},
    cloudShade:{value:new THREE.Color()}, glowAmount:{value:0}, phase:{value:.38}, moonOn:{value:0},
  };
  const dome = keep(new THREE.SphereGeometry(1000,32,20));
  const skyMat = keep(new THREE.ShaderMaterial({uniforms:u,vertexShader:vertex,side:THREE.BackSide,depthWrite:false,depthTest:false,
    fragmentShader:`varying vec3 vDir;uniform vec3 zenith,mid,horizon,glow,sunDir;uniform float night,glowAmount;${noise}
    void main(){vec3 d=normalize(vDir);float h=max(d.y,0.);vec3 c=mix(horizon,mid,smoothstep(0.,.3,h));c=mix(c,zenith,pow(h,.7));
    float toward=pow(max(dot(d,sunDir),0.),5.);c+=glow*glowAmount*toward*exp(-h*5.)*.55;
    float band=exp(-pow((d.x*.35+d.y*.55+d.z*.76-.22)*7.,2.));float dust=fbm(d*27.);c+=vec3(.014,.019,.04)*band*pow(dust,2.)*night;
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

  const cloudMat=keep(new THREE.ShaderMaterial({uniforms:u,vertexShader:vertex,side:THREE.BackSide,transparent:true,depthTest:false,depthWrite:false,
    fragmentShader:`varying vec3 vDir;uniform vec3 sunDir,moonDir,cloudLight,cloudShade;uniform float coverage,time,night;${noise}
    float density(vec3 p){float h=(p.y-120.)/135.;float layer=smoothstep(0.,.15,h)*(1.-smoothstep(.65,1.,h));vec3 q=p/260.+vec3(time*.004,0.,time*.002);float base=fbm(q*1.7);float shape=smoothstep(.59-coverage*.25,.72-coverage*.25,base);float erosion=fbm(p/35.+vec3(time*.026,0.,0.));return max(0.,shape*layer-(.16+.2*erosion))*2.;}
    void main(){vec3 d=normalize(vDir);if(d.y<.025){gl_FragColor=vec4(0.);return;}float near=120./d.y,far=min(255./d.y,near+1600.);float stepSize=(far-near)/64.;float alpha=0.;vec3 col=vec3(0.);vec3 light=normalize(mix(sunDir,moonDir,night));
    for(int i=0;i<64;i++){vec3 p=d*(near+(float(i)+hash(vec3(gl_FragCoord.xy,0.)))*stepSize);float den=density(p);float a=1.-exp(-den*stepSize*.065);float shadow=density(p+light*32.);float bright=clamp(1.-shadow*2.5,.2,1.);float silver=pow(max(dot(d,light),0.),12.)*.5;vec3 c=mix(cloudShade,cloudLight,bright*.45+.15+clamp((p.y-120.)/135.,0.,1.)*.25)+cloudLight*silver;col+=(1.-alpha)*a*c;alpha+=(1.-alpha)*a;if(alpha>.985)break;}
    float fade=smoothstep(.025,.095,d.y)*smoothstep(0.,.06,coverage);gl_FragColor=vec4(col/max(alpha,.001),alpha*fade);${output}}` }));
  const clouds=new THREE.Mesh(dome,cloudMat);clouds.name='cloud-layer';clouds.renderOrder=-10;group.add(clouds);
  let elapsed=0;
  const lighting={sunDirection:sunDir,moonDirection:moonDir,palette};
  return {group,lighting,sunDir,moonDir,
    update(state:TimeState,dt:number,camera:THREE.Camera,coverage=.48,phase=state.moonPhase){
      elapsed+=dt;samplePalette(state.sunElev,palette);morningTint(palette,state.hours,state.sunElev);
      dirOf(state.sunAz-90,state.sunElev,sunDir);
      const lunar=sunPosition(state.day,((state.hours-phase*24)%24+24)%24);dirOf(lunar.az-90,lunar.elev,moonDir);
      const night=1-THREE.MathUtils.smoothstep(state.sunElev,-14,-4);
      u.zenith.value.copy(palette.zenith);u.mid.value.copy(palette.mid);u.horizon.value.copy(palette.horizon);u.glow.value.copy(palette.glow);u.sunColor.value.copy(palette.sunCol);
      u.cloudLight.value.copy(palette.cloud);u.cloudShade.value.copy(palette.cloudShade);u.glowAmount.value=palette.glowAmt;
      u.time.value=elapsed;u.coverage.value=coverage;u.night.value=night;u.phase.value=phase;u.moonOn.value=(1-THREE.MathUtils.smoothstep(state.sunElev,-5,15))*THREE.MathUtils.smoothstep(moonDir.y,-.025,.04);
      group.position.copy(camera.position);
      sun.position.copy(sunDir).multiplyScalar(700);moon.position.copy(moonDir).multiplyScalar(700);
      group.updateMatrixWorld(true);sun.lookAt(camera.position);moon.lookAt(camera.position);sun.visible=sunDir.y>-.02;moon.visible=u.moonOn.value>.001;
    },dispose(){for(const resource of resources)resource.dispose();group.clear();},
  };
}
