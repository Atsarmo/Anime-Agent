"""S2 Pro fast-only LoRA. Uses the same Conversation format as S2 inference.

The checked-out upstream training dataset still uses the pre-S2 prompt format;
construct S2 training tensors explicitly rather than training against that format.
No slow-transformer parameters are updated. Checkpoints contain adapters only.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys
import time

from paths import ROOT, LAB, ENGINE_ROOT
sys.path.insert(0,str(LAB/'repos/fish-speech'))
os.chdir(LAB/'repos/fish-speech')
os.environ['HF_HOME']=str(LAB/'cache/hf')
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.checkpoint import checkpoint
from fish_speech.models.text2semantic.llama import BaseTransformer
from fish_speech.models.text2semantic.lora import LoraConfig
from fish_speech.conversation import Conversation,Message
from fish_speech.content_sequence import TextPart,VQPart

CONFIG=dict(base=str(LAB/'models/s2-pro'),rank=32,alpha=16,dropout=.1,
    target_modules=['fast_attention','fast_mlp','fast_embeddings','fast_output'],
    steps=200,accumulation=2,lr=1e-5,min_lr=1e-6,seed=20261009,max_length=1024,
    precision='bfloat16',checkpoint_steps=[50,100,200],reference_probability=.5,
    prompt_format='S2 Conversation (same as generate_long)',freeze_slow=True)

def pack(row,reference,tokenizer):
    codes=torch.from_numpy(np.load(Path(row['training_audio']).with_suffix('.npy'))).long()
    if reference:
        ref_codes=torch.from_numpy(np.load(Path(reference['training_audio']).with_suffix('.npy'))).long()
        system=[TextPart(text='convert the provided text to speech reference to the following:\n\nText:\n',cal_loss=False),
                TextPart(text='<|speaker:0|>'+reference['text'],cal_loss=False),
                TextPart(text='\n\nSpeech:\n',cal_loss=False),VQPart(codes=ref_codes,cal_loss=False)]
    else:system=[TextPart(text='convert the provided text to speech',cal_loss=False)]
    conversation=Conversation([
        Message(role='system',parts=system,cal_loss=False),
        Message(role='user',parts=[TextPart(text=row['text'],cal_loss=False)],cal_loss=False),
        Message(role='assistant',parts=[VQPart(codes=codes,cal_loss=True)],cal_loss=True,modality='voice')])
    # Conversation.encode has a stale max_length argument in this local checkout.
    encoded=conversation.to_content_sequence().encode(tokenizer)
    inputs=torch.zeros((11,encoded.tokens.numel()),dtype=torch.long)
    labels=torch.full_like(inputs,-100)
    inputs[0]=encoded.tokens;labels[0]=encoded.labels
    all_codes=torch.cat(encoded.vq_parts,dim=1).long()
    inputs[1:,encoded.vq_mask_tokens]=all_codes
    labels[1:,encoded.vq_mask_labels]=all_codes
    # Reference codebooks are context only: honor their loss masks as well.
    labels[1:,encoded.labels==-100]=-100
    assert inputs.shape[-1]<=CONFIG['max_length'],(row['id'],inputs.shape)
    assert ((labels[0]>=tokenizer.semantic_begin_id)&(labels[0]<=tokenizer.semantic_end_id)).sum()==codes.shape[1]
    return inputs[None].cuda(),labels[None].cuda()

def forward_loss(model,inputs,labels):
    # All slow weights frozen; neither backward activations nor the huge vocabulary
    # logits are needed. Replicate BaseTransformer.forward hidden state computation.
    with torch.no_grad():
        x=model.embed(inputs)
        freqs=model.freqs_cis[:inputs.shape[-1]]
        # This Windows torch build has no FlashAttention-only kernel. The explicit
        # causal mask selects PyTorch's supported SDPA backend, as inference does.
        slow_mask=model.causal_mask[None,None,:inputs.shape[-1],:inputs.shape[-1]]
        for layer in model.layers:x=layer(x,freqs,slow_mask)
        x=model.norm(x) if model.config.norm_fastlayer_input else x
        mask=(labels[:,0]>=model.tokenizer.semantic_begin_id)&(labels[:,0]<=model.tokenizer.semantic_end_id)
        x=x[mask]
        target=labels[:,1:].permute(0,2,1)[mask]
    x=model.fast_project_in(x)
    x=torch.cat([x[:,None],model.fast_embeddings(target[:,:-1])],dim=1)
    freq=model.fast_freqs_cis[:model.config.num_codebooks]
    causal=model.causal_mask[None,None,:model.config.num_codebooks,:model.config.num_codebooks]
    for layer in model.fast_layers:
        x=checkpoint(layer,x,freq,causal,use_reentrant=False)
    logits=model.fast_output(model.fast_norm(x))
    return F.cross_entropy(logits.float().reshape(-1,logits.shape[-1]),target.reshape(-1))

def main():
    torch.set_num_threads(4);torch.manual_seed(CONFIG['seed']);random.seed(CONFIG['seed']);np.random.seed(CONFIG['seed'])
    torch.set_float32_matmul_precision('high')
    out=ROOT/'results';out.mkdir(exist_ok=True)
    (out/'config.json').write_text(json.dumps(CONFIG,indent=2),'utf8')
    rows=list(map(json.loads,(ROOT/'manifest.jsonl').read_text('utf8').splitlines()))
    train=[r for r in rows if r['split']=='train'];val=[r for r in rows if r['split']=='validation']
    assert not {r['text'] for r in train}&{r['text'] for r in val}
    model=BaseTransformer.from_pretrained(CONFIG['base'],load_weights=True,max_length=CONFIG['max_length'],
        lora_config=LoraConfig(r=CONFIG['rank'],lora_alpha=CONFIG['alpha'],lora_dropout=CONFIG['dropout'],target_modules=CONFIG['target_modules']))
    model=model.to(device='cuda',dtype=torch.bfloat16)
    # Keep adapters unmerged during validation; repeated BF16 merge/unmerge rounds
    # the frozen weights. Inference will merge once into FP32 base weights.
    for module in model.modules():
        if hasattr(module,'merge_weights'):module.merge_weights=False
    trainables=[(n,p) for n,p in model.named_parameters() if p.requires_grad]
    assert trainables and all(n.startswith('fast_') and 'lora_' in n for n,p in trainables)
    print('Trainable parameters:',sum(p.numel() for n,p in trainables),flush=True)
    slow_probe=model.layers[0].attention.wqkv.weight.detach().clone()
    optim=torch.optim.AdamW([p for n,p in trainables],lr=CONFIG['lr'],weight_decay=.01,betas=(.9,.95))
    # Stable validation set: fixed full lines, no references from the validation set.
    validation=[pack(r,None,model.tokenizer) for r in val]
    def evaluate(step):
        model.eval()
        with torch.no_grad():losses=[float(forward_loss(model,x,y)) for x,y in validation]
        model.train()
        result=dict(step=step,validation_loss=sum(losses)/len(losses))
        with (out/'validation.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps(result)+'\n')
        print('VALIDATION',json.dumps(result),flush=True)
        return result
    baseline=evaluate(0)
    start=time.perf_counter();order=[]
    for step in range(1,CONFIG['steps']+1):
        model.train();optim.zero_grad(set_to_none=True);loss_value=0.
        lr=CONFIG['min_lr']+(CONFIG['lr']-CONFIG['min_lr'])*.5*(1+math.cos(math.pi*(step-1)/CONFIG['steps']))
        for group in optim.param_groups:group['lr']=lr
        for micro in range(CONFIG['accumulation']):
            if not order:order=random.sample(train,len(train))
            row=order.pop()
            choices=[r for r in train if r['id']!=row['id'] and r.get('variant')==row.get('variant') and r['seconds']<=6]
            reference=random.choice(choices) if choices and random.random()<CONFIG['reference_probability'] else None
            try:inputs,labels=pack(row,reference,model.tokenizer)
            except AssertionError:inputs,labels=pack(row,None,model.tokenizer)
            loss=forward_loss(model,inputs,labels)
            if not torch.isfinite(loss):raise RuntimeError('Non-finite training loss')
            loss_value+=float(loss.detach())/CONFIG['accumulation'];(loss/CONFIG['accumulation']).backward()
        norm=torch.nn.utils.clip_grad_norm_([p for n,p in trainables],1.)
        if not torch.isfinite(norm) or norm==0:raise RuntimeError('Invalid or missing LoRA gradients')
        optim.step()
        metric=dict(step=step,loss=loss_value,lr=lr,grad_norm=float(norm),elapsed=round(time.perf_counter()-start,2),gpu_peak_gb=round(torch.cuda.max_memory_allocated()/1024**3,2))
        (out/'status.json').write_text(json.dumps(metric,indent=2),'utf8')
        with (out/'train.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps(metric)+'\n')
        if step%5==0 or step==1:print(json.dumps(metric),flush=True)
        if step in CONFIG['checkpoint_steps']:
            assert torch.equal(model.layers[0].attention.wqkv.weight,slow_probe)
            state={n:p.detach().cpu().clone() for n,p in trainables}
            torch.save(dict(state_dict=state,step=step,config=CONFIG,manifest_sha256=hashlib.sha256((ROOT/'manifest.jsonl').read_bytes()).hexdigest(),optimizer=optim.state_dict()),out/f'step_{step:04}.pt')
            evaluate(step)
    (out/'complete.json').write_text(json.dumps(dict(steps=CONFIG['steps'],elapsed=time.perf_counter()-start,baseline=baseline,slow_probe_unchanged=True),indent=2),'utf8')
    print('TRAINING COMPLETE',flush=True)

if __name__=='__main__':main()
