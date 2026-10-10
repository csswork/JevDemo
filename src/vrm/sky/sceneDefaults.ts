import {normalizeSceneSettings,type SceneSettings} from './sceneSettings';
import type {BackdropId} from '../stage';

const base=import.meta.env.BASE_URL;
/**
 * 读场景默认参数。writable：能不能在这里保存 —— 只有本机的 dev / preview 服务有 /api/scene-defaults（server/sceneDefaults.ts），
 * 保存时写 public/scene-defaults/<场景>.json；部署后（Vercel）读的是打包进去的同一批文件，改了要提交推送才会更新。
 */
export async function loadSceneDefaults(scene:BackdropId,signal?:AbortSignal):Promise<{settings:SceneSettings;writable:boolean}>{
 let response=await fetch(base+'api/scene-defaults/'+scene,{cache:'no-store',signal});
 let writable=true;
 // Static deployments read the JSON files copied by Vite's production build.
 if(response.status===404||!response.headers.get('content-type')?.includes('application/json')){
  writable=false;
  response=await fetch(base+'scene-defaults/'+scene+'.json',{cache:'no-store',signal});
 }
 if(!response.ok)throw new Error('读取场景默认参数失败');
 return {settings:normalizeSceneSettings(await response.json()),writable};
}
export async function saveSceneDefaults(scene:BackdropId,settings:SceneSettings):Promise<SceneSettings>{
 const response=await fetch(base+'api/scene-defaults/'+scene,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('保存需要运行项目开发服务或预览服务');
 const result=await response.json();
 if(!response.ok)throw new Error(result.error??'保存失败');
 return result.settings;
}
