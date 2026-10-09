import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {sceneDefaults} from '../server/sceneDefaults.ts';
import {DEFAULT_SCENE_SETTINGS} from '../src/vrm/sky/sceneSettings.ts';

test('scene files migrate old settings, persist shafts per scene, reject invalid writes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-shafts-'));
 const plugin=sceneDefaults();plugin.configResolved({root});
 let handler;plugin.configureServer({middlewares:{use(value){handler=value;}}});
 const server=http.createServer((req,res)=>handler(req,res,()=>{res.statusCode=404;res.end();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/scene-defaults/`;
 try{
  fs.mkdirSync(path.join(root,'public/scene-defaults'),{recursive:true});
  const old={...DEFAULT_SCENE_SETTINGS};delete old.lightShafts;delete old.godrays;
  fs.writeFileSync(path.join(root,'public/scene-defaults/park.json'),JSON.stringify(old));
  assert.deepEqual((await (await fetch(base+'park')).json()).lightShafts,DEFAULT_SCENE_SETTINGS.lightShafts);
  assert.deepEqual((await (await fetch(base+'park')).json()).godrays,DEFAULT_SCENE_SETTINGS.godrays);
  const legacy={...DEFAULT_SCENE_SETTINGS,lightShafts:{...DEFAULT_SCENE_SETTINGS.lightShafts}};delete legacy.lightShafts.count;delete legacy.lightShafts.area;
  fs.writeFileSync(path.join(root,'public/scene-defaults/park.json'),JSON.stringify(legacy));
  assert.equal((await (await fetch(base+'park')).json()).lightShafts.count,15);
  const settings={...DEFAULT_SCENE_SETTINGS,godrays:{...DEFAULT_SCENE_SETTINGS.godrays,density:.018,sunElevation:24,resolutionScale:.25,enabled:false},lightShafts:{...DEFAULT_SCENE_SETTINGS.lightShafts,intensity:1.13,count:28,area:1.4,color:'#ffeedd',enabled:false}};
  const post=value=>fetch(base+'park',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post(settings)).status,200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'public/scene-defaults/park.json'),'utf8')),settings);
  assert.deepEqual(await (await fetch(base+'park')).json(),settings);
  assert.deepEqual((await (await fetch(base+'street')).json()).lightShafts,DEFAULT_SCENE_SETTINGS.lightShafts);
  assert.equal((await post({...settings,lightShafts:{...settings.lightShafts,intensity:999}})).status,400);
  for(const patch of [{density:9},{raymarchSteps:33.5},{resolutionScale:.3},{sunElevation:0},{color:'bad'}]){
   assert.equal((await post({...settings,godrays:{...settings.godrays,...patch}})).status,400);
  }
  assert.deepEqual(await (await fetch(base+'park')).json(),settings);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
