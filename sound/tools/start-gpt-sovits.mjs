import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, open, access } from 'node:fs/promises';
import { resolve, delimiter } from 'node:path';
import { runtimeRoot as root, soundRoot, voiceStateRoot } from '../src/paths.mjs';
import { createServer } from 'node:net';

const sdk=resolve(process.argv[2]||process.env.PET_GPTSOVITS_HOME||resolve(soundRoot,'.local/gpt-sovits'));
const directory=voiceStateRoot(root),port=9882;
await mkdir(directory,{recursive:true});
const stateFile=resolve(directory,'service.json');
try{
  const state=JSON.parse(await readFile(stateFile,'utf8'));process.kill(state.pid,0);
  const response=await fetch(`http://127.0.0.1:${port}/openapi.json`,{signal:AbortSignal.timeout(1500)});
  if(response.ok&&(await response.json()).paths?.['/tts']){console.log('声音服务已在运行：http://127.0.0.1:'+port);process.exit(0);}
  console.log('声音服务正在启动。日志：'+resolve(directory,'service.log'));process.exit(0);
}catch{}
const probe=createServer();await new Promise((done,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
let weights;
try{weights=JSON.parse(await readFile(resolve(soundRoot,'.local/gpt-sovits-models.json'),'utf8'));}
catch{throw Error('请复制 sound/examples/gpt-sovits-models.example.json 到 sound/.local/gpt-sovits-models.json，并填写自己的权重路径。');}
if(typeof weights.t2s_weights_path!=='string'||typeof weights.vits_weights_path!=='string')throw Error('GPT-SoVITS 权重配置无效。');
const custom={device:'cuda',is_half:true,version:'v5turbo',...weights,bert_base_path:'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',cnhuhbert_base_path:'GPT_SoVITS/pretrained_models/chinese-hubert-base'};
for(const path of ['runtime/python.exe','api_v2.py',custom.t2s_weights_path,custom.vits_weights_path,'GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth','GPT_SoVITS/pretrained_models/gsv-v5-pretrained/vocoder.pth'])await access(resolve(sdk,path));
// JSON is also valid YAML. Include v5 entries for LoRA's base-weight lookup.
const base={...custom,t2s_weights_path:'GPT_SoVITS/pretrained_models/s1v3.ckpt',vits_weights_path:'GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth'};
const configuration=resolve(directory,'tts-infer.yaml');await writeFile(configuration,JSON.stringify({custom,v5turbo:base,v5dev:{...base,version:'v5dev',vits_weights_path:'GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5dev.pth'}},null,2));
const log=await open(resolve(directory,'service.log'),'w');
const env={...process.env,PATH:resolve(sdk,'runtime')+delimiter+process.env.PATH,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'};
const child=spawn(resolve(sdk,'runtime/python.exe'),['-u',resolve(sdk,'api_v2.py'),'-a','127.0.0.1','-p',String(port),'-c',configuration],{cwd:sdk,env,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});
await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});child.unref();await log.close();
await writeFile(stateFile,JSON.stringify({pid:child.pid,sdk,port}));
console.log('正在加载天童爱丽丝 v5turbo。接口：http://127.0.0.1:'+port+'\n日志：'+resolve(directory,'service.log'));
