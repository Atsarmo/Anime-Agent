"""Synthesis-only Fish pause directions; preserve dialogue and punctuation."""
import re

BOUNDARY = re.compile(r'''(\[[^\]\r\n]*\])|([、，,；;：:。！？!?]+|…+|(?<!\d)\.(?!\d))([」』）”’"']*)''')
PAUSE = re.compile(r'^\s*\[(?:short pause|pause)\]')


def punctuation_pauses(text):
    def add(match):
        if match.group(1):
            return match.group(0)  # Never rewrite an existing voice direction.
        remainder = text[match.end():]
        if not remainder.strip() or PAUSE.match(remainder):
            return match.group(0)
        marker = '[pause]' if re.search(r'[。！？!?….]', match.group(2)) else '[short pause]'
        return match.group(0) + marker
    return BOUNDARY.sub(add, text)
