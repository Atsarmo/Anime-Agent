import json
import os
from pathlib import Path
import sys

from paths import ROOT, LAB, ENGINE_ROOT
sys.path.insert(0,str(LAB/'repos/fish-speech'))
os.chdir(LAB/'repos/fish-speech')
import numpy as np
import soundfile as sf
import torch
import torchaudio
from fish_speech.models.dac.inference import load_model

@torch.inference_mode()
def main():
    torch.set_num_threads(4)
    model=load_model('modded_dac_vq',str(LAB/'models/s2-pro/codec.pth'),device='cuda')
    rows=list(map(json.loads,(ROOT/'manifest.jsonl').read_text('utf8').splitlines()))
    for i,row in enumerate(rows):
        dest=Path(row['training_audio']).with_suffix('.npy')
        if dest.exists():continue
        audio,rate=sf.read(row['training_audio'],dtype='float32')
        wave=torch.from_numpy(audio).to('cuda')[None,None]
        if rate!=model.sample_rate:wave=torchaudio.functional.resample(wave,rate,model.sample_rate)
        lengths=torch.tensor([wave.shape[-1]],device='cuda',dtype=torch.long)
        codes,features=model.encode(wave,lengths)
        codes=codes[0,:,:int(features[0])].cpu().numpy()
        assert codes.shape[0]==10 and codes.min()>=0 and codes[0].max()<4096 and codes[1:].max()<1024
        np.save(dest,codes)
        if i%20==0:print(f'Encoded {i+1}/{len(rows)}',flush=True)
    print('Codec encoding finished',flush=True)

if __name__=='__main__':main()
