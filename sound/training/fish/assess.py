import json
import sys
from transcribe import ROOT,LAB,WhisperModel

def main():
    model=WhisperModel(str(LAB/'models/whisper-turbo'),device='cuda',compute_type='int8_float16',cpu_threads=6)
    expressive='--expression' in sys.argv
    rows=json.loads((ROOT/('expression-evaluation.json' if expressive else 'evaluation.json')).read_text('utf8'))
    output=ROOT/('expression-asr.json' if expressive else 'evaluation-asr.json')
    for i,row in enumerate(rows):
        segments,_=model.transcribe(row['audio'],language='ja',beam_size=5,temperature=0,condition_on_previous_text=False,vad_filter=False)
        row['whisper']=''.join(x.text for x in segments).strip()
        output.write_text(json.dumps(rows[:i+1],ensure_ascii=False,indent=2),'utf8')
        print(row['model'],row['id'],row['whisper'],flush=True)

if __name__=='__main__':main()
