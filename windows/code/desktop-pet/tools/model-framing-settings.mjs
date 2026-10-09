import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultFraming,validateFraming} from '../desktop/model-framing.mjs';
export const framingFile=root=>resolve(root,'.local/display/framing.json');
export async function readFraming(root){
  try{const p=JSON.parse(await readFile(framingFile(root),'utf8'));return {...validateFraming(p),revision:p.revision};}
  catch(error){if(error.code==='ENOENT')return {...validateFraming(defaultFraming),revision:'default'};throw error;}
}
export async function saveFraming(root,data){
  const current=await readFraming(root);
  if(data.expectedRevision!==current.revision)throw Error('角色画面已被其他页面修改，请刷新后重试。');
  const p={...validateFraming(data),revision:randomUUID()},file=framingFile(root);
  await mkdir(dirname(file),{recursive:true});const next=file+'.'+p.revision+'.next';
  await writeFile(next,JSON.stringify(p));await rename(next,file);return p;
}
export const framingPage=`<h2>角色大小与位置</h2><p>拖动矩形选框选择显示范围，拖动右下角调整大小。右侧即时预览，满意后再应用到桌宠。全身和半身分别保存。</p><form id="framing-form"><label for="framing-mode">要调整的视图</label><select id="framing-mode"><option value="half">半身</option><option value="full">全身</option></select><style>.framing-crop-layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;margin:20px 0}.framing-stage,.framing-output-wrap{background-color:#e0e6ef;background-image:linear-gradient(45deg,#d0d9e6 25%,transparent 25%),linear-gradient(-45deg,#d0d9e6 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d0d9e6 75%),linear-gradient(-45deg,transparent 75%,#d0d9e6 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;border-radius:12px;overflow:hidden}.framing-stage{position:relative;aspect-ratio:18/17;touch-action:none;user-select:none}.framing-stage canvas{position:absolute;width:100%;height:100%;inset:0}.framing-crop-box{position:absolute;border:2px solid white;box-sizing:border-box;box-shadow:0 0 0 800px #19253577;cursor:move;touch-action:none;min-width:12px;min-height:12px}.framing-crop-box:focus-visible{outline:2px solid #86b9ff}.framing-crop-handle{position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;border:1px solid #567fb3;background:white;border-radius:3px;cursor:nwse-resize}.framing-output-wrap canvas{display:block;width:100%;aspect-ratio:18/17}.framing-crop-layout small{display:block;margin:8px 0;color:#74849b}@media(max-width:580px){.framing-crop-layout{grid-template-columns:1fr}.framing-output-wrap{max-width:240px;margin:auto}}</style><div class="framing-crop-layout"><div><div id="framing-stage" class="framing-stage"><canvas id="framing-source" aria-label="角色原图"></canvas><div id="framing-selection" class="framing-crop-box" tabindex="0" role="group" aria-label="显示范围选框，可拖动或用方向键移动"><span id="framing-handle" class="framing-crop-handle" aria-hidden="true"></span></div></div><small>拖动选框移动范围，拖动右下角缩放</small></div><div><div class="framing-output-wrap"><canvas id="framing-output" aria-label="应用后的角色预览"></canvas></div><small>应用后的效果</small></div></div><p id="framing-preview-status" role="status">打开画面标签后加载预览…</p><label for="framing-scale">缩放 <output id="framing-scale-value"></output></label><input id="framing-scale" type="range" min="50" max="150" step="1"><label for="framing-x">左右位置 <output id="framing-x-value"></output></label><input id="framing-x" type="range" min="-40" max="40" step="1"><label for="framing-y">上下位置 <output id="framing-y-value"></output></label><input id="framing-y" type="range" min="-40" max="40" step="1"><p>左右位置：负数向左，正数向右。上下位置：负数向上，正数向下。移动量按画布大小的百分比计算。</p><button id="framing-save" disabled>应用到桌宠</button><button id="framing-reset" type="button" class="secondary">恢复当前视图默认值</button><p id="framing-status" role="status">正在读取…</p></form><hr>`;
export const framingScript=`
let framingProfile,framingMode='half',framingEditor,framingPreviewPromise;
function fillFraming(){if(!framingProfile)return;for(const key of ['scale','x','y']){get('framing-'+key).value=framingProfile[framingMode][key];get('framing-'+key+'-value').textContent=(Math.round(framingProfile[framingMode][key]*10)/10)+'%';}framingEditor?.setProfile(framingProfile,framingMode);}
get('framing-mode').onchange=()=>{framingMode=get('framing-mode').value;fillFraming();};
for(const key of ['scale','x','y'])get('framing-'+key).oninput=()=>{if(!framingProfile)return;framingProfile[framingMode][key]=Number(get('framing-'+key).value);fillFraming();get('framing-status').textContent='已调整，点击“应用到桌宠”后生效。';};
get('framing-reset').onclick=()=>{if(!framingProfile)return;framingProfile[framingMode]={scale:100,x:0,y:0};fillFraming();get('framing-status').textContent='已填入默认值，点击“应用到桌宠”后生效。';};
async function framingApi(method='GET',body){const r=await fetch('/api/framing',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error);return d.profile;}
framingApi().then(p=>{framingProfile=p;fillFraming();get('framing-save').disabled=false;get('framing-status').textContent='当前画面设置已读取。';if(!get('settings-render').hidden)loadFramingPreview();}).catch(e=>get('framing-status').textContent=e.message);
async function loadFramingPreview(){
 if(!framingProfile||framingEditor||framingPreviewPromise)return;
 get('framing-preview-status').textContent='正在加载角色预览…';
 framingPreviewPromise=(async()=>{
  const r=await fetch('/api/framing/preview',{headers:{Authorization:'Bearer '+token}});const assets=await r.json();if(!r.ok)throw Error(assets.error);
  if(!globalThis.Live2DCubismCore)await new Promise((done,reject)=>{const script=document.createElement('script');script.src=assets.core;script.onload=done;script.onerror=()=>reject(Error('预览组件加载失败。'));document.head.append(script);});
  const {createFramingEditor}=await import(assets.editor);
  framingEditor=await createFramingEditor({stage:get('framing-stage'),source:get('framing-source'),selection:get('framing-selection'),handle:get('framing-handle'),output:get('framing-output'),profile:framingProfile,mode:framingMode,onChange:value=>{framingProfile[framingMode]=value;fillFraming();get('framing-status').textContent='预览已更新，点击“应用到桌宠”后生效。';}});
  framingEditor.setProfile(framingProfile,framingMode);get('framing-preview-status').textContent='预览已就绪，可拖动选框。';
 })().catch(error=>{get('framing-preview-status').dataset.error=String(error.message);get('framing-preview-status').textContent='角色预览未能加载，可重新打开画面标签重试，或继续用下面的滑块调整。';}).finally(()=>framingPreviewPromise=null);
}
document.addEventListener('pet-settings-tab',event=>{if(event.detail==='render')loadFramingPreview();});
window.addEventListener('pagehide',()=>framingEditor?.dispose());
get('framing-form').onsubmit=async e=>{e.preventDefault();if(!framingProfile)return;get('framing-save').disabled=true;try{framingProfile=await framingApi('PUT',{...framingProfile,expectedRevision:framingProfile.revision});fillFraming();get('framing-status').textContent='已保存，桌宠实时生效。';}catch(error){get('framing-status').textContent=error.message;}finally{get('framing-save').disabled=false;}};
`;
