"""Run with the local Fish environment; validates CUDA replay and seeded sampling."""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch

SOURCE = Path(__file__).resolve().parents[2]
SOUND = SOURCE.parents[2] / 'sound'
LAB = Path(os.environ.get('PET_VOICE_LAB', SOUND / '.local/voice-lab'))
sys.path[:0] = [str(SOUND / 'engines'), str(LAB / 'repos/fish-speech')]
from fish_acceleration import CudaTokenDecoder, graph_sample
from voice_cache import VoiceCache
from fish_speech.models.text2semantic.inference import decode_one_token_ar, sample


class CacheTests(unittest.TestCase):
    def test_cache_keeps_complete_audio_and_evicts_by_bytes_and_recent_use(self):
        import numpy as np
        cache = VoiceCache(max_bytes=32, max_entries=2)
        frame = np.ones(4, dtype=np.float32)
        cache.put(('hello', 1), [(44100, frame)])
        frame.fill(0)
        self.assertEqual(cache.get(('hello', 1))[0][1].sum(), 4)
        self.assertIsNone(cache.get(('hello', 1.2)))
        cache.put(('water', 1), [(44100, frame)])
        cache.get(('hello', 1))
        cache.put(('rest', 1), [(44100, frame)])
        self.assertIsNone(cache.get(('water', 1)))
        self.assertLessEqual(cache.bytes, 32)
        cache.put(('oversized', 1), [(44100, np.ones(100, dtype=np.float32))])
        self.assertIsNone(cache.get(('oversized', 1)))


class TinyModel:
    def __init__(self):
        self.config = SimpleNamespace(max_seq_len=16, num_codebooks=3,
                                      semantic_begin_id=16, semantic_end_id=31, codebook_size=16)
        self.logits = torch.randn(1, 1, 32, device='cuda')
        self.fast_logits = torch.randn(1, 1, 16, device='cuda')
        self.fast_embeddings = torch.nn.Embedding(16, 2, device='cuda')

    def forward_generate(self, x, input_pos, **kwargs):
        shift = (x.sum() + input_pos.sum()).float()
        return SimpleNamespace(logits=self.logits + torch.sin(self.logits * shift),
                               hidden_states=shift.expand(1, 1, 2))

    def forward_generate_fast(self, hidden, input_pos):
        return self.fast_logits + torch.cos(self.fast_logits * (hidden.sum() + input_pos.sum()))


@unittest.skipUnless(torch.cuda.is_available(), 'CUDA required')
class ReplayTests(unittest.TestCase):
    @torch.inference_mode()
    def test_sampler_matches_fish_and_is_capturable(self):
        logits = torch.randn(1, 1, 155776, device='cuda')
        temperature = torch.tensor(.8, device='cuda')
        top_p = torch.tensor(.8, device='cuda')
        torch.manual_seed(42)
        expected = sample(logits, temperature, top_p, 30)[0]
        torch.manual_seed(42)
        actual = graph_sample(logits, temperature, top_p, 30)
        torch.testing.assert_close(actual, expected, rtol=0, atol=0)
        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream):
            graph_sample(logits, temperature, top_p, 30)
        torch.cuda.current_stream().wait_stream(stream)
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            output = graph_sample(logits, temperature, top_p, 30)
        graph.replay()
        self.assertTrue(bool(torch.isfinite(output).all()))

    @torch.inference_mode()
    def test_replay_uses_new_tokens_positions_and_seed(self):
        model = TinyModel()
        bias = torch.zeros(1, 1, 32, device='cuda')
        decoder = CudaTokenDecoder(decode_one_token_ar)
        args = dict(model=model, x=torch.ones(1, 4, 1, device='cuda', dtype=torch.int),
                    input_pos=torch.tensor([2], device='cuda', dtype=torch.int),
                    temperature=torch.tensor(.8, device='cuda'), top_p=torch.tensor(.8, device='cuda'),
                    top_k=5, semantic_logit_bias=bias, previous_tokens=torch.zeros(4, 10, device='cuda', dtype=torch.int),
                    kv_len=3, audio_masks=None, audio_parts=None)
        for position in (2, 5, 9):
            args['input_pos'].fill_(position)
            args['x'].fill_(position+1)
            torch.manual_seed(42)
            actual = decoder(**args).clone()
            self.assertEqual(decoder.mode, 'cuda-graph-fast')
            torch.manual_seed(42)
            expected = decode_one_token_ar(**args)
            torch.testing.assert_close(actual, expected, rtol=0, atol=0)
        torch.manual_seed(7)
        repeated = [decoder(**args).clone() for _ in range(3)]
        torch.manual_seed(7)
        for actual in repeated:
            torch.testing.assert_close(actual, decode_one_token_ar(**args), rtol=0, atol=0)
        args['top_k'] = 4
        torch.manual_seed(42)
        fallback = decoder(**args)
        torch.manual_seed(42)
        torch.testing.assert_close(fallback, decode_one_token_ar(**args), rtol=0, atol=0)


if __name__ == '__main__':
    unittest.main()
