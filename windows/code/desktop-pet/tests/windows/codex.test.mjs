import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexWindowsConnection } from '../../dist/harness/codex-windows.js';
const threadId='11111111-1111-4111-8111-111111111111', turnId='22222222-2222-4222-8222-222222222222', requestId='33333333-3333-4333-8333-333333333333';
async function fixture(t, mode='ok',options={}) {
 const dir=await mkdtemp(join(tmpdir(),'aaaagent-codex-')), log=join(dir,'rpc.jsonl');
 const script=`
  const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});
  const mode=process.env.MOCK_MODE,log=process.env.MOCK_LOG,threadId=${JSON.stringify(threadId)},turnId=${JSON.stringify(turnId)};
  const send=o=>console.log(JSON.stringify(o));
  let chatCount=0;
  rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
   if(!m.method)return;
   if(m.method==='initialized')return;
   if(m.method==='initialize')return send({id:m.id,result:{platformOs:'windows'}});
   if(m.method==='account/read')return send({id:m.id,result:{account:mode==='unauthenticated'?null:{type:'chatgpt'}}});
   if(m.method==='config/read')return send({id:m.id,result:{config:{mcp_servers:{test:{enabled:true}}}}});
   if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:threadId,ephemeral:true},model:'test-model'}});
   if(m.method==='turn/interrupt'){if(mode==='chat-dead-interrupt')return;send({id:m.id,result:{}});return setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id:m.params.turnId,status:'interrupted'}}}),75);}
   if(m.method==='thread/read'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:mode==='wrong-thread'?'other':threadId,status:{type:mode==='busy'?'active':'idle'},turns:[{id:turnId,status:mode==='interrupted'?'interrupted':'completed',items:[{type:'agentMessage',text:'中文完成'}]}]}}});
   if(m.method==='turn/start'){
    if(mode==='chat-dead-interrupt'){
     send({id:m.id,result:{turn:{id:turnId}}});
     if(fs.readFileSync(log,'utf8').split('\\n').filter(line=>line&&JSON.parse(line).method==='turn/start').length===1)return;
     send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text:'新连接的回复',phase:'final_answer'}}});
     return send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
    }
    if(mode==='chat-timeout'){
     const chatTurn=++chatCount===1?turnId:${JSON.stringify(requestId)};
     send({id:m.id,result:{turn:{id:chatTurn}}});if(chatCount===1)return;
     send({method:'item/completed',params:{threadId,turnId:chatTurn,item:{type:'agentMessage',text:'恢复后的回复',phase:'final_answer'}}});
     return send({method:'turn/completed',params:{threadId,turn:{id:chatTurn,status:'completed'}}});
    }
    if(mode==='lost')return;
    if(mode==='rejected')return send({id:m.id,error:{code:-1,message:'private server detail'}});
    if(mode==='approval')send({id:'approval',method:'item/commandExecution/requestApproval',params:{}});
    if(mode==='chat-stream'){
     send({id:m.id,result:{turn:{id:turnId}}});
     send({method:'item/started',params:{threadId,turnId,item:{id:'c',type:'agentMessage',phase:'commentary'}}});
     send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'c',delta:'internal'}});
     send({method:'item/started',params:{threadId,turnId,item:{id:'f',type:'agentMessage',phase:'final_answer'}}});
     send({method:'item/agentMessage/delta',params:{threadId,turnId:'wrong',itemId:'f',delta:'wrong'}});
     send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'f',delta:'中文'}});
     setTimeout(()=>{
      send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'f',delta:'聊天'}});
      send({method:'item/completed',params:{threadId,turnId,item:{id:'f',type:'agentMessage',text:'中文聊天',phase:'final_answer'}}});
      send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
     },60);return;
    }
    if(mode==='chat'){
     send({method:'item/completed',params:{threadId:'other',turnId,item:{type:'agentMessage',text:'wrong'}}});
     send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text:'internal',phase:'commentary'}}});
     send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text:'中文聊天',phase:'final_answer'}}});
     send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
    }
    return send({id:m.id,result:{turn:{id:turnId}}});
   }
  });
 `;
 const connection=new CodexWindowsConnection(dir,process.execPath,options.requestTimeoutMs??1000,()=>spawn(process.execPath,['-e',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,MOCK_MODE:mode,MOCK_LOG:log}}),options.replyTimeoutMs??60000);
 t.after(async()=>{await connection.close();await rm(dir,{recursive:true,force:true});});
 return {connection,async calls(){return(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);}};
}
test('Windows app-server authenticates, resumes exact target, starts once and reads exact receipt',async t=>{
 const f=await fixture(t),c=f.connection;
 assert.equal(await c.compatible(),true);assert.deepEqual(await c.discover(threadId),{available:true});
 assert.deepEqual(await c.send(threadId,'Test 中文',requestId),{threadId,turnId,requestId});
 assert.deepEqual(await c.receipt(threadId,turnId),{threadId,turnId,status:'completed',reply:'中文完成'});
 const calls=await f.calls();assert.equal(calls.filter(x=>x.method==='initialize').length,1);
 const start=calls.filter(x=>x.method==='turn/start');assert.equal(start.length,1);assert.equal(start[0].params.threadId,threadId);
 assert.equal(start[0].params.input[0].text,'Test 中文');assert.equal('approvalPolicy'in start[0].params,false);
});
test('ChatGPT chat creates an isolated ephemeral session and returns only its final message',async t=>{
 const f=await fixture(t,'chat');
 assert.deepEqual(await f.connection.openChat('C:/chat','性格：温柔；语气：简短'),{model:'test-model',ephemeral:true});
 assert.equal(await f.connection.chat('你好',new AbortController().signal),'中文聊天');
 const calls=await f.calls(), start=calls.find(x=>x.method==='thread/start');
 assert.equal(start.params.ephemeral,true);assert.equal(start.params.sandbox,'read-only');
 assert.match(start.params.baseInstructions,/性格：温柔；语气：简短/);
 assert.equal(start.params.config['features.shell_tool'],false);
 assert.equal(start.params.config['mcp_servers.test.enabled'],false);
 assert.equal(calls.some(x=>x.method==='thread/resume'),false);
 assert.equal(calls.filter(x=>x.method==='turn/start').length,1);
});
test('chat streams only current final-answer deltas before completion without duplicate text',async t=>{
 const f=await fixture(t,'chat-stream');await f.connection.openChat('C:/chat');
 let resolved=false;const deltas=[];
 const reply=f.connection.chat('你好',new AbortController().signal,delta=>{assert.equal(resolved,false);deltas.push(delta);});
 assert.equal(await reply,'中文聊天');resolved=true;assert.deepEqual(deltas,['中文','聊天']);
});

test('a stalled chat times out, interrupts once and permits the next explicit message',async t=>{
 const f=await fixture(t,'chat-timeout',{replyTimeoutMs:80});await f.connection.openChat('C:/chat');
 await assert.rejects(f.connection.chat('你好',new AbortController().signal),e=>e.reason==='timeout');
 assert.equal(await f.connection.chat('再试一次',new AbortController().signal),'恢复后的回复');
 const calls=await f.calls();assert.equal(calls.filter(x=>x.method==='turn/interrupt').length,1);assert.equal(calls.filter(x=>x.method==='turn/start').length,2);
});
test('an unresponsive interruption retires only the owned server and reconnects for the next explicit message',async t=>{
 const f=await fixture(t,'chat-dead-interrupt',{replyTimeoutMs:80,requestTimeoutMs:250});await f.connection.openChat('C:/chat');
 await assert.rejects(f.connection.chat('你好',new AbortController().signal),e=>e.reason==='timeout');
 assert.equal(await f.connection.chat('再试一次',new AbortController().signal),'新连接的回复');
 const calls=await f.calls();assert.equal(calls.filter(x=>x.method==='initialize').length,2);assert.equal(calls.filter(x=>x.method==='turn/start').length,2);assert.equal(calls.filter(x=>x.method==='turn/interrupt').length,1);
});
for(const mode of ['lost','rejected'])test('Windows send '+mode+' response stays unknown without retry',async t=>{
 const f=await fixture(t,mode);await assert.rejects(f.connection.send(threadId,'test',requestId),e=>e.code==='unknown_delivery');
 assert.equal((await f.calls()).filter(x=>x.method==='turn/start').length,1);
});
test('Windows compatibility rejects missing account and busy targets without a send',async t=>{
 const unauth=await fixture(t,'unauthenticated');assert.equal(await unauth.connection.compatible(),false);
 const busy=await fixture(t,'busy');assert.deepEqual(await busy.connection.discover(threadId),{available:false});
 await assert.rejects(busy.connection.send(threadId,'test',requestId),e=>e.code==='unavailable');
 assert.equal((await busy.calls()).some(x=>x.method==='turn/start'),false);
});
test('Windows receipt cannot accept another thread or turn',async t=>{
 const wrong=await fixture(t,'wrong-thread');assert.equal((await wrong.connection.receipt(threadId,turnId)).status,'unknown');
 const f=await fixture(t);assert.equal((await f.connection.receipt(threadId,requestId)).status,'unknown');
});
test('Windows interrupted turn stays unknown and invalid IDs fail before RPC',async t=>{
 const f=await fixture(t,'interrupted');assert.equal((await f.connection.receipt(threadId,turnId)).reason,'interrupted');
 await assert.rejects(f.connection.send('../bad','test',requestId),e=>e.code==='invalid_target');
 await assert.rejects(f.connection.send(threadId,'bad\0input',requestId),e=>e.code==='invalid_target');
});
test('Windows bridge declines tool approval instead of silently granting permissions',async t=>{
 const f=await fixture(t,'approval');await f.connection.send(threadId,'test',requestId);
 await f.connection.receipt(threadId,turnId);
 assert.deepEqual((await f.calls()).find(x=>x.id==='approval').result,{decision:'decline'});
});
