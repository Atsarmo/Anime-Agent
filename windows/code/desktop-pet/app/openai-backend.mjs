import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexWindowsConnection } from '../dist/harness/codex-windows.js';
import { LocalReminders, reminderTime } from './local-reminders.mjs';
import { handleMods, modInstructions, queryText } from '../mods/index.mjs';
import { AnimeBrowser } from '../mods/anime-browser.mjs';
import { ReminderVoice } from './reminder-voice.mjs';
import { readCharacter, characterInstructions, startCharacterSettings } from '../tools/character-settings.mjs';
import { readVoice, synthesizeVoice } from '../tools/voice-settings.mjs';
import { VoiceChunks } from './voice-chunks.mjs';
import { bilingualInstructions, BilingualSentences, localBilingualPrompt } from './bilingual-speech.mjs';
import { readOpenAIConfig, readOpenAIKey } from '../tools/openai-config.mjs';
import { requestOpenAI, OpenAIRequestError } from '../providers/openai-responses.mjs';
import { readPresentationCatalog } from '../dist/management/presentation.js';
import { DESKTOP_BRIDGE_VERSION } from '../dist/contracts/desktop-bridge.js';
import { COMPANION_ID } from '../dist/contracts/character.js';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const codexMode = process.env.PET_CHAT_MODE === 'codex';
let character = await readCharacter(root);
let chatVoice=await readVoice(root);
const chatInstructions=()=>characterInstructions(character)+'\n'+modInstructions+(chatVoice.enabled&&chatVoice.japaneseSubtitles?'\n'+bilingualInstructions:'');
const workspace = resolve(root, '.local/codex-chat/workspace');
let connection, config;
if (codexMode) {
  await mkdir(workspace, { recursive: true });
  connection = new CodexWindowsConnection(process.env.CODEX_HOME || resolve(homedir(), '.codex'));
  config = await connection.openChat(workspace,chatInstructions());
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
const animeBrowser=new AnimeBrowser(),pageRequests=new Map();
function openPage(url,signal) {
  return new Promise((done,reject)=>{
    signal?.throwIfAborted();
    const requestId=randomUUID();
    const finish=(ok)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pageRequests.delete(requestId);done(ok);};
    const abort=()=>{finish(false);};
    const timer=setTimeout(()=>finish(false),10000);
    pageRequests.set(requestId,finish);signal?.addEventListener('abort',abort,{once:true});
    send({channel:'open_anime_page',requestId,url});
  });
}
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
  if(message.channel==='anime_page_result'){pageRequests.get(message.requestId)?.(message.ok===true);return;}
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
      const voiceConfig=await readVoice(root);
      if(updated.revision!==character.revision||(voiceConfig.enabled&&voiceConfig.japaneseSubtitles)!==(chatVoice.enabled&&chatVoice.japaneseSubtitles)){
        character=updated;chatVoice=voiceConfig;
        if(codexMode)await connection.openChat(workspace,chatInstructions());
        history=[];
        send({channel:'character_settings',name:character.name,url:settings.url});
      }
      const input=[...history,{role:'user',content:command.text}];
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]);
      const reminderReply=voice.confirmation(character,await reminders.handle(command.text));
      const browserReply=reminderReply===null?await animeBrowser.handle(queryText(command.text,character.name),{signal,openPage}):null;
      const localReply=reminderReply??browserReply??await handleMods(command.text,{signal,characterName:character.name});
      if(localReply!==null)animeBrowser.remember(localReply);
      if(voiceConfig.enabled&&voiceConfig.japaneseSubtitles){
        const modelText=localReply===null?command.text:localBilingualPrompt(localReply);
        const modelInput=localReply===null?input:[...history,{role:'user',content:modelText}];
        if(localReply!==null)event({type:'reply',reply:{scope,text:localReply,expression}});
        let synthesis=Promise.resolve(),generationQueue=Promise.resolve(),failed=false;
        const jobs=new Map();
        const prepare=(ja,index)=>{
          if(jobs.has(index))return jobs.get(index);
          const stream=new VoiceChunks(controller.signal);
          const done=generationQueue.then(async()=>{
            if(failed||controller.signal.aborted||active?.scope!==scope){stream.end();return;}
            try{await synthesizeVoice({...voiceConfig,textLanguage:'ja'},ja,controller.signal,{root,onChunk:audio=>stream.push(audio)});}catch{failed=true;}finally{stream.end();}
          });
          const job={stream,done};jobs.set(index,job);generationQueue=done;return job;
        };
        const sentences=new BilingualSentences((sentence,index)=>{
          if(controller.signal.aborted||active?.scope!==scope)return;
          const audioJob=prepare(sentence.ja,index);
          synthesis=synthesis.then(async()=>{
            if(controller.signal.aborted||active?.scope!==scope)return;
            try{let chunkIndex=0;for await(const audio of audioJob.stream){
              if(!controller.signal.aborted&&active?.scope===scope){const id=randomUUID();send({channel:'speech_segment',index,chunkIndex:chunkIndex++,subtitle:sentence.zh,...(localReply!==null?{fullText:localReply}:{}),tts:{scope,audio:{id,uri:'pet-media:'+id,mimeType:'audio/wav',temporary:true},expression,durationMs:null,synchronization:'amplitude'},audioBase64:audio.toString('base64'),requestId:randomUUID()});}audio.fill(0);
            }
            }catch{failed=true;}
          });
        },prepare);
        let raw;
        try{
          raw=codexMode?await connection.chat(modelText,signal,delta=>sentences.push(delta)):await requestOpenAI({key:await readOpenAIKey(root,config),model:config.model,input:modelInput,signal,characterInstructions:chatInstructions()});
          if(!codexMode)sentences.push(raw);
          const items=sentences.finish();
          const verified=new BilingualSentences();verified.push(raw);verified.finish();
          if(JSON.stringify(verified.items)!==JSON.stringify(items))throw Error('双语回复发生变化');
          if(controller.signal.aborted||active?.scope!==scope)return;
          history=[...input,{role:'assistant',content:raw,phase:'final_answer'}].slice(-24);
          await synthesis;
          if(controller.signal.aborted||active?.scope!==scope)return;
          if(failed)event({type:'reply',reply:{scope,text:localReply??items.map(s=>s.zh).join('\n'),expression}});
          event({type:'presentation',presentation:{scope,state:'idle',expression,mouth:0}});
          if(failed)send({channel:'speech_error',scope,message:'日语语音未能及时完成，先看中文字幕吧。'});
        }catch(error){const cancelled=controller.signal.aborted;controller.abort();await synthesis;if(active?.scope===scope){send({channel:'speech_cancel',scope});event({type:'presentation',presentation:{scope,state:'idle',expression,mouth:0}});if(!cancelled){if(sentences.items.length)event({type:'reply',reply:{scope,text:localReply??sentences.items.map(s=>s.zh).join('\n'),expression}});send({channel:'speech_error',scope,message:error?.reason==='timeout'?'回复连接超时，这一轮已停止。连接恢复后可以重新发送。':'回复连接中断或双语内容不完整，已停止等待，请重新发送。'});}}}finally{await generationQueue;for(const job of jobs.values())job.stream.dispose();}
        return;
      }
      const text=localReply??(codexMode?await connection.chat(command.text,signal):await requestOpenAI({key:await readOpenAIKey(root,config),model:config.model,input,signal,characterInstructions:chatInstructions()}));
      if(active?.scope!==scope||controller.signal.aborted)return;
      history=[...input,{role:'assistant',content:text,phase:'final_answer'}].slice(-24);
      event({type:'reply',reply:{scope,text,expression}});
      let speechSent=false,speechFailed=false;
      try{
        if(voiceConfig.enabled&&!voiceConfig.japaneseSubtitles&&!controller.signal.aborted){
          const audio=await synthesizeVoice(voiceConfig,text,controller.signal,{root});
          if(active?.scope===scope&&!controller.signal.aborted){
            const id=randomUUID();send({channel:'play',requestId:randomUUID(),tts:{scope,audio:{id,uri:'pet-media:'+id,mimeType:'audio/wav',temporary:true},expression,durationMs:null,synchronization:'amplitude'},audioBase64:audio.toString('base64')});speechSent=true;
          }
          audio.fill(0);
        }
      }catch(error){speechFailed=true;}
      if(active?.scope===scope&&!controller.signal.aborted&&!speechSent){
        event({type:'presentation',presentation:{scope,state:'idle',expression,mouth:0}});
        if(speechFailed)send({channel:'speech_error',scope,message:'声音合成失败，文字回复已保留。请在角色设置中检查声音服务和参考音频。'});
      }
    }catch(error){
      if(active?.scope!==scope||controller.signal.aborted)return;
      const safe=error?.reason==='timeout'?'回复连接超时，这一轮已停止。连接恢复后可以重新发送。':error instanceof OpenAIRequestError?error.message:error?.message?.startsWith('OpenAI')||error?.message?.startsWith('输入过长')?error.message:codexMode?'Codex 连接或响应失败；未自动重试。请检查 ChatGPT 登录、Codex 额度或网络后重新启动。':'OpenAI 连接或响应失败；未自动重试。请检查网络、账户或重新配置。';
      event({type:'error',scope,message:safe});
    }finally{if(active?.scope===scope)active=null;}
  })();
});
lines.on('close',()=>{shuttingDown=true;clearInterval(wordingTimer);active?.controller.abort();history=[];void reminders.close();void settings.close();void connection?.close();for(const client of wordingConnections)void client.close();});
