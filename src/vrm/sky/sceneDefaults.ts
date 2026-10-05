import {DEFAULT_SKY_SETTINGS,updateSkySettings,type SkySettings} from './skySettings';
import type {BackdropId} from '../stage';

const base=import.meta.env.BASE_URL;
export async function loadSceneDefaults(scene:BackdropId,signal?:AbortSignal):Promise<SkySettings>{
 let response=await fetch(base+'api/scene-defaults/'+scene,{cache:'no-store',signal});
 // Static deployments read the JSON files copied by Vite's production build.
 if(response.status===404||!response.headers.get('content-type')?.includes('application/json'))
  response=await fetch(base+'scene-defaults/'+scene+'.json',{cache:'no-store',signal});
 if(!response.ok)throw new Error('读取场景默认参数失败');
 return updateSkySettings({...DEFAULT_SKY_SETTINGS},await response.json());
}
export async function saveSceneDefaults(scene:BackdropId,settings:SkySettings):Promise<SkySettings>{
 const response=await fetch(base+'api/scene-defaults/'+scene,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('保存需要运行项目开发服务或预览服务');
 const result=await response.json();
 if(!response.ok)throw new Error(result.error??'保存失败');
 return result.settings;
}
