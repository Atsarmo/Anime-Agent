import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeRoot, voiceStateRoot } from './paths.mjs';
import { voiceEngines, synthesizeEngine, ensureVoiceEngine, stopVoicePreview } from './voice-engines.mjs';
import { withChatSpeech } from './voice-activity.mjs';

export const defaultVoice={engine:'gpt-sovits',enabled:false,japaneseSubtitles:false,endpoint:'http://127.0.0.1:9882',referenceAudio:'',promptText:'',promptLanguage:'ja',textLanguage:'auto',speed:1,fishExpression:'natural'};
export const voiceFile=root=>resolve(voiceStateRoot(root),'config.json');
export function validateVoice(data){
  const result={enabled:data?.enabled===true,japaneseSubtitles:data?.japaneseSubtitles===true};
  result.engine=data?.engine??'gpt-sovits';
  result.fishExpression=data?.fishExpression??'natural';
  if(!['natural','warm','lively'].includes(result.fishExpression))throw Error('不支持这个语气。');
  if(!voiceEngines.some(engine=>engine.id===result.engine))throw Error('未知声音方案。');
  const endpoint=new URL(data?.endpoint);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('声音接口必须是本机 http://127.0.0.1:端口。');
  result.endpoint=endpoint.origin;
  for(const [key,max]of [['referenceAudio',1000],['promptText',4000]]){if(typeof data?.[key]!=='string'||data[key].length>max)throw Error('参考音频或台词格式无效。');result[key]=data[key].trim();}
  if(result.referenceAudio&&!isAbsolute(result.referenceAudio))throw Error('参考音频需要填写本机绝对路径。');
  if(!['ja','zh','en','ko','yue'].includes(data.promptLanguage)||!['auto','ja','zh','en','ko','yue'].includes(data.textLanguage))throw Error('不支持这个语音语言。');
  result.promptLanguage=data.promptLanguage;result.textLanguage=data.textLanguage;
  if(typeof data.speed!=='number'||!Number.isFinite(data.speed)||data.speed<.5||data.speed>2)throw Error('语速范围是 0.5～2。');result.speed=data.speed;
  if(result.enabled&&result.engine==='gpt-sovits'&&(!result.referenceAudio||!result.promptText))throw Error('启用声音前，请填写参考音频和对应原文。');
  return result;
}
export async function readVoice(root){
  try{const data=JSON.parse(await readFile(voiceFile(root),'utf8'));if(data.version!==1||typeof data.revision!=='string')throw Error();return {...validateVoice(data),revision:data.revision};}
  catch(error){if(error.code==='ENOENT')return {...defaultVoice,revision:'default'};throw Error('本地声音配置无法读取，请检查配置文件。');}
}
export async function saveVoice(root,data){
  const current=await readVoice(root);if(data.expectedRevision!==current.revision)throw Error('声音配置已被其他页面修改，请刷新后重试。');
  const profile={...validateVoice(data),revision:randomUUID()},file=voiceFile(root);
  await mkdir(dirname(file),{recursive:true});await writeFile(file+'.next',JSON.stringify({version:1,...profile}),{mode:0o600});await rename(file+'.next',file);return profile;
}
export async function synthesizeVoice(config,text,signal,options={}){
  const task=()=>synthesizeUnlocked(config,text,signal,options);
  return options.purpose==='preview'?task():withChatSpeech(task);
}
async function synthesizeUnlocked(config,text,signal,{root=runtimeRoot,onChunk,purpose='chat'}={}){
  const valid=validateVoice({...config,enabled:true});
  if(typeof text!=='string'||!text.trim()||text.length>1500)throw Error('语音文本需要在 1～1500 字以内。');
  if(valid.engine!=='gpt-sovits'){
    try{
      const audio=await synthesizeEngine(root,valid,text,signal,onChunk,{preview:purpose==='preview'});
      if(audio&&(audio.length>12*1024*1024||audio.length<44||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'))throw Error('声音接口没有返回有效 WAV 音频。');
      return audio;
    }finally{if(purpose==='preview')await stopVoicePreview(root);}
  }
  if(valid.endpoint==='http://127.0.0.1:9882')await ensureVoiceEngine(root,'gpt-sovits',signal,{preview:purpose==='preview'});
  const response=await fetch(valid.endpoint+'/tts',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(180000)]),body:JSON.stringify({text,text_lang:valid.textLanguage,ref_audio_path:valid.referenceAudio,prompt_text:valid.promptText,prompt_lang:valid.promptLanguage,media_type:'wav',streaming_mode:false,text_split_method:'cut5',batch_size:1,speed_factor:valid.speed,parallel_infer:false,use_cuda_graph:false})});
  if(!response.ok)throw Error('GPT-SoVITS 合成失败，请检查模型、参考音频和服务日志。');
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>12*1024*1024)throw Error('生成音频过长，请缩短回复。');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('声音接口没有返回有效 WAV 音频。');
  if(onChunk){await onChunk(bytes);return null;}return bytes;
}
export { voicePage, voiceScript } from './voice-page.mjs';
