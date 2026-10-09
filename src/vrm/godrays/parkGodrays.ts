import * as THREE from 'three';
import {applyCanopyScattering} from './canopyScattering';
import {EffectComposer,RenderPass,EffectPass,ToneMappingEffect,ToneMappingMode} from 'postprocessing';
import {GodraysPass} from 'three-good-godrays';

export {GODRAY_DEFAULTS,type GodraySettings} from './settings';
import {GODRAY_DEFAULTS,type GodraySettings} from './settings';
/** Reusable adapter: scene depth + existing sun shadow, with one output transform. */
export function createParkGodrays(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.PerspectiveCamera,sun:THREE.DirectionalLight,options:{toneMapping?:boolean;multisampling?:number}={}){
 const sourceCamera=camera;camera=sourceCamera.clone();
 const settings={...GODRAY_DEFAULTS};
 const previousAutoClear=renderer.autoClear;
 const composer=new EffectComposer(renderer,{frameBufferType:THREE.HalfFloatType,multisampling:options.multisampling??0});
 const renderPass=new RenderPass(scene,camera);
 const rays=new GodraysPass(sun,camera,{...settings,color:new THREE.Color(settings.color),blur:true,gammaCorrection:false});
 applyCanopyScattering(rays);
 const output=new EffectPass(camera,new ToneMappingEffect({mode:options.toneMapping===false?ToneMappingMode.LINEAR:ToneMappingMode.ACES_FILMIC}));
 composer.addPass(renderPass);composer.addPass(rays);composer.addPass(output);
 renderer.autoClear=previousAutoClear;
 return {
  configure(patch:Partial<GodraySettings>){Object.assign(settings,patch);rays.setParams({...settings,color:new THREE.Color(settings.color),blur:true,gammaCorrection:false});},
  setEnabled(enabled:boolean){rays.enabled=enabled;},
  resize(width:number,height:number){composer.setSize(width,height);},
  render(dt:number,activeCamera:THREE.PerspectiveCamera=sourceCamera){
   const clipChanged=camera.near!==activeCamera.near||camera.far!==activeCamera.far;
   camera.copy(activeCamera,false);camera.updateMatrixWorld();
   if(clipChanged)rays.setParams({...settings,color:new THREE.Color(settings.color),blur:true,gammaCorrection:false});
   // Same object keeps the library's matrix/position uniform references valid.
   const autoClear=renderer.autoClear;
   try{renderer.autoClear=false;composer.render(dt);}
   finally{renderer.autoClear=autoClear;}
  },
  dispose(){composer.dispose();},
 };
}
