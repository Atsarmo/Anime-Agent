import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / 'sound' / 'engines'))
from fish_codec import compact_codec


class CodecTests(unittest.TestCase):
    def test_compaction_preserves_complex_positions_and_integer_buffers(self):
        model = torch.nn.Linear(4, 4)
        model.register_buffer('rotary', torch.tensor([1 + 2j, 3 + 4j]))
        model.register_buffer('positions', torch.arange(4))
        model.register_buffer('running', torch.ones(4))
        original = model.weight.detach().clone()
        rotary = model.rotary.clone()
        model.encode = lambda value: value + 1
        compact_codec(model)
        self.assertEqual(model.weight.dtype, torch.bfloat16)
        self.assertTrue(torch.equal(model.weight, original.to(torch.bfloat16)))
        self.assertTrue(torch.equal(model.rotary, rotary))
        self.assertEqual(model.positions.dtype, torch.int64)
        self.assertEqual(model.running.dtype, torch.bfloat16)
        with patch('fish_codec.torch.autocast') as autocast:
            self.assertEqual(model.encode(4), 5)
            autocast.assert_called_once_with(device_type='cuda', dtype=torch.bfloat16)


if __name__ == '__main__':
    unittest.main()
