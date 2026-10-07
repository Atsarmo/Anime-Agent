import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeApiKey } from '../dist/core/api-key.js';
import { defaultOpenAIModel, readOpenAIConfig, saveOpenAIConfig } from './openai-config.mjs';
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>桌宠 · OpenAI 设置</title>
<style>body{font:16px system-ui;background:#edf3fa;color:#263c55;margin:0}main{max-width:560px;margin:8vh auto;background:white;padding:32px;border-radius:22px}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bfd0e0;border-radius:8px;font:inherit}button{margin:22px 8px 0 0;padding:12px 18px;border:0;border-radius:8px;background:#436fa5;color:white;cursor:pointer}button:disabled{opacity:.4}p{line-height:1.6}#status{white-space:pre-wrap}a{color:#436fa5}</style>
<main><h1>OpenAI 文字对话</h1><p>把桌宠连接到你的 OpenAI API。Key 仅保存在本机项目外的受限文件中。</p>
<p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">创建 OpenAI API Key</a></p>
<form id="form"><label for="key">API Key</label><input id="key" type="password" autocomplete="off" placeholder="粘贴你的 OpenAI API Key" required>
<label for="model">模型 ID</label><input id="model" value="gpt-6-sol" list="models" required><datalist id="models"></datalist>
<button id="save">验证 Key 并保存</button></form><p>验证只读取模型列表，不生成回复。启动后发送文字会按 OpenAI API 用量计费。</p>
<button id="start" disabled>启动桌宠</button><p id="status" role="status"></p>
<p>此入口支持文字对话与本次会话上下文。语音、长期记忆和定时提醒尚未接入。</p></main>
<script type="module">
const freshToken=new URLSearchParams(location.hash.slice(1)).get('token');if(freshToken)sessionStorage.setItem('openai-setup-token',freshToken);const token=freshToken||sessionStorage.getItem('openai-setup-token');history.replaceState(null,'',location.pathname);
const get=id=>document.getElementById(id), status=get('status');
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
try{const d=await api('/api/status');get('model').value=d.model;get('start').disabled=!d.configured;status.textContent=d.configured?'已有本机配置，可以启动桌宠。':'等待填写 API Key。';}catch(e){status.textContent=e.message;}
get('form').onsubmit=async e=>{e.preventDefault();get('save').disabled=true;status.textContent='正在验证…';try{const d=await api('/api/config',{key:get('key').value,model:get('model').value.trim()});get('key').value='';get('models').replaceChildren(...d.models.map(id=>{const o=document.createElement('option');o.value=id;return o;}));get('start').disabled=false;status.textContent='Key 验证通过，已保存。点击“启动桌宠”即可开始文字对话。';}catch(e){status.textContent=e.message;}finally{get('save').disabled=false;}};
get('start').onclick=async()=>{get('start').disabled=true;try{await api('/api/start',{});status.textContent='桌宠已启动。以后可双击 Start-OpenAI.cmd。';}catch(e){status.textContent=e.message;}finally{get('start').disabled=false;}};
</script></html>`;
export async function startOpenAISetup(root, { fetcher = fetch, onStart } = {}) {
  const token = randomBytes(32).toString('hex'); let base, busy = false;
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if (req.headers.host !== new URL(base).host || (req.headers.origin && req.headers.origin !== base)) return reply(403,{error:'仅允许本机设置页面访问。'});
    if(req.method==='GET'&&req.url==='/') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(page);return;
    }
    if(req.headers.authorization!=='Bearer '+token)return reply(401,{error:'设置会话已失效，请重新打开本机链接。'});
    try {
      if(req.method==='GET'&&req.url==='/api/status') {
        let config;try{config=await readOpenAIConfig(root);}catch(error){if(error.code!=='ENOENT')throw error;}
        return reply(200,{configured:Boolean(config),model:config?.model??defaultOpenAIModel});
      }
      if(req.method!=='POST'||!['/api/config','/api/start'].includes(req.url))return reply(404,{error:'未知设置操作。'});
      if(req.headers['content-type']!=='application/json')return reply(400,{error:'请求格式无效。'});
      if(busy)return reply(409,{error:'正在处理配置，请稍后再试。'});
      busy=true;
      try {
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Error('请求过大。');}
        const data=JSON.parse(raw);
        if(req.url==='/api/start') {
          await readOpenAIConfig(root);
          if(onStart)await onStart(base+'/#token='+token);
          else {const {launchOpenAI}=await import('./start-openai.mjs');await launchOpenAI(base+'/#token='+token);}
          return reply(200,{started:true});
        }
        const key=normalizeApiKey(data.key),model=data.model;
        if(!key||typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model))return reply(400,{error:'请输入完整 API Key 和模型 ID。'});
        const response=await fetcher('https://api.openai.com/v1/models',{redirect:'error',headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(30000)});
        if(!response.ok)return reply(400,{error:response.status===401?'API Key 无效，请核对。':`OpenAI 连接测试失败（HTTP ${response.status}），请检查权限、网络或账户。`});
        const result=await response.json(),models=(result.data??[]).map(item=>item.id).filter(id=>typeof id==='string').sort();
        if(!models.includes(model))return reply(400,{error:'当前 Key 的模型列表没有 '+model+'。请填写账户可用的模型 ID。',models});
        await saveOpenAIConfig(root,key,model);
        return reply(200,{configured:true,model,models:models.filter(id=>id.startsWith('gpt-'))});
      }finally{busy=false;}
    }catch {reply(400,{error:'配置操作失败，请检查网络和本机权限后重试。'});}
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  base='http://127.0.0.1:'+server.address().port;
  return {url:base+'/#token='+token,close:()=>new Promise((done,reject)=>server.close(error=>error?reject(error):done()))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../../..',import.meta.url));
  const setup=await startOpenAISetup(root);console.log('OpenAI 本机设置（保持运行）：\n'+setup.url);
  process.once('SIGINT',()=>void setup.close().then(()=>process.exit()));
}

