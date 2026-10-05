/** Shared hash avoids amplified sin precision differences between shader stages. */
export const FAR_WINDOW_HASH = /* glsl */ `
float farRoomHash(vec3 cell) {
  vec3 p=fract(cell*vec3(.1031,.1030,.0973));
  p+=dot(p,p.yxz+33.33);
  return fract((p.x+p.y)*p.z);
}
`;

/** Shared distant facade detail. No texture, light objects, or additional draw calls.
 * vWin = local wall distance, local height, stable building seed (negative = not a wall).
 * Derivative filtering blends subpixel windows into their average coverage.
 */
export const FAR_FACADE_COLOR = /* glsl */ `
float farWindow = 0.;
float farHalo = 0.;
float farRoomSeed = 0.;
float farBuildingOn = 0.;
float farWindowBlur = 0.;
if(vWin.z>=0.) {
  vec2 grid=vec2(vWin.x/2.6,(vWin.y-.7)/2.8);
  vec2 cell=floor(grid),f=fract(grid);
  vec2 aa=max(fwidth(grid),vec2(.001));
  farRoomSeed=farRoomHash(vec3(cell,vWin.z*97.31));
  vec2 windowMask=smoothstep(vec2(.23)-aa,vec2(.23)+aa,f)
    *(1.-smoothstep(vec2(.77)-aa,vec2(.77)+aa,f));
  vec2 innerMask=smoothstep(vec2(.29)-aa,vec2(.29)+aa,f)
    *(1.-smoothstep(vec2(.71)-aa,vec2(.71)+aa,f));
  float valid=step(0.,cell.y);
  float fade=smoothstep(.3,1.,max(aa.x,aa.y));
  farWindowBlur=fade;
  float outer=mix(windowMask.x*windowMask.y,.2916,fade)*valid;
  farWindow=mix(innerMask.x*innerMask.y,.1764,fade)*valid;
  // Rectangular source diffusion in the same surface/depth pass as the window.
  // Filter both together: no separate sprite centers popping at occlusion edges.
  vec2 haloDistance=max(abs(f-.5)-vec2(.21),vec2(0.));
  vec2 haloWidth=vec2(.10)+aa;
  float halo=exp(-dot(haloDistance/haloWidth,haloDistance/haloWidth))
    *(1.-innerMask.x*innerMask.y);
  farHalo=mix(halo,.18,fade)*valid;
  vec3 glass=mix(vec3(.20,.29,.34),vec3(.42,.49,.48),farRoomSeed);
  // Quiet sky tint, occasional curtains, and frames visible in daylight.
  glass=mix(glass,vec3(.64,.58,.47),step(.80,farRoomSeed));
  diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*.77,outer);
  diffuseColor.rgb=mix(diffuseColor.rgb,glass,farWindow*.72);
  float band=(1.-smoothstep(.025,.025+aa.y,min(f.y,1.-f.y)))*(1.-fade)*valid;
  diffuseColor.rgb*=1.-band*.12;
  // Fixed building thresholds, smoothly following the existing dusk/night system.
  float onset=.04+fract(vWin.z*13.71)*.31;
  farBuildingOn=smoothstep(onset,onset+.22,uLights);
}
`;

export const FAR_FACADE_EMISSION = /* glsl */ `
if(vWin.z>=0. && uLights>0.) {
  float occupied=mix(1.-smoothstep(.43,.48,farRoomSeed),.455,farWindowBlur);
  // All rooms keep stable occupancy; mix warm interiors with a few cooler windows.
  vec3 lamp=mix(vec3(1.,.68,.32),vec3(.73,.86,1.),step(.39,farRoomSeed));
  lamp=mix(lamp,vec3(.98,.70,.38),farWindowBlur);
  totalEmissiveRadiance+=lamp*(farWindow*2.3+farHalo*.13)*occupied*farBuildingOn*uLights;
}
`;
