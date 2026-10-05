import * as THREE from 'three';
import {createSkyRenderer} from './skyRenderer';
import {createSkyMapping} from '../scenes/streetTime';
import {REFLECT_LAYER} from '../scenes/water';
import type {TimeState} from '../timeOfDay';

import type {SkySettings} from './skySettings';
export {DEFAULT_SKY_SETTINGS,updateSkySettings,type SkySettings} from './skySettings';
export function createStreetSky(world:THREE.Scene,settings:SkySettings){
 const sky=createSkyRenderer(),background=new THREE.Scene();background.add(sky.group);
 const proxy=sky.environmentScene.clone();proxy.name='street-sky-reflection';
 proxy.traverse(o=>o.layers.set(REFLECT_LAYER));world.add(proxy);
 const mapping=createSkyMapping([2,2.3,.9]),directions={sun:new THREE.Vector3(),moon:new THREE.Vector3()};
 let version=0,signature='';
 function configure(value:SkySettings){settings={...value};sky.setCirrusCoverage(settings.cirrus);sky.setWind(settings.windDirection,settings.windSpeed);sky.setQuality(settings.quality);}
 configure(settings);
 return {
  configure,
  get environmentScene(){return sky.environmentScene;},
  get environmentVersion(){return version;},
  update(state:TimeState,dt:number,camera:THREE.Camera){
   mapping.sun(state,directions.sun);mapping.moon(state,directions.moon);
   sky.update(state,dt,camera,settings.coverage,state.moonPhase,directions);
   proxy.children.forEach((child,i)=>{const source=sky.environmentScene.children[i];child.position.copy(source.position);child.quaternion.copy(source.quaternion);child.scale.copy(source.scale);child.visible=source.visible;});
   const next=[Math.round(state.sunElev*2),Math.round(state.sunAz*2),state.moonPhase.toFixed(3),settings.coverage,settings.cirrus].join('|');
   if(next!==signature){signature=next;version++;}
  },
  render(renderer:THREE.WebGLRenderer,camera:THREE.Camera){
   const auto=renderer.autoClear,tone=renderer.toneMapping;
   try{renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.autoClear=true;sky.renderClouds(renderer,camera);renderer.render(background,camera);}
   finally{renderer.autoClear=auto;renderer.toneMapping=tone;}
  },
  dispose(){world.remove(proxy);background.clear();sky.dispose();}
 };
}
