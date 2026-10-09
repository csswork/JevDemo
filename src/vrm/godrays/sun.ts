import * as THREE from 'three';

export function createPreviewSun(){
 const sun=new THREE.DirectionalLight(0xfff1dc,2.2);
 sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);
 Object.assign(sun.shadow.camera,{left:-18,right:18,top:18,bottom:-18,near:1,far:90});
 // Godrays linearizes depth using these bounds. Updating fields alone leaves an
 // old projection and makes the volume's shadow comparisons inconsistent.
 sun.shadow.camera.updateProjectionMatrix();
 sun.shadow.bias=-.0002;sun.shadow.normalBias=.025;
 return sun;
}
export function setPreviewSunElevation(sun:THREE.DirectionalLight,degrees:number){
 const altitude=THREE.MathUtils.degToRad(degrees),azimuth=Math.atan2(5,21);
 sun.position.set(Math.cos(altitude)*Math.cos(azimuth)*40,Math.sin(altitude)*40,Math.cos(altitude)*Math.sin(azimuth)*40);
 sun.updateMatrixWorld();sun.shadow.updateMatrices(sun);
}
