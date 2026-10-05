import * as THREE from 'three';

// Original stylized lunar albedo, generated once. No third-party image or runtime noise march.
let lunarPixels: Uint8Array | undefined;
function lunarAlbedo() {
  const size=256;
  if (!lunarPixels) {
    const values=new Float32Array(size*size);
    let seed=67031;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const lattice=Float32Array.from({length:64*64},random);
    const noise=(x:number,y:number)=>{
      const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
      const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
      const at=(a:number,b:number)=>lattice[((a%64+64)%64)+64*((b%64+64)%64)];
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(ix,iy),at(ix+1,iy),sx),THREE.MathUtils.lerp(at(ix,iy+1),at(ix+1,iy+1),sx),sy);
    };
    // Overlapping uneven basins give a continuous moon-sea silhouette, not scattered noise spots.
    const seas=[[-.48,.24,.40,.43,.19],[-.15,.49,.25,.26,.16],[.20,.31,.24,.28,.23],
      [.47,.12,.21,.27,.18],[.08,-.04,.26,.23,.15],[-.45,-.20,.22,.31,.12]];
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const px=(x+.5)/size*2-1,py=(y+.5)/size*2-1;
      const rough=(noise(x/11,y/11)-.5)*.05+(noise(x/3,y/3)-.5)*.025;
      let value=.82+rough;
      const warp=(noise(x/19+8,y/19+17)-.5)*.16;
      for(const [cx,cy,rx,ry,dark] of seas){
        const r=Math.hypot((px-cx)/rx,(py-cy)/ry)+warp;
        value-=dark*(1-THREE.MathUtils.smoothstep(r,.5,1.13));
      }
      values[x+y*size]=value;
    }
    // Crater rings are baked, then mipmapped; their texture stays fixed while illumination moves.
    for(let i=0;i<180;i++){
      const cx=random()*size,cy=random()*size,r=1.1+Math.pow(random(),3)*9;
      if(Math.hypot(cx/size*2-1,cy/size*2-1)>.98)continue;
      for(let y=Math.max(0,Math.floor(cy-r*1.2));y<Math.min(size,Math.ceil(cy+r*1.2));y++){
        for(let x=Math.max(0,Math.floor(cx-r*1.2));x<Math.min(size,Math.ceil(cx+r*1.2));x++){
          const d=Math.hypot(x+.5-cx,y+.5-cy)/r;
          values[x+y*size]+=.085*Math.exp(-(((d-.82)/.12)**2))-.045*Math.exp(-d*d*5);
        }
      }
    }
    lunarPixels=Uint8Array.from(values,v=>Math.round(THREE.MathUtils.clamp(v,0,1)*255));
  }
  const texture=new THREE.DataTexture(lunarPixels,size,size,THREE.RedFormat);
  texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.magFilter=THREE.LinearFilter;texture.needsUpdate=true;
  return texture;
}

const vertex=/* glsl */ `
varying vec2 vUv;
void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const output=`\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n`;
type Uniforms={
  glow:{value:THREE.Color}; sunColor:{value:THREE.Color}; sunDir:{value:THREE.Vector3};
  phase:{value:number}; moonOn:{value:number};
};
type Keep=<T extends {dispose():void}>(value:T)=>T;

/** Separate celestial discs with pixel-filtered edges and restrained, continuous diffusion.
 * References (independent implementation): Three.js Sky's atmospheric sun and
 * Takram three-geospatial's sphere-intersection / rough lunar diffuse approach.
 * This keeps our artistic sky palette and cloud compositing instead of replacing the skydome.
 */
export function createCelestialBodies(keep:Keep,u:Uniforms){
  const geometry=keep(new THREE.PlaneGeometry(1,1));
  const sunMaterial=keep(new THREE.ShaderMaterial({uniforms:u,vertexShader:vertex,
    transparent:true,depthTest:false,depthWrite:false,
    fragmentShader:/* glsl */ `
      varying vec2 vUv;uniform vec3 glow,sunColor,sunDir;
      void main(){
        float r=length((vUv-.5)*2.);
        float aa=max(fwidth(r)*.85,.002);
        float radius=.155;
        float disc=1.-smoothstep(radius-aa-.002,radius+aa+.002,r);
        float mu=sqrt(max(0.,1.-pow(r/radius,2.)));
        // Limb shading and elevation tint soften the centre without a noisy solar surface.
        float low=1.-smoothstep(.02,.35,sunDir.y);
        vec3 tint=mix(sunColor,vec3(1.,.50,.20),low*.30);
        vec3 body=tint*(2.4+.65*mu);
        float edge=max(r-radius,0.);
        float halo=(.19*exp(-edge*edge/.014)+.028*exp(-edge*edge/.12))
          *(1.-smoothstep(.75,1.,r));
        float alpha=disc+(1.-disc)*halo;
        vec3 light=mix(tint,mix(tint,glow,.30),low*.25);
        vec3 color=(body*disc+light*halo*(1.-disc))/max(alpha,.00001);
        gl_FragColor=vec4(color,alpha);${output}
      }`,
  }));
  const albedo=keep(lunarAlbedo());
  const moonUniforms={...u,moonAlbedo:{value:albedo}};
  const moonMaterial=keep(new THREE.ShaderMaterial({uniforms:moonUniforms,vertexShader:vertex,
    transparent:true,depthTest:false,depthWrite:false,
    fragmentShader:/* glsl */ `
      varying vec2 vUv;uniform sampler2D moonAlbedo;uniform float phase,moonOn;
      void main(){
        vec2 xy=(vUv-.5)*2./.32;
        float r=length(xy),aa=max(fwidth(r)*.85,.002);
        float disc=1.-smoothstep(1.-aa,1.+aa,r);
        vec3 n=vec3(xy,sqrt(max(0.,1.-dot(xy,xy))));
        n=normalize(n);
        float angle=phase*6.2831853;
        vec3 light=vec3(sin(angle),0.,-cos(angle));
        float nl=dot(n,light),nv=max(n.z,.001);
        // Rough diffuse response plus a lunar-style weak limb falloff (not a plastic ball).
        float s=light.z-nl*nv;
        float rough=max(nl,0.)*(.72+.28*s/max(.12,max(nl,nv)));
        float diffuse=mix(max(rough,0.),max(nl,0.)/(max(nl,0.)+nv+.001),.38);
        float terminator=smoothstep(-max(fwidth(nl),.006),max(fwidth(nl),.006),nl);
        float illumination=.5-.5*cos(angle);
        float textureValue=texture2D(moonAlbedo,xy*.5+.5).r;
        vec3 body=vec3(.92,.94,1.)*textureValue*(.035+diffuse*1.65)*terminator
          +vec3(.24,.30,.40)*textureValue*.035*(1.-terminator);
        float edge=max(r-1.,0.);
        // Outer haze follows the illuminated fraction, so new moons do not have full halos.
        float halo=(.052*exp(-edge*edge/.13)+.010*exp(-edge*edge/.8))*illumination
          *(1.-smoothstep(2.5,3.1,r));
        float alpha=disc+(1.-disc)*halo;
        vec3 color=(body*disc+vec3(.58,.66,.84)*halo*(1.-disc))/max(alpha,.00001);
        gl_FragColor=vec4(color,alpha*moonOn);${output}
      }`,
  }));
  const sun=new THREE.Mesh(geometry,sunMaterial),moon=new THREE.Mesh(geometry,moonMaterial);
  sun.name='sun-disc';moon.name='moon-disc';sun.scale.setScalar(150);moon.scale.setScalar(70);
  sun.renderOrder=moon.renderOrder=-20;
  return {sun,moon,sunMaterial,moonMaterial,moonUniforms};
}
