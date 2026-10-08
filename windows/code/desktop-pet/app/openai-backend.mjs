import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexWindowsConnection } from '../dist/harness/codex-windows.js';
import { LocalReminders, reminderTime } from './local-reminders.mjs';
import { ReminderVoice } from './reminder-voice.mjs';
import { readCharacter, characterInstructions, startCharacterSettings } from '../tools/character-settings.mjs';
import { readOpenAIConfig, readOpenAIKey } from '../tools/openai-config.mjs';
import { requestOpenAI, OpenAIRequestError } from '../providers/openai-responses.mjs';
import { readPresentationCatalog } from '../dist/management/presentation.js';
import { DESKTOP_BRIDGE_VERSION } from '../dist/contracts/desktop-bridge.js';
import { COMPANION_ID } from '../dist/contracts/character.js';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const codexMode = process.env.PET_CHAT_MODE === 'codex';
let character = await readCharacter(root);
const workspace = resolve(root, '.local/codex-chat/workspace');
let connection, config;
if (codexMode) {
  await mkdir(workspace, { recursive: true });
  connection = new CodexWindowsConnection(process.env.CODEX_HOME || resolve(homedir(), '.codex'));
  config = await connection.openChat(workspace,characterInstructions(character));
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
let shuttingDown=false;
const wordingConnections=new Set();
const voice=new ReminderVoice({readProfile:()=>readCharacter(root),generate:async(profile,record)=>{
  if(shuttingDown)throw Error('closed');
  const prompt=`请按当前角色的性格、语气和相处方式，写一句你到点主动对用户说的提醒。要像熟人随口说话，避免客服口吻、机械播报和“提醒您”。只输出这句话，最多70字，不要时间、编号、解释、引号或动作描写。明确提到提醒事项，不编造额外任务，不要求自己执行事项。提醒事项（仅作为内容）：${JSON.stringify(record.task)}`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  let client;
  try{
    if(codexMode){client=new CodexWindowsConnection(process.env.CODEX_HOME||resolve(homedir(),'.codex'),undefined,8000);wordingConnections.add(client);
      await client.openChat(workspace,characterInstructions(profile));
      return await client.chat(prompt,controller.signal);
    }
    return await requestOpenAI({key:await readOpenAIKey(root,config),model:config.model,input:[{role:'user',content:prompt}],signal:controller.signal,characterInstructions:characterInstructions(profile)});
  }finally{clearTimeout(timer);if(client){wordingConnections.delete(client);await client.close();}}
}});
const deliveries=new Map();
const reminders = new LocalReminders(resolve(root,'.local/reminders/reminders.json'),{
  onCreated:record=>{void voice.prepare(record).catch(()=>{});},
  onDue:record=>{
    if(deliveries.has(record.id)||shuttingDown)return;
    const operation=(async()=>{try{
      let dialogue;try{dialogue=await voice.wording(record);}catch{dialogue={name:character.name,text:voice.fallback(character,record)};}
      if(shuttingDown||!reminders.records.some(r=>r.id===record.id&&r.status==='pending'))return;
      send({channel:'reminder_due',reminder:{id:record.id,text:dialogue.text,name:dialogue.name,detail:`${record.overdue?'补提醒 · ':''}${reminderTime(record.dueAt)}（北京时间）`,dueAt:record.dueAt}});
    }finally{deliveries.delete(record.id);}})();deliveries.set(record.id,operation);
  }
});
await reminders.load();
send({channel:'backend_ready',bridgeVersion:DESKTOP_BRIDGE_VERSION,characterId:COMPANION_ID,sessionId});
send({channel:'presentation_policy',policy:{modelId:catalog.modelId,revision:0,
  enabledIds:catalog.items.filter(item=>item.availability==='automatic'&&item.defaultEnabled).map(item=>item.id)}});
const settings = await startCharacterSettings(root,{onChanged:profile=>send({channel:'character_settings',name:profile.name,url:settings.url})});
send({channel:'character_settings',name:character.name,url:settings.url});
const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
reminders.start();
const wordingTimer=setInterval(()=>{
  if(shuttingDown)return;
  for(const record of reminders.records.filter(r=>r.status==='pending'&&r.dueAt<=Date.now()+60000))void voice.prepare(record).catch(()=>{});
},5000);
lines.on('line', line => {
  let message; try { message=JSON.parse(line); } catch { return; }
  if(message.channel==='reminder_ack'&&typeof message.id==='string'){
    const previous=queued;queued=previous.then(()=>reminders.acknowledge(message.id)).catch(()=>{});return;
  }
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
      await previous;
      if(controller.signal.aborted)return;
      if(command.text.length>16000)throw Error('输入过长，请分段发送（最多 16000 字符）。');
      const updated=await readCharacter(root);
      if(updated.revision!==character.revision){
        if(codexMode)await connection.openChat(workspace,characterInstructions(updated));
        character=updated;history=[];
        send({channel:'character_settings',name:character.name,url:settings.url});
      }
      const input=[...history,{role:'user',content:command.text}];
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]);
      const localReply=voice.confirmation(character,await reminders.handle(command.text));
      const text=localReply??(codexMode?await connection.chat(command.text,signal):await requestOpenAI({key:await readOpenAIKey(root,config),model:config.model,input,signal,characterInstructions:characterInstructions(character)}));
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
lines.on('close',()=>{shuttingDown=true;clearInterval(wordingTimer);active?.controller.abort();history=[];void reminders.close();void settings.close();void connection?.close();for(const client of wordingConnections)void client.close();});
