"""Check the actual repository's upload candidates without printing secret values."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PATTERNS = {
    'OpenAI key': re.compile(rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}'),
    'GitHub token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'),
    'AWS access key': re.compile(rb'\bAKIA[A-Z0-9]{16}\b'),
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}
PRIVATE_SUFFIXES = {'.ckpt','.pth','.pt','.safetensors','.onnx','.wav','.ogg','.flac','.mp3','.m4a','.mp4','.key','.pem'}

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

def main():
    actual = Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve()
    if actual != ROOT:
        raise SystemExit('Unexpected repository root; check the nested Anime-Agent repository.')
    names = sorted(set(git('ls-files','--cached','--others','--exclude-standard','-z').decode('utf-8').split('\0')) - {''})
    findings = []
    total = 0
    for name in names:
        path = ROOT / name
        if not path.is_file():
            continue  # A deleted tracked file carries no current upload contents.
        total += 1
        if '.local' in path.relative_to(ROOT).parts or path.suffix.lower() in PRIVATE_SUFFIXES:
            findings.append({'file':name, 'issue':'private resource in upload candidates'})
        if path.stat().st_size > 95 * 1024 * 1024:
            findings.append({'file':name, 'issue':'file approaches GitHub single-file limit'})
        if path.stat().st_size > 16 * 1024 * 1024:
            continue
        data = path.read_bytes()
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(data):
                findings.append({'file':name,'line':data[:match.start()].count(b'\n')+1,'issue':label})
    print(json.dumps({'repository':str(ROOT),'files_checked':total,'findings':findings},ensure_ascii=False,indent=2))
    raise SystemExit(1 if findings else 0)

if __name__ == '__main__':
    main()
