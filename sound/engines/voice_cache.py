"""Bounded, in-memory cache for complete synthesized utterances."""
from collections import OrderedDict
import numpy as np


class VoiceCache:
    def __init__(self, max_bytes=16*1024*1024, max_entries=24):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.entries = OrderedDict()
        self.bytes = 0

    def get(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return None
        self.entries.move_to_end(key)
        return entry[0]

    def put(self, key, frames):
        previous = self.entries.pop(key, None)
        if previous:
            self.bytes -= previous[1]
        size = sum(audio.nbytes for _, audio in frames)
        if not frames or size > self.max_bytes:
            return
        frames = tuple((rate, np.array(audio, copy=True)) for rate, audio in frames)
        for _, audio in frames:
            audio.setflags(write=False)
        self.entries[key] = frames, size
        self.bytes += size
        while self.bytes > self.max_bytes or len(self.entries) > self.max_entries:
            _, (_, size) = self.entries.popitem(last=False)
            self.bytes -= size
