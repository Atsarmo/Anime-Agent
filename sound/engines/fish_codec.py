"""Avoid keeping FP32 codec weights alongside autocast's BF16 copies."""
import torch


def compact_codec(model):
    # Rotary embeddings may use complex buffers. Module.to(dtype=...) would
    # discard their imaginary component; only convert real floating tensors.
    model._apply(lambda value: value.to(dtype=torch.bfloat16)
                 if value.is_floating_point() else value)
    encode = model.encode

    def encode_reference(*args, **kwargs):
        with torch.autocast(device_type='cuda', dtype=torch.bfloat16):
            return encode(*args, **kwargs)

    model.encode = encode_reference
    return model
