import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Script} from 'node:vm';
import {startCharacterSettings} from '../../tools/character-settings.mjs';
import {readRender,saveRender} from '../../tools/render-settings.mjs';
import {defaultFraming,framingTransform,framingCrop,cropFraming} from '../../desktop/model-framing.mjs';

test('framing retains legacy defaults and moves down in screen coordinates without coupling modes',()=>{
  assert.deepEqual(framingTransform('full'),{zoom:1,x:0,y:0});
  assert.deepEqual(framingTransform('half'),{zoom:3.2,x:0,y:-1.35});
  const profile={...defaultFraming,half:{scale:90,x:5,y:4}};
  const value=framingTransform('half',profile);
  assert(Math.abs(value.zoom-2.88)<1e-9);assert.equal(value.x,.1);assert(value.y<-1.2);
  assert.deepEqual(framingTransform('full',profile),framingTransform('full'));
});
test('rectangular selection maps back to the native transform for either view without changing its aspect',()=>{
  for(const mode of ['full','half'])for(const p of [{scale:100,x:0,y:0},{scale:80,x:0,y:24},{scale:50,x:-40,y:40},{scale:150,x:40,y:-40}]){
    const rect=framingCrop(mode,p),result=cropFraming(mode,rect);
    for(const key of ['scale','x','y'])assert(Math.abs(result[key]-p[key])<1e-9);
    const wider=cropFraming(mode,{...rect,width:rect.width*1.05});assert(wider.scale<=p.scale);
  }
});
test('framing settings authorize, persist both views, reject stale or invalid writes and preserve SSAA',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pet-framing-')),settings=await startCharacterSettings(root);
  t.after(async()=>{await settings.close();await rm(root,{recursive:true,force:true});});
  const u=new URL(settings.url),endpoint=u.origin+'/api/framing',headers={Authorization:'Bearer '+u.hash.slice(7),'Content-Type':'application/json'};
  assert.equal((await fetch(endpoint)).status,401);
  assert.equal((await fetch(endpoint,{headers:{...headers,Origin:'http://foreign.invalid'}})).status,403);
  const html=await(await fetch(u.origin)).text();assert(html.indexOf('framing-form')<html.indexOf('render-form'));new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  const initial=(await(await fetch(endpoint,{headers})).json()).profile;
  await saveRender(root,4);
  const body={...initial,half:{scale:90,x:0,y:4},expectedRevision:initial.revision};
  const save=await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify(body)});assert.equal(save.status,200);
  const p=(await save.json()).profile;assert.equal(p.full.scale,100);assert.equal(p.half.scale,90);assert.equal((await readRender(root)).samples,4);
  assert.equal((await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify(body)})).status,400);
  for(const half of [{scale:151,x:0,y:0},{scale:90,x:41,y:0},{scale:90,x:0,y:-41}])assert.equal((await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify({...p,half,expectedRevision:p.revision})})).status,400);
  assert.deepEqual((await(await fetch(endpoint,{headers})).json()).profile,p);
  const assets=u.origin+'/framing-assets/editor.js';assert.equal((await fetch(assets)).status,401);
  assert.equal((await fetch(u.origin+'/api/framing/preview')).status,401);
  const boot=await fetch(u.origin+'/api/framing/preview',{headers});const cookie=boot.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const assetHeaders={Cookie:cookie.split(';')[0]};assert.equal((await fetch(assets,{headers:assetHeaders})).status,200);
  assert.equal((await fetch(u.origin+'/framing-assets/secret.json',{headers:assetHeaders})).status,404);
  assert.equal((await fetch(assets,{headers:{...assetHeaders,Origin:'http://foreign.invalid'}})).status,403);
});
