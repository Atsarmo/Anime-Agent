"""Pitch-preserving waveform tempo adjustment; original speed stays untouched."""
import math
import subprocess
import numpy as np


def adjust_tempo(rate, audio, speed, ffmpeg):
    if not math.isfinite(speed) or not .5 <= speed <= 2:
        raise ValueError('Voice speed must be between 0.5 and 2')
    if speed == 1:
        return audio
    samples = np.asarray(audio, dtype='<f4').reshape(-1)
    if not len(samples) or not np.isfinite(samples).all():
        raise ValueError('Invalid voice samples')
    command = [str(ffmpeg), '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-f', 'f32le', '-ar', str(rate), '-ac', '1', '-i', 'pipe:0',
               '-filter:a', f'atempo={speed:.8g}', '-f', 'f32le',
               '-ar', str(rate), '-ac', '1', 'pipe:1']
    try:
        result = subprocess.run(command, input=samples.tobytes(), capture_output=True,
                                check=True, timeout=10,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError('Voice tempo adjustment failed') from error
    if not result.stdout or len(result.stdout) % 4:
        raise RuntimeError('Voice tempo adjustment returned invalid samples')
    output = np.frombuffer(result.stdout, dtype='<f4').copy()
    if not np.isfinite(output).all():
        raise RuntimeError('Voice tempo adjustment returned invalid samples')
    return output
