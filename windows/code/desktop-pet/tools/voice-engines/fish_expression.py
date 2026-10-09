# Compatibility entry point; implementation lives in sound/engines.
from pathlib import Path
import runpy
import sys
target = Path(__file__).resolve().parents[5] / 'sound' / 'engines' / 'fish_expression.py'
sys.path.insert(0, str(target.parent))
globals().update(runpy.run_path(str(target)))
