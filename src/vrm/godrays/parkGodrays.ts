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
 /**
  * three-good-godrays 0.12.1 的 bug：照明 pass 自己记着构造时的参数（illumPass.lastParams），
  * 阴影贴图第一次就绪的那一帧会拿它重设一遍 uniform；而 setParams 只更新外层的 lastParams。
  * 结果：第一帧之前设的参数（刷新时读到的场景默认参数）被构造时的默认值盖掉 —— 面板数值对、画面不对；
  * 之后拖滑块又是好的（那时已经过了第一帧）。每次设参数都把照明 pass 记着的那份同步过去
  */
 const internal=rays as unknown as {lastParams:unknown;illumPass:{lastParams:unknown}};
 if(!internal.illumPass||!('lastParams' in internal.illumPass))throw new Error('Unsupported godrays version: illumPass.lastParams workaround needs review');
 const setParams=()=>{
  rays.setParams({...settings,color:new THREE.Color(settings.color),blur:true,gammaCorrection:false});
  internal.illumPass.lastParams=internal.lastParams;
 };
 return {
  configure(patch:Partial<GodraySettings>){Object.assign(settings,patch);setParams();},
  setEnabled(enabled:boolean){rays.enabled=enabled;},
  resize(width:number,height:number){composer.setSize(width,height);},
  render(dt:number,activeCamera:THREE.PerspectiveCamera=sourceCamera){
   const clipChanged=camera.near!==activeCamera.near||camera.far!==activeCamera.far;
   camera.copy(activeCamera,false);camera.updateMatrixWorld();
   if(clipChanged)setParams();
   // Same object keeps the library's matrix/position uniform references valid.
   const autoClear=renderer.autoClear;
   try{renderer.autoClear=false;composer.render(dt);}
   finally{renderer.autoClear=autoClear;}
  },
  dispose(){composer.dispose();},
 };
}
