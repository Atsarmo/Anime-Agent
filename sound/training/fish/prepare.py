import collections
import csv
import difflib
import hashlib
import html
import json
from pathlib import Path
import re
import unicodedata

import numpy as np
import soundfile as sf
from bs4 import BeautifulSoup
from pykakasi import kakasi

from paths import ROOT, LAB, ENGINE_ROOT
KANA = kakasi()
def norm(text):
    return re.sub(r'[^\wぁ-んァ-ヶ一-龯ー]', '', unicodedata.normalize('NFKC', text)).lower()
def reading(text):
    return norm(''.join(x['hira'] for x in KANA.convert(text)))
def score(a,b):
    return difflib.SequenceMatcher(None, reading(a), reading(b)).ratio()

def main():
    references = {}
    for student, path in [(108, LAB/'corpus/wiki-jp.html'), (152, ROOT/'jp-maid.html'), (574, ROOT/'jp-battle.html')]:
        soup = BeautifulSoup(path.read_text('utf8'), 'html.parser')
        tables = [t for t in soup.select('table') if '絆ランク増加1' in t.get_text() and 'カフェ1' in t.get_text() and len(t.get_text()) < 15000]
        lines = []
        for table in tables:
            for tr in table.select('tr'):
                cells=tr.find_all(['td','th'],recursive=False)
                if len(cells)>=2:
                    text = cells[-1].get_text(' ',strip=True)
                    if re.search('[ぁ-んァ-ヶ]', text):lines.append(text)
        references[student] = lines
    asr = {r['id']:r for r in map(json.loads,(ROOT/'asr.jsonl').read_text('utf8').splitlines())}
    rows = list(map(json.loads, (ROOT/'sources.jsonl').read_text('utf8').splitlines()))
    existing = [r for r in map(json.loads,(LAB/'corpus/reviewed.jsonl').read_text('utf8').splitlines()) if r['train_approved']]
    seen_hash=set();seen_text=set();approved=[]
    # Clean single game files are preferred over slices from a compilation video.
    for row in rows:
        row['train_approved']=False
        row['whisper']=asr.get(row['id'],{}).get('whisper','')
        reason=''
        if not row.get('downloaded'):reason='下载失败'
        elif not 1.6 <= row['seconds'] <= 25:reason='过短或过长，不用于本轮微调'
        elif re.search(r'damage|shout|retire|defeat',row['description'],re.I):reason='受击、喊叫或失败台词，不用于日常聊天微调'
        elif not row['text'] or not row['whisper']:reason='缺少可核对的日语文本'
        if not reason:
            text = row['text']
            # A second published Japanese transcription resolves obvious script variants.
            candidates = references[row['student']]
            match = max(candidates, key=lambda t: difflib.SequenceMatcher(None,norm(t),norm(text)).ratio(), default='')
            wiki_score = difflib.SequenceMatcher(None,norm(match),norm(text)).ratio()
            if match and wiki_score >= .88 and score(match,row['whisper']) >= score(text,row['whisper']) and score(match,row['whisper']) >= .96:
                text = match
                row['japanese_reference']='https://bluearchive.wikiru.jp/?'+{108:'アリス',152:'アリス（メイド）',574:'アリス（臨戦）'}[row['student']]
            row['original_text']=row['text'];row['text']=text
            row['asr_reading_agreement']=round(score(text,row['whisper']),4)
            segments=asr[row['id']]['segments']
            if row['asr_reading_agreement'] < .995:reason='日语台词与独立识别不够一致，留待复核'
            elif any(x['avg_logprob'] < -1.0 or x['no_speech_prob'] > .6 for x in segments):reason='识别置信度不足，留待复核'
            elif row['sha256'] in seen_hash or reading(text) in seen_text:reason='与已选独立音频重复'
            if not reason:
                seen_hash.add(row['sha256']);seen_text.add(reading(text));row['train_approved']=True
                row['annotation']='Published Japanese dialogue + independent Whisper turbo; automatic cross-check, not human listening certified.'
                approved.append(row)
        row['reason']=reason or '通过文本和独立识别交叉检查'
    # Reuse prior reviewed clips only when the complete line is absent from the cleaner files.
    for old in existing:
        key=reading(old['text'])
        # Also reject video fragments contained in a full line from the same recording.
        if key in seen_text or any(key in t or t in key for t in seen_text if min(len(key),len(t))>=10):
            continue
        row=dict(old,source=old.get('reference'),variant='previous-reviewed',downloaded=True)
        row['reason']='此前校对通过，且与新增台词不重复';approved.append(row);rows.append(row);seen_text.add(key)
    split_families=[]
    for row in approved:
        # Identical/contained lines above are removed before splitting. Keep evaluation immutable.
        key=reading(row['text'])
        related=next((old for old in split_families if difflib.SequenceMatcher(None,key,old[0]).ratio()>.9 or min(len(key),len(old[0]))>=12 and (key in old[0] or old[0] in key)),None)
        row['split']=related[1] if related else ('validation' if int(hashlib.sha256(key.encode()).hexdigest()[:8],16)%10==0 else 'train')
        split_families.append((key,row['split']))
        dest=ROOT/'data'/row['split']/'aris';dest.mkdir(parents=True,exist_ok=True)
        samples,rate=sf.read(row['audio'],dtype='float32',always_2d=True);samples=samples.mean(axis=1)
        assert np.isfinite(samples).all()
        peak=float(np.max(np.abs(samples)))
        if peak>0:samples=samples * min(.95/peak,4)
        sf.write(dest/(row['id']+'.wav'),samples,rate,subtype='PCM_16')
        (dest/(row['id']+'.lab')).write_text(row['text'].strip(),'utf8')
        row['training_audio']=str(dest/(row['id']+'.wav'))
    for name,data in [('review',rows),('manifest',approved)]:
        (ROOT/(name+'.jsonl')).write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in data),'utf8')
    summary=dict(downloaded=sum(r.get('downloaded',False) for r in rows if r['id'].startswith('kivo')),raw_seconds=sum(r.get('seconds',0) for r in rows if r['id'].startswith('kivo')),
        approved=len(approved),seconds=sum(r['seconds'] for r in approved),new_web=sum(r['id'].startswith('kivo') for r in approved),
        splits=dict(collections.Counter(r['split'] for r in approved)),variants=dict(collections.Counter(r.get('variant') for r in approved)),
        excluded=dict(collections.Counter(r['reason'] for r in rows if not r.get('train_approved'))),
        note='Cross-checked using published text and ASR; not a human listening certificate. No duplicate transcript across train and validation.')
    (ROOT/'data-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),'utf8');print(json.dumps(summary,ensure_ascii=False,indent=2))
    body=''.join('<tr><td>'+html.escape(r['id'])+'</td><td>'+html.escape(r.get('variant',''))+'</td><td>'+html.escape(r.get('text',''))+'</td><td>'+html.escape(r.get('whisper',''))+'</td><td>'+html.escape(r['reason'])+'</td><td><audio controls preload="none" src="'+html.escape(Path(r['audio']).as_uri())+'"></audio></td></tr>' for r in rows if r.get('downloaded'))
    (ROOT/'日语素材校对.html').write_text('<!doctype html><meta charset="utf-8"><title>爱丽丝 Fish 新增素材校对</title><style>body{font:16px system-ui;background:#f5f7fb;padding:24px}table{border-collapse:collapse}td{padding:12px;border:1px solid #ddd;max-width:400px}audio{width:220px}</style><h1>爱丽丝 Fish 新增素材校对</h1><p>网页台词与独立语音识别交叉检查；未声称逐条人工听音。存疑片段已排除。</p><pre>'+html.escape(json.dumps(summary,ensure_ascii=False,indent=2))+'</pre><table>'+body+'</table>','utf8')

if __name__=='__main__':main()
