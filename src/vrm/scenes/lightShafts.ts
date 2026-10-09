import {LIGHT_SHAFT_DEFAULTS,LIGHT_SHAFT_RANGES as LIMITS,type LightShaftParameters} from './lightShaftSettings.ts';
export {LIGHT_SHAFT_DEFAULTS,type LightShaftParameters} from './lightShaftSettings.ts';
import * as THREE from 'three';

export interface Shaft {
  /** Anchor in the mesh's local space; sun direction is world-space. */
  ground: [number, number, number];
  length: number;
  width: number;
  intensity: number;
}


const VERT = /* glsl */ `
attribute vec3 iGround;
attribute vec4 iParams;
uniform vec3 uSunDir;
uniform float uWidth;
uniform float uSpread;
varying vec2 vUv;
varying vec3 vParams;
varying float vDist;
varying float vAngle;
void main(){
  vec3 base=(modelMatrix*vec4(iGround,1.)).xyz;
  vec3 axis=uSunDir;
  vec3 delta=cameraPosition-(base+axis*iParams.x*.5);
  vec3 viewDir=delta/max(length(delta),.0001);
  vec3 side=cross(axis,viewDir);
  float angle=length(side);
  vec3 reference=abs(axis.y)<.95?vec3(0.,1.,0.):vec3(1.,0.,0.);
  // One stable frame for the entire shaft. No per-vertex twist or NaN on axis.
  side=angle>.0001?side/angle:normalize(cross(axis,reference));
  float y=position.y;
  float width=iParams.y*uWidth*mix(1.+uSpread,.8,y);
  vec3 world=base+axis*(y*iParams.x)+side*position.x*width;
  vec4 mv=viewMatrix*vec4(world,1.);
  vUv=vec2(position.x+.5,y);
  vDist=-mv.z;
  vAngle=smoothstep(.06,.38,angle);
  vParams=vec3(iParams.z,iParams.w,.88+.22*pow(max(0.,dot(viewDir,axis)),4.));
  gl_Position=projectionMatrix*mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;
uniform float uSoftness;
uniform float uBreakup;
uniform float uHaze;
uniform float uNearFade;
uniform float uFarFade;
varying vec2 vUv;
varying vec3 vParams;
varying float vDist;
varying float vAngle;
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
void main(){
  float x=vUv.x*2.-1.;
  float aa=max(fwidth(x),.001);
  float edge=1.-smoothstep(1.-aa*2.,1.,abs(x));
  float envelope=exp(-x*x*mix(8.,3.2,uSoftness))*edge;
  float y=vUv.y;
  float along=smoothstep(.015,.27,y)*(1.-smoothstep(.64,1.,y));
  float t=uTime;
  vec2 seed=vec2(vParams.y*47.,vParams.y*19.);
  // Low-frequency canopy gaps and thinner fibres share a very slow drift.
  // No sinusoidal stripes or frame-random noise; speed=0 freezes the pattern.
  float coarse=noise(vec2(x*2.7+t*.023,y*.9-t*.033)+seed);
  float fine=noise(vec2(x*8.5+coarse*.55+t*.018,y*1.8-t*.045)+seed*1.7);
  float fibres=smoothstep(.22,.78,coarse*.65+fine*.35);
  float structure=mix(1.,.16+fibres*1.3,uBreakup);
  float core=envelope*structure;
  float veil=exp(-x*x*2.2)*edge*.3;
  float profile=mix(core,core*.65+veil,uHaze);
  float distanceFade=smoothstep(.35,uNearFade,vDist)*(1.-smoothstep(uFarFade*.5,uFarFade,vDist));
  float optical=profile*along*vParams.x*uIntensity*distanceFade*vAngle*vParams.z;
  float scatter=1.-exp(-max(0.,optical));
  gl_FragColor=vec4(uColor*scatter,1.);
}`;

export interface LightShaftSystem {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  update(elapsedSeconds: number): void;
  getParameters(): LightShaftParameters;
  setParameters(patch: Partial<LightShaftParameters>): void;
  setSunDirection(direction: THREE.Vector3): void;
  getColor(): THREE.Color;
  setColor(color: THREE.ColorRepresentation): void;
  setShafts(shafts: Shaft[]): void;
  dispose(): void;
}

/** Stylized scattering, one draw and two triangles per shaft. Uses scene depth testing.
 * No depth capture, shadow-map sampling, screen-sized targets or temporal history.
 * Place anchors below canopy openings; call update with absolute elapsed seconds.
 */
export function createLightShafts(
  shafts: Shaft[], sunDir: THREE.Vector3,
  color = new THREE.Color(1, .92, .77),
  parameters: Partial<LightShaftParameters> = {},
): LightShaftSystem {
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, .5, 0);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  quad.dispose();
  const settings = { ...LIGHT_SHAFT_DEFAULTS };
  const uniforms: Record<string, THREE.IUniform> = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uColor: { value: color.clone() }, uTime: { value: 0 },
  };
  for (const [key, value] of Object.entries(settings)) uniforms[`u${key[0].toUpperCase()}${key.slice(1)}`] = { value };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'light-shafts'; mesh.frustumCulled = false; mesh.renderOrder = 2;
  let lastElapsed: number | null = null;
  let phase = 0;
  const system: LightShaftSystem = {
    mesh,
    update(elapsed) {
      if (!Number.isFinite(elapsed)) return;
      const now = Math.max(0, elapsed);
      if (lastElapsed !== null) phase += Math.max(0, now - lastElapsed) * settings.speed;
      lastElapsed = now;
      uniforms.uTime.value = phase;
    },
    getParameters: () => ({ ...settings }),
    setParameters(patch) {
      for (const key of Object.keys(settings) as Array<keyof LightShaftParameters>) {
        const value = patch[key];
        if (value === undefined || !Number.isFinite(value)) continue;
        settings[key] = THREE.MathUtils.clamp(value, ...LIMITS[key]);
        uniforms[`u${key[0].toUpperCase()}${key.slice(1)}`].value = settings[key];
      }
    },
    setSunDirection(direction) {
      if ([direction.x, direction.y, direction.z].every(Number.isFinite) && direction.lengthSq() > 1e-10) uniforms.uSunDir.value.copy(direction).normalize();
    },
    setColor(value) { uniforms.uColor.value.set(value); },
    getColor: () => uniforms.uColor.value.clone(),
    setShafts(items) {
      const valid = items.filter(s => [...s.ground, s.length, s.width, s.intensity].every(Number.isFinite) && s.length > 0 && s.width > 0);
      const ground = new Float32Array(valid.length * 3), params = new Float32Array(valid.length * 4);
      valid.forEach((s, i) => { ground.set(s.ground, i * 3); params.set([s.length, s.width, Math.max(0, s.intensity), (i * .61803398875) % 1], i * 4); });
      // Release old GPU buffers when placement is replaced, not during animation.
      geometry.dispose();
      geometry.setAttribute('iGround', new THREE.InstancedBufferAttribute(ground, 3));
      geometry.setAttribute('iParams', new THREE.InstancedBufferAttribute(params, 4));
      geometry.instanceCount = valid.length;
    },
    dispose() { geometry.dispose(); material.dispose(); },
  };
  system.setSunDirection(sunDir); system.setParameters(parameters); system.setShafts(shafts);
  return system;
}
