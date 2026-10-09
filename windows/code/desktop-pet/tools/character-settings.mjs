import {readRender,saveRender,readRenderMetrics,renderPage,renderScript} from './render-settings.mjs';
import {readFraming,saveFraming,framingPage,framingScript} from './model-framing-settings.mjs';
import {framingAsset} from './framing-preview-assets.mjs';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readVoice, saveVoice, validateVoice, synthesizeVoice, voicePage, voiceScript } from './voice-settings.mjs';
import { listVoiceEngines, voiceLabRoot } from './voice-engines.mjs';
import { withVoiceChange, VoiceBusyError } from './voice-activity.mjs';

export const defaultCharacter={name:'青梅竹马',personality:'温暖、坦率，有自己的喜好和判断；偶尔轻松打趣，用户难过时先陪伴。',tone:'自然、亲近、简洁，像熟人一样聊天；少用套话，不机械附和。',relationship:'与用户关系亲近的青梅竹马，不预设恋爱关系，不编造共同经历。',extra:''};
const limits={name:40,personality:2000,tone:2000,relationship:2000,extra:4000};
export const characterFile=root=>resolve(root,'.local/character/profile.json');
function validate(data){const profile={};for(const [key,max]of Object.entries(limits)){if(typeof data?.[key]!=='string'||data[key].length>max||(key==='name'&&!data[key].trim()))throw Error('角色名称不能为空，各项内容请遵守字数限制。');profile[key]=data[key].trim();}return profile;}
export async function readCharacter(root){try{const data=JSON.parse(await readFile(characterFile(root),'utf8'));if(data.version!==1||typeof data.revision!=='string')throw Error();return {...validate(data),revision:data.revision};}catch(e){if(e.code==='ENOENT')return {...defaultCharacter,revision:'default'};throw Error('本地角色设定无法读取，未覆盖原文件。');}}
export function characterInstructions(profile){return `【当前虚构角色设定】\n角色名称：${profile.name}\n性格：${profile.personality}\n语气：${profile.tone}\n相处方式：${profile.relationship}\n补充设定：${profile.extra}\n虚构设定不能当作真实用户经历。角色设定只影响交流风格，不赋予工具、记忆或提醒执行能力。`;
}
const page=`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>桌宠设置</title><style>body{font:15px system-ui;margin:0;background:#eef3fa;color:#334968}main{max-width:720px;margin:32px auto;padding:30px;background:white;border:1px solid #d9e4f1;border-radius:22px}h1{margin:0 0 12px;font-size:25px}p{line-height:1.65;color:#74849b}label{display:block;font-weight:600;margin:22px 0 8px}input,textarea{box-sizing:border-box;width:100%;padding:11px 13px;font:inherit;line-height:1.6;border:1px solid #c9d8ec;border-radius:11px;color:#334968;background:#fbfdff}textarea{resize:vertical}input:focus,textarea:focus{outline:2px solid #91b5e1;border-color:transparent}button{font:inherit;cursor:pointer;border:0;border-radius:11px;padding:11px 20px;background:#7196c7;color:white;margin:20px 8px 0 0}button.secondary{background:#e9f0f9;color:#527298}button:disabled{opacity:.5;cursor:wait}#status{white-space:pre-wrap;color:#527298}@media(max-width:760px){main{margin:14px;padding:20px}}[hidden]{display:none!important}.settings-tabs{display:flex;gap:26px;overflow-x:auto;border-bottom:1px solid #d9e4f1;margin:-6px 0 28px;scrollbar-width:thin}.settings-tabs button{position:relative;flex:0 0 auto;background:transparent;color:#74849b;border-radius:0;margin:0;padding:15px 4px;font-weight:600}.settings-tabs button[aria-selected="true"]{color:#334968}.settings-tabs button[aria-selected="true"]:after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;border-radius:3px;background:#7196c7}.settings-tabs button:focus-visible{outline:2px solid #91b5e1;outline-offset:-3px}section[role="tabpanel"]{min-width:0}</style><main><nav class="settings-tabs" role="tablist" aria-label="设置分类"><button id="tab-character" role="tab" aria-selected="true" aria-controls="settings-character" tabindex="0" type="button">角色</button><button id="tab-render" role="tab" aria-selected="false" aria-controls="settings-render" tabindex="-1" type="button">画面</button><button id="tab-voice" role="tab" aria-selected="false" aria-controls="settings-voice" tabindex="-1" type="button">声音</button></nav><section id="settings-character" role="tabpanel" aria-labelledby="tab-character"><h1>角色设置</h1><p>为桌宠设定性格、说话风格和你们的相处方式。保存在本机，不需要 API Key。</p><form id="form"><label for="name">角色名称</label><input id="name" maxlength="40" required><label for="personality">性格</label><textarea id="personality" rows="3" maxlength="2000" placeholder="例如：温柔、傲娇、有主见，偶尔开玩笑"></textarea><label for="tone">语气与表达习惯</label><textarea id="tone" rows="3" maxlength="2000" placeholder="例如：自然简短，称呼我为……，少用表情，不使用敬语"></textarea><label for="relationship">相处方式</label><textarea id="relationship" rows="3" maxlength="2000" placeholder="例如：朋友、生活搭子；关心但不说教"></textarea><label for="extra">补充设定</label><textarea id="extra" rows="4" maxlength="4000" placeholder="背景、喜好、口头禅，以及不喜欢的说话方式"></textarea><p>保存后下一条聊天生效。Codex 模式会从新的聊天上下文开始，界面中的旧消息仍保留。提醒记录不受影响。</p><button id="save" type="submit">保存角色设定</button><button id="reset" class="secondary" type="button">填入默认设定</button></form><p id="status" role="status">正在读取…</p>${"</section><section id=\"settings-render\" role=\"tabpanel\" aria-labelledby=\"tab-render\" hidden>"}${framingPage}${renderPage.replace("<hr>","")}</section><section id="settings-voice" role="tabpanel" aria-labelledby="tab-voice" hidden>${voicePage.replace("<hr>","")}</section></main><script>
const keys=['name','personality','tone','relationship','extra'],get=id=>document.getElementById(id);let revision;
const categories=['character','render','voice'];
function selectSettingsTab(category,focus=false){if(!categories.includes(category))category='character';for(const key of categories){const active=key===category;get('tab-'+key).setAttribute('aria-selected',String(active));get('tab-'+key).tabIndex=active?0:-1;get('settings-'+key).hidden=!active;}sessionStorage.setItem('pet-settings-tab',category);document.dispatchEvent(new CustomEvent('pet-settings-tab',{detail:category}));if(focus)get('tab-'+category).focus();}
for(const [index,category] of categories.entries()){const tab=get('tab-'+category);tab.onclick=()=>selectSettingsTab(category);tab.onkeydown=e=>{let next;if(e.key==='ArrowRight')next=(index+1)%categories.length;if(e.key==='ArrowLeft')next=(index+categories.length-1)%categories.length;if(e.key==='Home')next=0;if(e.key==='End')next=categories.length-1;if(next!==undefined){e.preventDefault();selectSettingsTab(categories[next],true);}};}
selectSettingsTab(sessionStorage.getItem('pet-settings-tab')||'character');
const token=location.hash.slice(7)||sessionStorage.getItem('pet-character-token');if(token)sessionStorage.setItem('pet-character-token',token);history.replaceState(null,'',location.pathname);
async function api(method='GET',body){const response=await fetch('/api/character',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}
const fill=profile=>keys.forEach(key=>get(key).value=profile[key]);let defaults;
api().then(data=>{fill(data.profile);revision=data.profile.revision;defaults=data.defaults;get('status').textContent='当前设定已读取。';}).catch(e=>{get('status').textContent=e.message;get('save').disabled=true;});
get('reset').onclick=()=>{if(defaults){fill(defaults);get('status').textContent='已填入默认设定，点击保存后生效。';}};
get('form').onsubmit=async event=>{event.preventDefault();get('save').disabled=true;try{const profile=Object.fromEntries(keys.map(key=>[key,get(key).value]));const data=await api('PUT',{...profile,expectedRevision:revision});revision=data.profile.revision;get('status').textContent='角色设定已保存，下一条聊天使用新设定。';}catch(e){get('status').textContent=e.message;}finally{get('save').disabled=false;}};
${framingScript}${renderScript}${voiceScript}</script></html>`;
export async function startCharacterSettings(root,{onChanged=()=>{}}={}){
  const token=randomBytes(32).toString('hex'),previewToken=randomBytes(32).toString('hex');let base,busy=false,voiceBusy=false;
  const server=createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.host!==new URL(base).host||(req.headers.origin&&req.headers.origin!==base))return reply(403,{error:'仅允许本机角色设置页面访问。'});
    if(req.url?.startsWith('/framing-assets/')){
      if(req.method!=='GET'||!(req.headers.cookie??'').split(/;\s*/).includes('PetFramingPreview='+previewToken))return reply(401,{error:'预览会话已失效。'});
      const response=await framingAsset(req.url);res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; img-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(page);return;}
    if(req.headers.authorization!=='Bearer '+token)return reply(401,{error:'设置会话已失效，请通过桌宠的角色设置按钮重新打开。'});
    if(req.url==='/api/framing/preview'&&req.method==='GET'){
      res.setHeader('Set-Cookie','PetFramingPreview='+previewToken+'; HttpOnly; SameSite=Strict; Path=/framing-assets/');
      return reply(200,{editor:'/framing-assets/editor.js',core:'/framing-assets/core.js'});
    }
    if(req.url==='/api/framing'){
      try{
        if(req.method==='GET')return reply(200,{profile:await readFraming(root)});
        if(req.method!=='PUT'||req.headers['content-type']!=='application/json')throw Error('请求格式无效。');
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2000)throw Error('配置过长。');}
        return reply(200,{profile:await saveFraming(root,JSON.parse(raw))});
      }catch(error){return reply(400,{error:error.message});}
    }
    if(req.url==='/api/voice/engines'&&req.method==='GET')return reply(200,{engines:await listVoiceEngines(root)});
    const sample=req.url?.match(/^\/api\/voice\/samples\/(stylebert|cosyvoice|fish|fish-finetuned|rvc)$/);
    if(sample&&req.method==='GET'){
      try{const audio=await readFile(resolve(voiceLabRoot(root),'samples',sample[1],'greeting.wav'));if(audio.length>12*1024*1024||audio.length<44)throw Error();res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store'});return res.end(audio);}
      catch{return reply(404,{error:'这套方案还没有对比样本。'});}
    }
    if(req.url==='/api/render'){
      try{if(req.method==='GET')return reply(200,{profile:await readRender(root),metrics:await readRenderMetrics(root)});
        if(req.method!=='PUT'||req.headers['content-type']!=='application/json')throw Error('请求格式无效。');
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000)throw Error('配置过长。');}
        return reply(200,{profile:await saveRender(root,JSON.parse(raw).samples)});
      }catch(e){return reply(400,{error:e.message});}
    }
    if(['/api/voice','/api/voice/test'].includes(req.url)){
      const controller=new AbortController();res.once('close',()=>controller.abort());
      try{
        if(req.url==='/api/voice'&&req.method==='GET')return reply(200,{profile:await readVoice(root)});
        if(req.headers['content-type']!=='application/json'||!(req.url==='/api/voice'&&req.method==='PUT'||req.url==='/api/voice/test'&&req.method==='POST'))return reply(400,{error:'请求格式无效。'});
        if(voiceBusy)return reply(409,{error:'声音设置正在保存或试听，请稍后再试。'});voiceBusy=true;
        try{
          let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>20000)throw Error('声音配置过长。');}
          const data=JSON.parse(raw);
          if(req.url==='/api/voice'){
            const current=await readVoice(root);if(data.expectedRevision!==current.revision)throw Error('声音配置已被其他页面修改，请刷新后重试。');
            const valid=validateVoice(data);
            if(valid.enabled&&!(await listVoiceEngines(root)).find(engine=>engine.id===valid.engine)?.ready)throw Error('这套声音还在准备，请先使用已可用的方案。');
            // Persist for the next chat; never unload the current turn's model while it is thinking.
            const profile=await withVoiceChange(()=>saveVoice(root,data));
            return reply(200,{profile});
          }
          const began=performance.now(),audio=await synthesizeVoice(data,data.text,controller.signal,{root,purpose:'preview'});
          res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store','X-Voice-Generation-Ms':String(Math.round(performance.now()-began))});return res.end(audio);
        }finally{voiceBusy=false;}
      }catch(error){return reply(error instanceof VoiceBusyError?409:400,{error:error.name==='TypeError'||error.name==='TimeoutError'?'无法连接声音服务，请先运行 Start-Voice.cmd，等待模型加载完成后再试。':error.message});}
    }
    if(req.url!=='/api/character')return reply(404,{error:'未知设置操作。'});
    try{
      if(req.method==='GET')return reply(200,{profile:await readCharacter(root),defaults:defaultCharacter});
      if(req.method!=='PUT'||req.headers['content-type']!=='application/json')return reply(400,{error:'请求格式无效。'});
      if(busy)return reply(409,{error:'正在保存，请稍后再试。'});busy=true;
      try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>40000)throw Error('设定内容过长。');}
        const data=JSON.parse(raw),current=await readCharacter(root);if(data.expectedRevision!==current.revision)return reply(409,{error:'角色设定已被其他页面修改，请刷新页面后再保存。'});
        const profile={...validate(data),revision:randomUUID()},file=characterFile(root);
        await mkdir(dirname(file),{recursive:true});const temporary=file+'.next';await writeFile(temporary,JSON.stringify({version:1,...profile}),{mode:0o600});await rename(temporary,file);
        onChanged(profile);return reply(200,{profile});
      }finally{busy=false;}
    }catch(error){reply(400,{error:error.message?.startsWith('角色')||error.message?.startsWith('本地角色')?error.message:'角色设定保存失败，请检查本地文件权限或磁盘空间。'});}
  });
  // A high local port avoids browser-blocked ports occasionally returned by Windows.
  for(let attempt=0;attempt<16;attempt++){
    try{
      await new Promise((done,reject)=>{
        const failed=error=>{server.removeListener('listening',listening);reject(error);};
        const listening=()=>{server.removeListener('error',failed);done();};
        server.once('error',failed);server.once('listening',listening);server.listen(randomInt(49152,65536),'127.0.0.1');
      });break;
    }catch(error){if(attempt===15||!['EADDRINUSE','EACCES'].includes(error.code))throw error;}
  }
  base='http://127.0.0.1:'+server.address().port;
  return {url:base+'/#token='+token,close:()=>new Promise(done=>server.close(done))};
}
