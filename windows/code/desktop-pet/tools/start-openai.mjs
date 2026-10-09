import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readOpenAIConfig, readOpenAIKey } from './openai-config.mjs';
import { readVoice } from './voice-settings.mjs';
const root=fileURLToPath(new URL('../../..',import.meta.url));
export async function launchOpenAI(setupUrl, mode='openai') {
  if(mode!=='codex'){const config=await readOpenAIConfig(root);await readOpenAIKey(root,config);}
  const executable=createRequire(import.meta.url)('electron');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.PET_TRIAL_CONFIG;delete env.PET_TRIAL_ACTIVATION;
  if(setupUrl)env.PET_OPENAI_SETUP_URL=setupUrl;
  else delete env.PET_OPENAI_SETUP_URL;
  env.PET_CHAT_MODE=mode;
  try{
    const selectedVoice=await readVoice(root);
    if(selectedVoice.enabled){
      const voice=spawn(process.execPath,[fileURLToPath(new URL(selectedVoice.engine==='gpt-sovits'?'./start-gpt-sovits.mjs':'./start-voice-engine.mjs',import.meta.url))],{env,windowsHide:true,stdio:'ignore',detached:true});
      voice.on('error',()=>{});voice.unref();
    }
  }catch{}
  const child=spawn(executable,[fileURLToPath(new URL('../desktop/electron/main.mjs',import.meta.url)),
    '--root',fileURLToPath(new URL('../desktop/',import.meta.url)),
    '--backend',fileURLToPath(new URL('../app/openai-backend.mjs',import.meta.url)),'--node',process.execPath,'--openai-chat'],
    {env,windowsHide:true,stdio:'ignore',detached:true});
  await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});child.unref();
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{await launchOpenAI();}
  catch(error){if(error.code!=='ENOENT')throw error;const {startOpenAISetup}=await import('./configure-openai.mjs');const setup=await startOpenAISetup(root);console.log('请先完成 OpenAI 设置：\n'+setup.url);}
}
