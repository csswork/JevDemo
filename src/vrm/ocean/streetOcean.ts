import * as THREE from 'three';
import {createOceanRenderer} from './oceanRenderer';
import {createOceanRenderer as createAnalyticOcean} from './analyticOceanRenderer';
import {REFLECT_LAYER} from '../scenes/water';
import {createSkyMapping} from '../scenes/streetTime';
import type {TimeState} from '../timeOfDay';
import type {OceanSettings} from './oceanSettings';

export function createStreetOcean(renderer:THREE.WebGLRenderer,world:THREE.Scene,street:THREE.Group,settings:OceanSettings){
 const original=street.getObjectByName('sea') as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
 const u=original.material.uniforms;
 const options={y:original.position.y,shore:{map:u.uShore.value,bounds:u.uShoreBounds.value,max:u.uShoreMax.value},breakwater:u.uBreakwater.value,reflectionLayer:REFLECT_LAYER};
 const fftOcean=renderer.extensions.has('EXT_color_buffer_float')?createOceanRenderer(options):null;
 const ocean=fftOcean??createAnalyticOcean(options);
 original.visible=false;world.add(ocean.group);
 const mapping=createSkyMapping([2,2.3,.9]),directions={sun:new THREE.Vector3(),moon:new THREE.Vector3()};
 function configure(value:OceanSettings){
  ocean.setParameters(value);ocean.setQuality(value.quality);
  fftOcean?.setResolution(value.resolution);
 }
 configure(settings);
 return {
  configure,
  get reflecting(){return ocean.reflecting;},
  setWind(degrees:number,speed:number){ocean.setWind(degrees,speed);},
  update(state:TimeState,dt:number,camera:THREE.Camera){mapping.sun(state,directions.sun);mapping.moon(state,directions.moon);ocean.update(state,dt,camera,directions);},
  render(camera:THREE.Camera){
   fftOcean?.renderSimulation(renderer);
   if((camera as THREE.PerspectiveCamera).isPerspectiveCamera)ocean.renderReflection(renderer,world,camera as THREE.PerspectiveCamera);
  },
  dispose(){world.remove(ocean.group);ocean.dispose();original.visible=true;}
 };
}
