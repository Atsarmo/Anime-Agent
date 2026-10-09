import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ssaaSize} from '../../desktop/ssaa.mjs';
import {startCharacterSettings} from '../../tools/character-settings.mjs';
import {readRender} from '../../tools/render-settings.mjs';
test('SSAA uses physical pixel samples and respects render size and pixel budget',()=>{
 assert.deepEqual(ssaaSize(360,340,1.5,0),{width:540,height:510,actualSamples:1,limited:false});
 assert.equal(ssaaSize(360,340,1.5,16,16384).width,2160);
 assert.equal(ssaaSize(360,340,1.5,64,16384).width,4320);
 const limited=ssaaSize(720,680,3,64,4096);assert(limited.width<=4096);assert(limited.height<=4096);assert(limited.width*limited.height<=32000000);assert(limited.limited);
});
test('render web settings authenticate, persist 0–64 and reject invalid multipliers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ssaa-test-')),settings=await startCharacterSettings(root);t.after(async()=>{await settings.close();await rm(root,{recursive:true,force:true});});
 const u=new URL(settings.url),endpoint=u.origin+'/api/render',headers={Authorization:'Bearer '+u.hash.slice(7),'Content-Type':'application/json'};
 assert.equal((await fetch(endpoint)).status,401);assert.equal((await fetch(endpoint,{headers:{...headers,Origin:'http://foreign.invalid'}})).status,403);
 assert.match(await(await fetch(u.origin)).text(),/画面设置 · SSAA/);
 for(const samples of [0,64]){assert.equal((await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify({samples})})).status,200);assert.equal((await readRender(root)).samples,samples);}
 for(const samples of [-1,65,1.5,'16'])assert.equal((await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify({samples})})).status,400);
 assert.equal((await(await fetch(endpoint,{headers})).json()).metrics,null);
});
