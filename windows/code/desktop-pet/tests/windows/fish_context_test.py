import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / 'sound' / 'engines'))
from fish_context import limit_context


class ContextTests(unittest.TestCase):
    def model(self, length):
        model = torch.nn.Module()
        model.config = SimpleNamespace(max_seq_len=length)
        model.register_buffer('causal_mask', torch.ones(length, length, dtype=torch.bool).tril())
        return model

    def test_attention_semantics_and_storage_remain_bounded(self):
        model = self.model(256)
        original = model.causal_mask
        limit_context(model, 32)
        self.assertTrue(torch.equal(original[:32, :32], model.causal_mask))
        self.assertEqual(model.config.max_seq_len, 32)
        self.assertEqual(model.causal_mask.untyped_storage().nbytes(), 32 * 32)
        self.assertNotEqual(original.data_ptr(), model.causal_mask.data_ptr())
        self.assertIn('causal_mask', dict(model.named_buffers()))
        self.assertEqual(model.causal_mask.dtype, original.dtype)

    def test_smaller_context_is_preserved_and_repeated_limit_is_noop(self):
        model = self.model(16)
        original = model.causal_mask
        limit_context(model, 32)
        limit_context(model, 32)
        self.assertEqual(model.config.max_seq_len, 16)
        self.assertIs(model.causal_mask, original)


if __name__ == '__main__':
    unittest.main()
