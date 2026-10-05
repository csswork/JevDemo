import fs from 'node:fs';
import path from 'node:path';
import type {Connect,Plugin} from 'vite';
import {DEFAULT_SKY_SETTINGS,type SkySettings} from '../src/vrm/sky/skySettings.ts';

const scenes=new Set(['none','cafe','animeCafe','park','street']);
const ranges={coverage:[0,1],cirrus:[0,1],windDirection:[0,360],windSpeed:[0,12]} as const;
function validate(value:unknown):SkySettings{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('参数格式不正确');
 const data=value as Record<string,unknown>;
 if(Object.keys(data).length!==6||Object.keys(data).some(key=>!(key in DEFAULT_SKY_SETTINGS)))throw new Error('参数字段不正确');
 for(const [key,[min,max]] of Object.entries(ranges)){
  const v=data[key];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(key+' 超出范围');
 }
 if(data.moonPhase!==null&&(typeof data.moonPhase!=='number'||!Number.isFinite(data.moonPhase)||data.moonPhase<0||data.moonPhase>1))throw new Error('月相超出范围');
 if(!['low','balanced','high'].includes(String(data.quality)))throw new Error('质量档位不正确');
 return data as unknown as SkySettings;
}

/** Same-origin file storage shared by all browsers using this project server. */
export function sceneDefaults():Plugin{
 let root=process.cwd();
 const handler:Connect.NextHandleFunction=(req,res,next)=>{
  const match=/^\/api\/scene-defaults\/([a-zA-Z]+)$/.exec((req.url??'').split('?')[0]);
  if(!match)return next();
  const scene=match[1];
  const reply=(status:number,data:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));};
  if(!scenes.has(scene))return reply(404,{error:'场景不存在'});
  const file=path.join(root,'public','scene-defaults',scene+'.json');
  if(req.method==='GET'){
   try{return reply(200,fs.existsSync(file)?validate(JSON.parse(fs.readFileSync(file,'utf8'))):DEFAULT_SKY_SETTINGS);}
   catch{return reply(500,{error:'无法读取场景默认参数文件'});}
  }
  if(req.method!=='POST')return reply(405,{error:'不支持的请求方法'});
  if(req.headers.origin){
   try{if(new URL(req.headers.origin).host!==req.headers.host)return reply(403,{error:'仅接受同源保存'});}
   catch{return reply(403,{error:'仅接受同源保存'});}
  }
  if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'参数必须是 JSON'});
  const chunks:Buffer[]=[];let bytes=0,tooLarge=false;
  req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4096){tooLarge=true;chunks.length=0;}else if(!tooLarge)chunks.push(chunk);});
  req.on('end',()=>{
   if(tooLarge)return reply(413,{error:'参数过大'});
   let settings:SkySettings;
   try{settings=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
   catch(error){return reply(400,{error:error instanceof Error?error.message:'参数格式不正确'});}
   try{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file+'.tmp',JSON.stringify(settings,null,2)+'\n');
    fs.renameSync(file+'.tmp',file);
    return reply(200,{settings,file:'public/scene-defaults/'+scene+'.json'});
   }catch{return reply(500,{error:'无法写入场景默认参数文件'});}
  });
 };
 return {name:'scene-defaults',configResolved(config){root=config.root;},
  configureServer(server){server.middlewares.use(handler);},
  configurePreviewServer(server){server.middlewares.use(handler);}
 };
}
