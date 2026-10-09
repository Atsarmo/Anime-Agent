"""Keep private datasets and checkpoints separate from published training code."""
import os
from pathlib import Path

SOUND_ROOT = Path(__file__).resolve().parents[2]
LAB = Path(os.environ.get('PET_VOICE_LAB', SOUND_ROOT / '.local' / 'voice-lab')).resolve()
ROOT = Path(os.environ.get('PET_FISH_DATASET', LAB / 'fish-aris-v1')).resolve()
ENGINE_ROOT = SOUND_ROOT / 'engines'
