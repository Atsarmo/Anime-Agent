import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { requestOpenAI, responseText } from '../../providers/openai-responses.mjs';
import { startOpenAISetup } from '../../tools/configure-openai.mjs';
import { readOpenAIConfig, readOpenAIKey, configPath } from '../../tools/openai-config.mjs';
test('Responses request uses the official endpoint, preserves roles and phase, and disables storage', async()=>{
  const key='synthetic.key.for.test',input=[{role:'user',content:'你好'},{role:'assistant',content:'你好呀',phase:'final_answer'},{role:'user',content:'继续'}];
  let calls=0;
  const text=await requestOpenAI({key,model:'gpt-6-sol',input,fetcher:async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.headers.Authorization,'Bearer '+key);
    const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.stream,false);assert.deepEqual(body.input,input);
    assert.match(body.instructions,/不能声称已设置提醒/);assert.ok(!('enable_thinking' in body));
    return Response.json({status:'completed',output:[{type:'reasoning',content:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:'收到'}]}]});
  }});assert.equal(text,'收到');assert.equal(calls,1);
});
test('incomplete responses are rejected and failed inference is not retried or echoed',async()=>{
  assert.throws(()=>responseText({status:'incomplete',output:[]}),/未完整/);
  let calls=0;
  await assert.rejects(requestOpenAI({key:'secret-test-key',model:'gpt-6-sol',input:[],fetcher:async()=>{calls++;return new Response('secret-test-key',{status:401});}}),error=>!error.message.includes('secret-test-key')&&/Key 无效/.test(error.message));
  assert.equal(calls,1);
});
test('local setup requires its session token, rejects foreign origins, and saves keys outside the project',async t=>{
  const directory=await mkdtemp(resolve(tmpdir(),'openai-chat-test-')),root=resolve(directory,'project');await mkdir(root);
  let calls=0,started=0;
  const setup=await startOpenAISetup(root,{fetcher:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/models');assert.equal(options.method,undefined);return Response.json({data:[{id:'gpt-6-sol'}]});},onStart:async()=>{started++;}});
  let credentialFile;
  t.after(async()=>{await setup.close();if(credentialFile)await unlink(credentialFile);await rm(directory,{recursive:true,force:true});});
  const url=new URL(setup.url),base=url.origin,token=url.hash.slice(7),headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/status')).status,401);
  assert.equal((await fetch(base+'/api/status',{headers:{...headers,Origin:'https://foreign.invalid'}})).status,403);
  const status=await(await fetch(base+'/api/status',{headers})).json();assert.equal(status.configured,false);assert.equal(calls,0);
  const saved=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({key:'synthetic.openai-key',model:'gpt-6-sol'})});
  assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes('synthetic.openai-key'));
  const config=await readOpenAIConfig(root);credentialFile=config.credentialFile;assert.ok(!credentialFile.startsWith(root));assert.equal(await readOpenAIKey(root,config),'synthetic.openai-key');
  assert.ok(!(await readFile(configPath(root),'utf8')).includes('synthetic.openai-key'));assert.equal(calls,1);
  assert.equal((await fetch(base+'/api/start',{method:'POST',headers,body:'{}'})).status,200);assert.equal(started,1);assert.equal(calls,1);
});
test('429 quota exhaustion and rate limiting have distinct safe messages', async()=>{
  for(const [code,pattern] of [['insufficient_quota',/可用额度不足/],['rate_limit_exceeded',/速率超限/],['unknown',/原因未明确/]]) {
    await assert.rejects(requestOpenAI({key:'test-key',model:'gpt-6-sol',input:[],fetcher:async()=>Response.json({error:{code,message:'test-key'}},{status:429})}),error=>pattern.test(error.message)&&!error.message.includes('test-key'));
  }
});
