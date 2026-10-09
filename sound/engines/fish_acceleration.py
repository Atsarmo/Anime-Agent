"""Replay Fish's fixed-shape fast codebooks; keep slow KV attention dynamic.

Capture happens during the worker's warm-up, before accepting synthesis. This
keeps capture isolated from the audio decoder and other inference threads.
"""
import torch


def graph_sample(logits, temperature, top_p, top_k):
    """Fish's top-p/top-k sampler without a CPU scalar copy into a CUDA view."""
    logits = logits[0, -1]
    sorted_logits, sorted_indices = torch.sort(logits, descending=True)
    cumulative = torch.cumsum(torch.nn.functional.softmax(sorted_logits, dim=-1), dim=-1)
    indices = torch.arange(sorted_logits.shape[-1], device=sorted_logits.device)
    removed = ((cumulative > top_p) | (indices >= top_k)) & (indices > 0)
    removed = removed.scatter(dim=-1, index=sorted_indices, src=removed)
    logits = torch.where(removed, float('-inf'), logits) / torch.clip(temperature, min=1e-5)
    probabilities = torch.nn.functional.softmax(logits, dim=-1)
    noise = -torch.log(torch.rand_like(probabilities))
    return torch.argmax(probabilities / noise, dim=-1, keepdim=True).to(dtype=torch.int)


class CudaTokenDecoder:
    def __init__(self, original):
        self.original = original
        self.graph = None
        self.disabled = False
        self.mode = 'warming-up'

    def __call__(self, **kwargs):
        if self.disabled or kwargs['x'].device.type != 'cuda' or kwargs.get('audio_parts') is not None or kwargs.get('previous_tokens') is None:
            return self.original(**kwargs)
        if self.graph is not None and (kwargs['model'] is not self.static['model'] or kwargs['top_k'] != self.static['top_k']):
            return self.original(**kwargs)
        model = kwargs['model']
        result = model.forward_generate(kwargs['x'], kwargs['input_pos'],
                                        audio_masks=kwargs.get('audio_masks'), kv_len=kwargs.get('kv_len'))
        logits = result.logits + kwargs['semantic_logit_bias']
        temperature, top_p, top_k = kwargs['temperature'], kwargs['top_p'], kwargs['top_k']
        normal = graph_sample(logits, temperature, top_p, top_k)
        high_temp = torch.ones_like(temperature)
        high_p = torch.full_like(top_p, .9)
        high = graph_sample(logits, high_temp, high_p, top_k)
        in_window = (kwargs['previous_tokens'][0] == normal).any()
        semantic = (normal >= model.config.semantic_begin_id) & (normal <= model.config.semantic_end_id)
        main = torch.where(in_window & semantic, high, normal)
        current = dict(model=model, hidden=result.hidden_states, main=main,
                       temperature=temperature, top_p=top_p, top_k=top_k)
        if self.graph is None:
            try:
                self.capture(current)
            except Exception as error:
                self.disabled = True
                self.mode = 'eager-fallback'
                print('Fish CUDA graph unavailable: ' + str(error)[:240], flush=True)
                raise RuntimeError('Fish CUDA capture failed during warm-up') from error
        # Reject unexpected shapes/options rather than replaying stale inputs.
        for key, value in self.inputs.items():
            updated = current.get(key)
            if not isinstance(updated, torch.Tensor) or updated.shape != value.shape or updated.dtype != value.dtype:
                return self.step(**current)
        for key, value in self.inputs.items():
            value.copy_(current[key])
        self.graph.replay()
        # The caller clones this output before starting the next token.
        return self.output

    def capture(self, kwargs):
        self.inputs = {key: value.clone() for key, value in kwargs.items() if isinstance(value, torch.Tensor)}
        self.static = {**kwargs, **self.inputs}
        self.positions = [torch.tensor([index], device=kwargs['hidden'].device, dtype=torch.long)
                          for index in range(kwargs['model'].config.num_codebooks)]
        rng = torch.cuda.get_rng_state()
        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        try:
            with torch.cuda.stream(stream):
                for _ in range(2):
                    self.step(**self.static)
            torch.cuda.current_stream().wait_stream(stream)
            torch.cuda.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph):
                output = self.step(**self.static)
            self.graph, self.output = graph, output
            self.mode = 'cuda-graph-fast'
            print('Fish fast-codebook CUDA graph ready.', flush=True)
        finally:
            # Warm-up must not consume the utterance's seeded sampling sequence.
            torch.cuda.set_rng_state(rng)

    def step(self, model, hidden, main, temperature, top_p, top_k):
        codes = [main]
        model.forward_generate_fast(hidden, self.positions[0])
        audio_code = torch.clamp(main - model.config.semantic_begin_id, min=0, max=model.config.codebook_size-1)
        codes.append(audio_code)
        hidden = model.fast_embeddings(audio_code)
        for index in range(1, model.config.num_codebooks):
            logits = model.forward_generate_fast(hidden, self.positions[index])
            audio_code = graph_sample(logits, temperature, top_p, top_k)
            hidden = model.fast_embeddings(audio_code)
            codes.append(audio_code)
        return torch.stack(codes, dim=1).T
