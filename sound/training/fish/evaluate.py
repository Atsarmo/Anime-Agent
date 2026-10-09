import json
import os
from pathlib import Path
import sys
import time

from paths import ROOT, LAB, ENGINE_ROOT
sys.path.insert(0,str(LAB/'repos/fish-speech'))
sys.path.insert(0,str(ENGINE_ROOT))
os.chdir(LAB/'repos/fish-speech')
import numpy as np
import soundfile as sf
import torch
from fish_speech.inference_engine import TTSInferenceEngine
from fish_speech.models.dac.inference import load_model
from fish_speech.models.text2semantic import inference as semantic
from fish_speech.utils.schema import ServeTTSRequest,ServeReferenceAudio
from fish_acceleration import CudaTokenDecoder

def apply_adapter(model,path,originals):
    params=dict(model.named_parameters())
    with torch.no_grad():
        for name,weight in originals.items():params[name].copy_(weight)
        if path:
            ckpt=torch.load(path,map_location='cpu',weights_only=True)
            state=ckpt['state_dict'];scale=ckpt['config']['alpha']/ckpt['config']['rank']
            assert state and all(n.startswith('fast_') and 'lora_' in n for n in state)
            for key,a in state.items():
                if not key.endswith('.lora_A'):continue
                stem=key.removesuffix('.lora_A');b=state[stem+'.lora_B'];name=stem+'.weight'
                delta=b.float()@a.float()
                if stem=='fast_embeddings':delta=delta.T
                assert delta.shape==params[name].shape
                params[name].copy_((originals[name].float()+delta*scale).to(params[name].dtype))
    torch.cuda.synchronize()

def main():
    torch.set_num_threads(4)
    holder={};init=semantic.init_model
    def capture(*a,**kw):
        model,decode=init(*a,**kw);model.config.max_seq_len=4096
        holder['model']=model
        return model,CudaTokenDecoder(decode)
    semantic.init_model=capture
    try:queue=semantic.launch_thread_safe_queue(checkpoint_path=str(LAB/'models/s2-pro'),device='cuda',precision=torch.bfloat16,compile=False)
    finally:semantic.init_model=init
    decoder=load_model('modded_dac_vq',str(LAB/'models/s2-pro/codec.pth'),device='cuda')
    engine=TTSInferenceEngine(llama_queue=queue,decoder_model=decoder,precision=torch.bfloat16,compile=False)
    model=holder['model']
    originals={n:p.detach().cpu().clone() for n,p in model.named_parameters() if n.startswith('fast_')}
    ref=json.loads((LAB/'reference.json').read_text('utf8'))
    reference=ServeReferenceAudio(audio=Path(ref['short_audio']).read_bytes(),text=ref['short_text'])
    samples=json.loads((LAB/'evaluation.json').read_text('utf8'))
    for result in engine.inference(ServeTTSRequest(text='アリスです。',references=[reference],use_memory_cache='on',streaming=True,chunk_length=100,max_new_tokens=200,seed=42)):
        if result.code=='error':raise result.error
    metrics=[]
    for label,checkpoint in [('baseline',None),('step50',ROOT/'results/step_0050.pt'),('step100',ROOT/'results/step_0100.pt'),('step200',ROOT/'results/step_0200.pt')]:
        apply_adapter(model,checkpoint,originals)
        folder=ROOT/'samples'/label;folder.mkdir(parents=True,exist_ok=True)
        for row in samples:
            start=time.perf_counter();first=None;final=None
            request=ServeTTSRequest(text=row['ja'],references=[reference],use_memory_cache='on',streaming=True,chunk_length=100,max_new_tokens=600,seed=42)
            for result in engine.inference(request):
                if result.code=='error':raise result.error
                if result.code=='segment' and first is None:first=time.perf_counter()-start
                if result.code=='final':final=result.audio
            if final is None:raise RuntimeError('No completed audio')
            rate,audio=final
            path=folder/(row['id']+'.wav');sf.write(path,audio,rate,subtype='PCM_16')
            metric=dict(model=label,id=row['id'],text=row['ja'],zh=row['zh'],audio=str(path),first_audio_ms=round(1000*(first or (time.perf_counter()-start))),
                        complete_ms=round(1000*(time.perf_counter()-start)),seconds=len(audio)/rate)
            metrics.append(metric);(ROOT/'evaluation.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2),'utf8')
            print('SAMPLE',json.dumps(metric,ensure_ascii=False),flush=True)
    print('EVALUATION AUDIO COMPLETE',flush=True)

if __name__=='__main__':main()
