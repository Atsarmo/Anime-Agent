import { readFile, writeFile, mkdir, open, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { voiceLabRoot, voiceStateRoot } from './paths.mjs';

export const voiceEngines = [
  {id:'gpt-sovits',name:'现有声音 · GPT-SoVITS',description:'已训练的天童爱丽丝音色',mode:'已训练'},
  {id:'stylebert',name:'A · Style-Bert-VITS2',description:'日语专用微调，短句发声',mode:'试验微调'},
  {id:'cosyvoice',name:'B · CosyVoice 3',description:'参考音色克隆，分块发声',mode:'参考音色克隆'},
  {id:'fish',name:'C · Fish Speech S2 Pro',description:'参考音色克隆，比较自然度',mode:'参考音色克隆'},
  {id:'fish-finetuned',name:'C2 · Fish 爱丽丝微调',description:'新增日语素材训练，与原版 C 对照试听',mode:'实验微调'},
  {id:'rvc',name:'D · 日语 TTS + RVC',description:'先生成日语，再转换成爱丽丝音色',mode:'试验微调'},
];
export { voiceLabRoot };
async function json(path){try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}}
export async function listVoiceEngines(root){
  const lab=voiceLabRoot(root);
  return Promise.all(voiceEngines.map(async engine=>{
    if(engine.id==='gpt-sovits')return {...engine,ready:true,status:'可用'};
    const [setup,download,ready]=await Promise.all([json(resolve(lab,engine.id+'.status.json')),json(resolve(lab,engine.id+'.download.json')),json(resolve(lab,engine.id+'.ready.json'))]);
    const available=ready?.ready===true;
    let status=available?'可用':setup?.phase==='error'||download?.phase==='error'?'准备遇到问题':setup?.phase==='verifying'?'正在检验试听':setup?.phase==='training'?'正在训练音色':setup?.phase==='preprocessing'?'正在整理训练素材':download?.phase==='downloading'?`下载模型 ${download.completed}/${download.total}`:setup?.phase==='installed'&&download?.phase==='downloaded'?'正在准备音色':'正在配置环境';
    return {...engine,ready:available,status,metrics:ready?.metrics??null};
  }));
}
const operations={chat:Promise.resolve(),preview:Promise.resolve()};
const runFile=promisify(execFile);
async function releaseBaseline(root){
  const state=await json(resolve(voiceStateRoot(root),'service.json'));
  if(process.platform!=='win32'||!Number.isSafeInteger(state?.pid)||!state.sdk)return;
  // Stop only the exact service started by this app, with its saved configuration.
  await runFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ForEach-Object {if($_.ExecutablePath -eq $env:PET_OWNED_VOICE_EXE -and $_.CommandLine.Contains($env:PET_OWNED_VOICE_API) -and $_.CommandLine.Contains($env:PET_OWNED_VOICE_CONFIG)){Stop-Process -Id $_.ProcessId -Force}}`],{windowsHide:true,env:{...process.env,PET_OWNED_VOICE_EXE:resolve(state.sdk,'runtime/python.exe'),PET_OWNED_VOICE_API:resolve(state.sdk,'api_v2.py'),PET_OWNED_VOICE_CONFIG:resolve(voiceStateRoot(root),'tts-infer.yaml')}});
}
async function restoreBaseline(root,signal){
  const state=await json(resolve(voiceStateRoot(root),'service.json'));
  if(!state?.sdk)return;
  try{const r=await fetch('http://127.0.0.1:9882/openapi.json',{signal:AbortSignal.timeout(1200)});if(r.ok)return;}catch{}
  await runFile(process.execPath,[fileURLToPath(new URL('../tools/start-gpt-sovits.mjs',import.meta.url)),state.sdk],{windowsHide:true});
  for(let i=0;i<240;i++){
    signal?.throwIfAborted();
    try{const r=await fetch('http://127.0.0.1:9882/openapi.json',{signal:AbortSignal.timeout(1200)});if(r.ok)return;}catch{}
    await new Promise(done=>setTimeout(done,500));
  }
  throw Error('现有声音仍在加载，请稍后再试。');
}
async function health(state){
  if(state.file){const latest=await json(state.file);if(latest?.token===state.token&&latest.engine===state.engine){state.port=latest.port;state.pid=latest.pid;}}
  if(state.port===0)return null;
  try{const response=await fetch(workerURL(state)+'/health',{headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(1200)});return response.ok?await response.json():null;}catch{return null;}
}
function workerURL(state){const port=state.port??9883;if(!Number.isInteger(port)||port<1||port>65535)throw Error('本机声音端口无效。');return 'http://127.0.0.1:'+port;}
function alive(state){try{if(!Number.isSafeInteger(state?.pid))return false;process.kill(state.pid,0);return true;}catch{return false;}}
async function waitReady(state,signal){
  for(let i=0;i<240;i++){
    signal?.throwIfAborted();const result=await health(state);
    if(result?.ready)return state;
    if(result?.error)throw Error('声音模型加载失败，请查看本机声音服务日志。');
    if(!alive(state))throw Error('本机声音服务已退出，请重试。');
    await new Promise(done=>setTimeout(done,500));
  }
  throw Error('声音模型仍在加载，请稍后再试。');
}
export async function ensureVoiceEngine(root,engine,signal,{preview=false,onState=()=>{}}={}){
  if(!voiceEngines.some(e=>e.id===engine))throw Error('未知声音方案。');
  const purpose=preview?'preview':'chat';
  const job=operations[purpose].catch(()=>{}).then(async()=>{
    signal?.throwIfAborted();
    const lab=voiceLabRoot(root),entry=(await listVoiceEngines(root)).find(e=>e.id===engine);
    if(!entry.ready)throw Error('这套声音还在准备，请先使用已可用的方案。');
    const file=resolve(voiceStateRoot(root),preview?'preview-service.json':'engine-service.json');
    let state=await json(file);if(state)state.file=file;let current=state?await health(state):null;
    if(state?.engine===engine&&!current?.error&&(current||alive(state))){onState(state);return waitReady(state,signal);}
    if(!current&&alive(state)){
      for(let i=0;i<80&&!current;i++){signal?.throwIfAborted();await new Promise(done=>setTimeout(done,500));current=await health(state);}
      if(!current)throw Error('上一套声音服务仍在启动，请稍后切换。');
    }
    if(current){
      await fetch(workerURL(state)+'/shutdown',{method:'POST',headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(2500)}).catch(()=>{});
      for(let i=0;i<30&&await health(state);i++)await new Promise(done=>setTimeout(done,100));
    }
    if(engine==='gpt-sovits'){await restoreBaseline(root,signal);return null;}
    if(!preview)await releaseBaseline(root);
    const python=resolve(lab,'envs',engine==='fish-finetuned'?'fish':engine,'Scripts/python.exe');await access(python);
    await mkdir(dirname(file),{recursive:true});
    const token=randomBytes(32).toString('hex'),log=await open(resolve(lab,'logs',engine+(preview?'-preview':'')+'-service.log'),'a');
    const child=spawn(python,['-u',fileURLToPath(new URL('../engines/worker.py',import.meta.url)),'--lab',lab,'--engine',engine,'--port','0','--state-file',file],{cwd:lab,env:{...process.env,PYTHONUTF8:'1',PET_VOICE_TOKEN:token,HF_HOME:resolve(lab,'cache/hf'),TEMP:resolve(lab,'temp'),TMP:resolve(lab,'temp'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});
    await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});child.unref();await log.close();
    state={engine,token,pid:child.pid,port:0};await writeFile(file,JSON.stringify(state),{mode:0o600});state.file=file;
    onState(state);
    try{return await waitReady(state,signal);}catch(error){if(preview)await stopVoicePreview(root);throw error;}
  });operations[purpose]=job;return job;
}
export async function stopVoicePreview(root){
  const file=resolve(root,'.local/voice/preview-service.json'),state=await json(file);
  if(!state)return;
  if(await health(state))await fetch(workerURL(state)+'/shutdown',{method:'POST',headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(2500)}).catch(()=>{});
  // Covers cancellation during Python imports, before the HTTP server is bound.
  if(process.platform==='win32')await runFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ForEach-Object {if($_.CommandLine -and $_.CommandLine.Contains($env:PET_PREVIEW_WORKER) -and $_.CommandLine.Contains($env:PET_PREVIEW_STATE)){Stop-Process -Id $_.ProcessId -Force}}`],{windowsHide:true,timeout:5000,env:{...process.env,PET_PREVIEW_WORKER:fileURLToPath(new URL('../engines/worker.py',import.meta.url)),PET_PREVIEW_STATE:file}}).catch(()=>{});
}
export async function synthesizeEngine(root,config,text,signal,onChunk,{preview=false,timeoutMs=preview?180000:60000}={}){
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),timeoutMs);
  const bounded=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  let state;
  try{
  state=await ensureVoiceEngine(root,config.engine,bounded,{preview,onState:value=>{state=value;}});
  const response=await fetch(workerURL(state)+'/tts',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/json'},signal:bounded,body:JSON.stringify({text,speed:config.speed,fishExpression:config.fishExpression??'natural',stream:!!onChunk})});
  if(!response.ok)throw Error('声音合成失败，请检查这套方案的本机日志。');
  if(!onChunk){const chunks=[];let size=0;for await(const bytes of response.body){size+=bytes.length;if(size>12*1024*1024)throw Error('生成音频过长。');chunks.push(bytes);}return Buffer.concat(chunks);}
  let buffer='',size=0,any=false;
  const decoder=new TextDecoder();
  for await(const bytes of response.body){
    size+=bytes.length;if(size>17*1024*1024)throw Error('生成音频过长。');buffer+=decoder.decode(bytes,{stream:true});
    while(buffer.includes('\n')){
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
      const chunk=JSON.parse(line);if(chunk.error)throw Error('声音合成中断。');
      if(chunk.audio){const wav=Buffer.from(chunk.audio,'base64');if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('声音接口返回了无效音频。');any=true;await onChunk(wav);}
    }
  }
  if(buffer.trim()||!any)throw Error('声音接口未完整返回音频。');
  return null;
  }catch(error){
    // Aborting HTTP alone leaves CUDA generating while later replies queue behind it.
    // Retire only the authenticated worker that handled this request, never a replacement.
    if(bounded.aborted&&state){
      const current=await json(state.file);
      if(current?.token===state.token&&current.pid===state.pid&&current.engine===state.engine){
        state.port=current.port;
        if(!state.port)await health(state);
        if(state.port)
        await fetch(workerURL(state)+'/shutdown',{method:'POST',headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(2000)}).catch(()=>{});
      }
    }
    if(deadline.signal.aborted&&!signal?.aborted)throw Error('声音合成等待过久，已停止本轮语音。');
    throw error;
  }finally{clearTimeout(timer);}
}
