"""Keep Fish's attention buffer consistent with the desktop context limit."""


def limit_context(model, maximum=4096):
    length = min(maximum, model.config.max_seq_len)
    model.config.max_seq_len = length
    mask = model.causal_mask
    if mask.shape[-2:] != (length, length):
        # A slice alone keeps the original 32k-square allocation alive. Copy
        # before replacing the registered buffer so that its storage is freed.
        model.causal_mask = mask[:length, :length].clone()
    return model
