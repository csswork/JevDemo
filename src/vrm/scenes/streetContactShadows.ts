import * as THREE from 'three';

type Keep = <T extends { dispose(): void }>(x: T) => T;
export interface ContactBuilding {
  matrix: THREE.Matrix4;
  width: number;
  height: number;
  sidewalkY: number;
  openings: Array<[number, number, number, number]>;
  floors: number[];
  balcony?: [number, number, number];
}

/** Static, receiver-aligned ambient contact shading. No screen-space sampling,
 * shadow map or texture; all near buildings share one small geometry/draw. */
export function streetContactShadows(keep: Keep, buildings: ContactBuilding[]) {
  const positions: number[] = [], uvs: number[] = [], strengths: number[] = [], indices: number[] = [];
  const point = new THREE.Vector3();
  const quad = (matrix: THREE.Matrix4, points: number[][], strength: number) => {
    const base = positions.length / 3;
    points.forEach((p, i) => {
      point.set(p[0], p[1], p[2]).applyMatrix4(matrix);
      positions.push(point.x, point.y, point.z);
      uvs.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
      strengths.push(strength);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const b of buildings) {
    const half = b.width / 2, m = b.matrix;
    const ground = b.sidewalkY - m.elements[13] + 0.002;
    // Stone plinth touching the pavement: maximum shade at the actual foot.
    quad(m, [[-half,ground,.032],[half,ground,.032],[half,ground,.30],[-half,ground,.30]], .22);
    quad(m, [[-half,.302,.002],[half,.302,.002],[half,.45,.002],[-half,.45,.002]], .11);
    for (const [x0,y0,x1,y1] of b.openings) {
      // The frame is recessed 75 mm. Shade the real reveal, not a rectangle over the glass.
      quad(m, [[x0+.001,y0,-.074],[x0+.001,y1,-.074],[x0+.001,y1,-.002],[x0+.001,y0,-.002]], .23);
      quad(m, [[x1-.001,y0,-.074],[x1-.001,y1,-.074],[x1-.001,y1,-.002],[x1-.001,y0,-.002]], .23);
      quad(m, [[x0,y1-.001,-.074],[x1,y1-.001,-.074],[x1,y1-.001,-.002],[x0,y1-.001,-.002]], .27);
      if (y0 > .3) quad(m, [[x0,y0+.002,-.074],[x1,y0+.002,-.074],[x1,y0+.002,-.002],[x0,y0+.002,-.002]], .16);
    }
    for (const y of b.floors) {
      quad(m, [[-half,y-.083,.002],[half,y-.083,.002],[half,y-.22,.002],[-half,y-.22,.002]], .15);
    }
    // Contact beneath a projecting balcony floor; narrow and soft, not a sun shadow.
    if (b.balcony) {
      const [xa,xb,y] = b.balcony;
      quad(m, [[xa,y-.123,.003],[xb,y-.123,.003],[xb,y-.36,.003],[xa,y-.36,.003]], .19);
    }
    // Corner pilasters touch the plaster along a thin band outside their 40 mm lip.
    for (const s of [-1,1]) {
      const x = s * (half-.041), end = x-s*.095;
      quad(m, [[x,.3,.002],[x,b.height,.002],[end,b.height,.002],[end,.3,.002]], .13);
    }
  }
  const geometry = keep(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('aStrength', new THREE.Float32BufferAttribute(strengths,1));
  geometry.setIndex(indices); geometry.computeBoundingSphere();
  const material = keep(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    toneMapped: false,
    vertexShader: `attribute float aStrength; varying vec2 vContactUv; varying float vStrength; varying float vDistance;
      void main(){vContactUv=uv;vStrength=aStrength;vec4 p=modelViewMatrix*vec4(position,1.);vDistance=length(p.xyz);gl_Position=projectionMatrix*p;}`,
    fragmentShader: `varying vec2 vContactUv; varying float vStrength; varying float vDistance;
      void main(){
        float ends=smoothstep(0.,.035,vContactUv.x)*smoothstep(0.,.035,1.-vContactUv.x);
        float profile=pow(1.-smoothstep(0.,1.,vContactUv.y),2.);
        float shade=vStrength*profile*ends*(1.-smoothstep(35.,75.,vDistance));
        // White leaves the existing receiver unchanged; multiplication preserves its texture/light.
        gl_FragColor=vec4(vec3(1.-shade),1.);
      }`,
  }));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'street-building-contact-shadows';
  // Opaque receivers finish first; contacts must finish before transparent windows.
  mesh.renderOrder = -1;
  return mesh;
}
