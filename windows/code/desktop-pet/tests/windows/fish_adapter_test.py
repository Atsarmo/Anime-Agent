import sys
import unittest
from pathlib import Path
import torch

sys.path.insert(0,str(Path(__file__).resolve().parents[5]/'sound/engines'))
from fish_adapter import merge_fast_adapter

class AdapterTests(unittest.TestCase):
    def model(self):
        model=torch.nn.Module()
        model.fast_output=torch.nn.Linear(3,2,bias=False)
        model.fast_embeddings=torch.nn.Embedding(5,3)
        model.slow=torch.nn.Linear(3,3)
        return model

    def test_linear_embedding_merge_leaves_slow_weights_unchanged(self):
        model=self.model()
        before={n:p.detach().clone() for n,p in model.named_parameters()}
        state={'fast_output.lora_A':torch.randn(2,3),'fast_output.lora_B':torch.randn(2,2),
               'fast_embeddings.lora_A':torch.randn(2,5),'fast_embeddings.lora_B':torch.randn(3,2)}
        merge_fast_adapter(model,dict(state_dict=state,config=dict(rank=2,alpha=1),step=100))
        self.assertTrue(torch.allclose(model.fast_output.weight,before['fast_output.weight']+.5*state['fast_output.lora_B']@state['fast_output.lora_A']))
        self.assertTrue(torch.allclose(model.fast_embeddings.weight,before['fast_embeddings.weight']+.5*(state['fast_embeddings.lora_B']@state['fast_embeddings.lora_A']).T))
        self.assertTrue(torch.equal(model.slow.weight,before['slow.weight']))

    def test_invalid_pair_rejected_before_any_mutation(self):
        model=self.model();before={n:p.detach().clone() for n,p in model.named_parameters()}
        state={'fast_output.lora_A':torch.randn(2,3),'fast_output.lora_B':torch.randn(2,2),
               'fast_embeddings.lora_A':torch.randn(2,5),'fast_embeddings.lora_B':torch.full((3,2),float('nan'))}
        with self.assertRaises(ValueError):merge_fast_adapter(model,dict(state_dict=state,config=dict(rank=2,alpha=1)))
        self.assertTrue(all(torch.equal(p,before[n]) for n,p in model.named_parameters()))
        with self.assertRaises(ValueError):merge_fast_adapter(model,dict(state_dict={'slow.lora_A':torch.zeros(2,3)},config=dict(rank=2,alpha=1)))

if __name__=='__main__':unittest.main()
