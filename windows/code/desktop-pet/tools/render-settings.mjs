import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export const renderFile=root=>resolve(root,'.local/display/render.json');
export const renderMetricsFile=root=>resolve(root,'.local/display/metrics.json');
export function validateSamples(value){if(!Number.isInteger(value)||value<0||value>64)throw Error('SSAA 倍数必须是 0～64 的整数。');return value;}
export async function readRender(root){try{const p=JSON.parse(await readFile(renderFile(root),'utf8'));return {samples:validateSamples(p.samples),revision:p.revision};}catch(e){if(e.code==='ENOENT')return {samples:16,revision:'default'};throw e;}}
export async function saveRender(root,samples){validateSamples(samples);const p={samples,revision:randomUUID()},file=renderFile(root);await mkdir(dirname(file),{recursive:true});const next=file+'.'+p.revision+'.next';await writeFile(next,JSON.stringify(p));await rename(next,file);return p;}
export async function readRenderMetrics(root){try{const m=JSON.parse(await readFile(renderMetricsFile(root),'utf8'));return Date.now()-m.at<6000?m:null;}catch{return null;}}
export const renderPage=`<hr><h1>画面设置 · SSAA</h1><form id="render-form"><label for="render-samples">采样倍数（0～64×）</label><input id="render-samples" type="number" min="0" max="64" step="1" value="16" required><p>倍数按像素采样量计算：16× 为宽高各 4 倍，64× 为宽高各 8 倍。0 关闭超采样，1 为原生分辨率。硬件尺寸限制或每帧 3200 万像素预算可能降低实际倍数。</p><button>保存画面设置</button><p id="render-status" role="status"></p><p id="render-cost" role="status">等待桌宠渲染数据…</p><p>像素开销是相对原生分辨率的估算，不代表整张显卡占用率。GPU 帧耗时仅在驱动支持计时查询时显示。</p></form>`;
export const renderScript=`
async function renderApi(method='GET',body){const r=await fetch('/api/render',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
let renderEditing=false;get('render-samples').oninput=()=>renderEditing=true;
async function refreshRender(){try{const d=await renderApi();if(!renderEditing)get('render-samples').value=d.profile.samples;const m=d.metrics;get('render-cost').textContent=m?'GPU 像素开销估算：'+m.actualSamples.toFixed(1)+'×（约 '+(m.actualSamples*100).toFixed(0)+'% 原生像素量） · 渲染 '+m.width+' × '+m.height+' · GPU 帧耗时：'+(m.gpuMs===null?'当前驱动不可用':m.gpuMs.toFixed(2)+' ms')+(m.limited?' · 已受渲染尺寸限制':''):'桌宠未运行或正在加载，暂无 GPU 数据。';}catch(e){get('render-status').textContent=e.message;}}
get('render-form').onsubmit=async e=>{e.preventDefault();try{await renderApi('PUT',{samples:Number(get('render-samples').value)});renderEditing=false;get('render-status').textContent='已保存，桌宠实时生效。';await refreshRender();}catch(e){get('render-status').textContent=e.message;}};refreshRender();setInterval(refreshRender,2000);
`;
