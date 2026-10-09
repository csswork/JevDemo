import type {GodraysPass} from 'three-good-godrays';
import type {ShaderMaterial} from 'three';

/** Version-checked extension for three-good-godrays 0.12.1.
 * Keep its real shadow sampling and depth-aware upsampling, but concentrate
 * aerosols below the canopy instead of integrating bright air above the forest.
 * No extra render targets, lights, raymarch steps. One extra shadow lookup per lit sample preserves canopy gaps.
 */
export function applyCanopyScattering(pass:GodraysPass){
 const material=(pass as unknown as {illumPass:{fullscreenMaterial:ShaderMaterial}}).illumPass.fullscreenMaterial;
 const source=material.fragmentShader;
 const accumulation='illum+=shadowAmount*densityFactor*pow(1.0-shadowInfo.y/lightCameraFar,distanceAttenuation);';
 const finish='illum/=samplesFloat;';
 if(!source.includes(accumulation)||!source.includes(finish))throw new Error('Unsupported godrays shader: canopy integration needs review');
 material.fragmentShader=source.replace('float illum=0.0;', 'float illum=0.0;float canopyWeight=0.0;float canopyLit=0.0;')
 .replace(accumulation,`
 float heightWeight=(1.0-smoothstep(3.0,8.0,samplePos.y))*smoothstep(-0.7,0.3,samplePos.y);
 float distanceWeight=1.0-smoothstep(12.0,32.0,distance(samplePos,cameraPos));
 // Compare a nearby parallel light ray: open air has no beam boundary,
 // while light through a canopy opening is bordered by real leaf shadows.
 // Rotate the offset across march steps (one lookup, not four per step).
 vec3 lightDirection=normalize(lightPos);
 vec3 tangent=normalize(cross(lightDirection,vec3(0.0,1.0,0.0)));
 vec3 bitangent=cross(lightDirection,tangent);
 float quadrant=mod(float(i),4.0);
 vec3 offset=quadrant<1.0?tangent:quadrant<2.0?-tangent:quadrant<3.0?bitangent:-bitangent;
 float adjacentShadow=shadowAmount>0.5?inShadow(samplePos+offset*0.7).x:0.0;
 float weight=heightWeight*distanceWeight;
 float gapWeight=0.02+3.6*adjacentShadow;
 canopyWeight+=weight;canopyLit+=shadowAmount*weight;
 illum+=shadowAmount*densityFactor*weight*gapWeight*2.0*pow(1.0-shadowInfo.y/lightCameraFar,distanceAttenuation);
 `).replace(finish,`${finish}
 // Suppress the low-visibility veil; coherent illuminated gaps retain their light.
 float litFraction=canopyLit/max(canopyWeight,0.0001);
 illum*=smoothstep(0.02,0.3,litFraction);
 illum*=smoothstep(0.025,0.18,illum);
 `);
 material.needsUpdate=true;
}
