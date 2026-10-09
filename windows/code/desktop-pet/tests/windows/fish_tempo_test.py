import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / 'sound/engines'))
from fish_tempo import adjust_tempo


class TempoTests(unittest.TestCase):
    def test_original_speed_is_bit_exact_and_never_opens_a_process(self):
        audio = np.array([0., .2, -.4], dtype=np.float32)
        with patch('fish_tempo.subprocess.run') as run:
            self.assertIs(adjust_tempo(44100, audio, 1, 'unused'), audio)
            run.assert_not_called()

    def test_real_tempo_change_preserves_pitch_and_duration(self):
        rate = 44100
        audio = (.3*np.sin(2*np.pi*440*np.arange(rate*2)/rate)).astype(np.float32)
        for speed in [.5, .85, 1.5, 2]:
            with self.subTest(speed=speed):
                output = adjust_tempo(rate, audio, speed, ROOT/'sound/.local/voice-lab/bin/ffmpeg.exe')
                self.assertTrue(np.isfinite(output).all())
                self.assertAlmostEqual(len(output)/rate, 2/speed, delta=.06)
                spectrum = np.abs(np.fft.rfft(output*np.hanning(len(output))))
                frequency = np.argmax(spectrum)*rate/len(output)
                self.assertAlmostEqual(frequency, 440, delta=3)

    def test_invalid_speed_and_bad_audio_fail_without_running_ffmpeg(self):
        with patch('fish_tempo.subprocess.run') as run:
            for speed in [0, 3, float('nan')]:
                with self.assertRaises(ValueError):
                    adjust_tempo(44100, np.zeros(8), speed, 'unused')
            with self.assertRaises(ValueError):
                adjust_tempo(44100, np.array([float('nan')]), .85, 'unused')
            run.assert_not_called()

    def test_missing_processor_does_not_return_partial_or_silent_audio(self):
        with self.assertRaises(RuntimeError):
            adjust_tempo(44100, np.zeros(44100), .85, ROOT/'missing-ffmpeg.exe')


if __name__ == '__main__':
    unittest.main()
