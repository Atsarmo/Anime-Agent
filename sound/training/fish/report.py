import html
import json
from pathlib import Path
from paths import ROOT, LAB, ENGINE_ROOT

rows=json.loads((ROOT/'evaluation-assessed.json').read_text('utf8'))
summary=json.loads((ROOT/'data-summary.json').read_text('utf8'))
valid=list(map(json.loads,(ROOT/'results/validation.jsonl').read_text('utf8').splitlines()))
loss={r['step']:r['validation_loss'] for r in valid}
models=[('baseline','原版 C · 参考音色',0),('step50','微调 50 步',50),('step100','微调 100 步',100),('step200','微调 200 步 · C2',200)]
sentences=[r for r in rows if r['model']=='baseline']
body=''
for sentence in sentences:
    cells=''
    for model,label,step in models:
        row=next(r for r in rows if r['model']==model and r['id']==sentence['id'])
        cells+='<article><strong>'+label+'</strong><audio controls preload="none" src="samples/'+model+'/'+row['id']+'.wav"></audio><small>首段 '+str(round(row['first_audio_ms']/1000,2))+' 秒 · 音频 '+str(round(row['seconds'],2))+' 秒</small><details><summary>独立识别结果</summary>'+html.escape(row['whisper'])+'</details></article>'
    body+='<section><h2>'+html.escape(sentence['zh'])+'</h2><p lang="ja">'+html.escape(sentence['text'])+'</p><div class="grid">'+cells+'</div></section>'
metrics=''.join('<div><b>'+label+'</b><p>验证损失 '+str(round(loss[step],3))+'</p></div>' for model,label,step in models)
page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>爱丽丝 · Fish 微调试听</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#27384f;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1200px;margin:auto;padding:36px 24px 70px}h1{font-size:32px;margin-bottom:8px}h2{font-size:20px;margin:0}p{margin:8px 0}.tag{background:#e2ebfc;color:#315487;border-radius:20px;padding:4px 14px;font-size:14px}.intro,section{background:white;border:1px solid #e1e6ef;border-radius:18px;padding:24px;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:18px}article{border:1px solid #e1e7f0;border-radius:12px;padding:14px;background:#fafcff}article:last-child{border-color:#89a8de}audio{width:100%;margin:16px 0 4px}small{display:block;color:#63758c}details{font-size:13px;margin-top:12px}a{color:#365d9b}footer{font-size:14px;color:#61738a}button{border:1px solid #a7bce0;background:white;border-radius:8px;padding:9px 16px;color:#365d9b;cursor:pointer}@media(max-width:950px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:530px){.grid{grid-template-columns:1fr}main{padding:20px 12px}}html{color-scheme:light}
</style><main><span class="tag">日语发声 · 中文对照 · 本机实验</span><h1>爱丽丝的声音，训练前后</h1><p>同一句台词、同一段参考音频、相同采样设置。先听原版，再听微调版。</p><div class="intro"><b>这一轮完成了什么</b><p>下载 322 条游戏日语语音（约 24.8 分钟），经去重和台词交叉检查，合并此前素材后选用 206 段（约 17.3 分钟）。187 段训练、19 段验证。只微调 Fish S2 Pro 的 Fast AR，原版 C 保留。</p><p>20 条对照音频的独立识别都能还原测试台词，未发现波形削顶。自动识别无法证明音色更像，也不等于人工听音校对。C2 为实验版，请以听感选择。</p><div class="grid">'''+metrics+'''</div><p>模型已完成 200 步微调。声音设置新增「C2 · Fish 爱丽丝微调」，当前选择仍保持原版 C。微调主要尝试改善音色，出声时间没有稳定提升。</p><button id="stop">停止所有试听</button></div>'''+body+'''<footer><p>素材来源：<a href="https://kivo.wiki/data/character/108?mode=voice" target="_blank">普通版</a> · <a href="https://kivo.wiki/data/character/152?mode=voice" target="_blank">女仆版</a> · <a href="https://kivo.wiki/data/character/574?mode=voice" target="_blank">临战版</a>。日文台词另与 wikiru.jp 对照；有疑问的片段已排除。数据、来源清单、检查记录及训练权重保存在本机 voice-lab，未提交 Git 或上传模型。</p></footer></main><script>const players=[...document.querySelectorAll('audio')];for(const a of players)a.addEventListener('play',()=>{for(const b of players)if(b!==a)b.pause()});document.querySelector('#stop').onclick=()=>players.forEach(a=>a.pause());</script></html>'''
expression_file=ROOT/'expression-asr.json'
if expression_file.exists():
    expressions=json.loads(expression_file.read_text('utf8'))
    expression_body='<section><h2>给声音加一点情绪</h2><p>同一份 C2 权重。对比原版参考与更亲近的原声参考、语气引导。音色和情绪的好坏以试听为准。</p>'
    for sample,title in [('greeting','欢迎回来'),('water','喝水提醒'),('rest','陪你休息')]:
        expression_body+='<h3>'+title+'</h3><div class="grid">'
        for style,label in [('natural','原版语气'),('warm','亲近一点 · 温柔有起伏'),('lively','活泼一点 · 更有精神')]:
            row=next(r for r in expressions if r['model']=='expression-'+style and r['id']==sample)
            expression_body+='<article><strong>'+label+'</strong><audio controls preload="none" src="samples/expression-'+style+'/'+sample+'.wav"></audio><details><summary>独立识别结果</summary>'+html.escape(row['whisper'])+'</details></article>'
        expression_body+='</div>'
    expression_body+='<p>声音设置中的「说话语气」可以切换这三档。语气指令只用于合成，不会显示在中文字幕中。</p></section>'
    page=page.replace('<div class="intro">',expression_body+'<div class="intro">',1)
(ROOT/'试听对比.html').write_text(page,'utf8')
print('Comparison report saved')
