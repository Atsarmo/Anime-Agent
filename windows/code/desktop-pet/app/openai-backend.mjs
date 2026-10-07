import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexWindowsConnection } from '../dist/harness/codex-windows.js';
import { readOpenAIConfig, readOpenAIKey } from '../tools/openai-config.mjs';
import { requestOpenAI, OpenAIRequestError } from '../providers/openai-responses.mjs';
import { readPresentationCatalog } from '../dist/management/presentation.js';
import { DESKTOP_BRIDGE_VERSION } from '../dist/contracts/desktop-bridge.js';
import { COMPANION_ID } from '../dist/contracts/character.js';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const codexMode = process.env.PET_CHAT_MODE === 'codex';
let connection, config;
if (codexMode) {
  const workspace = resolve(root, '.local/codex-chat/workspace');
  await mkdir(workspace, { recursive: true });
  connection = new CodexWindowsConnection(process.env.CODEX_HOME || resolve(homedir(), '.codex'));
  config = await connection.openChat(workspace);
} else {
  config = await readOpenAIConfig(root);
// Check local readiness at startup; no inference request is made until a text is submitted.
  await readOpenAIKey(root, config);
}
const catalog = await readPresentationCatalog(root);
const sessionId = randomUUID(), expression = { emotion:'neutral',intensity:0,delivery:'',gesture:null };
let generation = 0, active = null, history = [];
let queued = Promise.resolve();
const send = message => process.stdout.write(JSON.stringify(message)+'\n');
const event = value => send({channel:'event',event:value});
send({channel:'backend_ready',bridgeVersion:DESKTOP_BRIDGE_VERSION,characterId:COMPANION_ID,sessionId,
  introduction:{id:codexMode?'codex-chat':'openai-chat',text:codexMode?`已连接 Codex · ${config.model}，使用已有 ChatGPT 登录。可以进行文字对话；上下文仅保留在本次临时会话，使用 Codex 额度。`:`已连接 OpenAI · ${config.model}。可以进行文字对话；上下文仅保留在本次会话。发送文字将调用 OpenAI API。`}});
send({channel:'presentation_policy',policy:{modelId:catalog.modelId,revision:0,
  enabledIds:catalog.items.filter(item=>item.availability==='automatic'&&item.defaultEnabled).map(item=>item.id)}});
const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line', line => {
  let message; try { message=JSON.parse(line); } catch { return; }
  if(message.channel!=='command')return;
  const command=message.command;
  if(command.type==='cancel') {
    active?.controller.abort();
    if(active) event({type:'presentation',presentation:{scope:active.scope,state:'idle',expression,mouth:0}});
    active=null;return;
  }
  if(command.type!=='submit_text') {
    if(['start_voice','click_invitation'].includes(command.type))event({type:'error',scope:null,message:'OpenAI 文字模式尚未接入语音，请使用文字输入。'});
    return;
  }
  if(typeof command.text!=='string'||!command.text.trim())return;
  active?.controller.abort();
  const scope={characterId:COMPANION_ID,sessionId,turnId:randomUUID(),generation:++generation};
  const controller=new AbortController(); active={scope,controller};
  event({type:'turn',input:{scope,kind:'text',startedAt:new Date().toISOString(),text:command.text,
    ...(command.clientRequestId?{clientRequestId:command.clientRequestId}:{})}});
  send({channel:'input_route',scope,route:'companion'});
  const previous = queued;
  queued = (async()=>{
    try {
      if(codexMode)await previous;
      if(controller.signal.aborted)return;
      if(command.text.length>16000)throw Error('输入过长，请分段发送（最多 16000 字符）。');
      const input=[...history,{role:'user',content:command.text}];
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]);
      const text=codexMode?await connection.chat(command.text,signal):await requestOpenAI({key:await readOpenAIKey(root,config),model:config.model,input,signal});
      if(active?.scope!==scope||controller.signal.aborted)return;
      history=[...input,{role:'assistant',content:text,phase:'final_answer'}].slice(-24);
      event({type:'reply',reply:{scope,text,expression}});
      event({type:'presentation',presentation:{scope,state:'idle',expression,mouth:0}});
    }catch(error){
      if(active?.scope!==scope||controller.signal.aborted)return;
      const safe=error instanceof OpenAIRequestError?error.message:error?.message?.startsWith('OpenAI')||error?.message?.startsWith('输入过长')?error.message:codexMode?'Codex 连接或响应失败；未自动重试。请检查 ChatGPT 登录、Codex 额度或网络后重新启动。':'OpenAI 连接或响应失败；未自动重试。请检查网络、账户或重新配置。';
      event({type:'error',scope,message:safe});
    }finally{if(active?.scope===scope)active=null;}
  })();
});
lines.on('close',()=>{active?.controller.abort();history=[];void connection?.close();});
