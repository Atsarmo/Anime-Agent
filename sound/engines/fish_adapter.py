"""Apply a local fast-only Fish LoRA without changing the base checkpoint."""
import math
import torch


def merge_fast_adapter(model, checkpoint):
    state = checkpoint['state_dict']
    config = checkpoint['config']
    rank, alpha = config['rank'], config['alpha']
    if not isinstance(rank, int) or rank <= 0 or not math.isfinite(alpha):
        raise ValueError('Invalid Fish adapter scale')
    if not state or any(not key.startswith('fast_') or not key.endswith(('.lora_A', '.lora_B')) for key in state):
        raise ValueError('Only fast-transformer LoRA adapters are supported')
    parameters = dict(model.named_parameters())
    updates = []
    for key, a in state.items():
        if not key.endswith('.lora_A'):
            continue
        stem = key.removesuffix('.lora_A')
        b = state[stem + '.lora_B']
        weight = parameters[stem + '.weight']
        delta = b.float() @ a.float()
        if stem == 'fast_embeddings':
            delta = delta.T
        if delta.shape != weight.shape or not torch.isfinite(delta).all():
            raise ValueError('Invalid Fish adapter weights')
        updates.append((weight, delta * (alpha / rank)))
    if len(updates) * 2 != len(state):
        raise ValueError('Incomplete Fish adapter pairs')
    # Validate every pair before modifying any parameter. Round once after adding
    # in FP32; the persistent inference weights keep their original dtype.
    with torch.no_grad():
        for weight, delta in updates:
            weight.copy_((weight.float() + delta.to(weight.device)).to(weight.dtype))
    return checkpoint.get('step')
