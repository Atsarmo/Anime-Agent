import json
import os
from pathlib import Path
import time

from paths import ROOT, LAB, ENGINE_ROOT
os.environ['HF_HOME'] = str(LAB / 'cache/hf')
os.environ['PATH'] = str(LAB / 'envs/fish/Lib/site-packages/torch/lib') + os.pathsep + os.environ['PATH']
cuda_dll = os.add_dll_directory(str(LAB / 'envs/fish/Lib/site-packages/torch/lib'))
from faster_whisper import WhisperModel

def main():
    model = WhisperModel(str(LAB / 'models/whisper-turbo'), device='cuda', compute_type='int8_float16', cpu_threads=6)
    output = ROOT / 'asr.jsonl'
    done = {json.loads(x)['id'] for x in output.read_text('utf8').splitlines()} if output.exists() else set()
    rows = [json.loads(x) for x in (ROOT / 'sources.jsonl').read_text('utf8').splitlines()]
    count = 0
    for row in rows:
        if row['id'] in done or not row.get('downloaded') or row['seconds'] < 1.4:
            continue
        # Single voice game files: no preceding transcript in the decoder context.
        start = time.perf_counter()
        segments, info = model.transcribe(row['audio'], language='ja', beam_size=5, temperature=0,
            condition_on_previous_text=False, vad_filter=False,
            initial_prompt='ブルーアーカイブ。アリス。先生。勇者。メイド。レベルアップ。')
        parts = [dict(text=s.text, start=s.start, end=s.end, avg_logprob=s.avg_logprob,
                      no_speech_prob=s.no_speech_prob) for s in segments]
        result = dict(id=row['id'], text=row['text'], whisper=''.join(s['text'] for s in parts).strip(),
                      segments=parts, elapsed=round(time.perf_counter()-start, 2))
        with output.open('a', encoding='utf8') as f:
            f.write(json.dumps(result, ensure_ascii=False)+'\n')
        count += 1
        if count % 10 == 0:
            print(f'Cross-checked {count} new clips', flush=True)
    print('ASR finished', flush=True)

if __name__ == '__main__':
    main()
