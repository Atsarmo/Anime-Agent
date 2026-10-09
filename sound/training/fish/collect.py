import concurrent.futures
import hashlib
import json
import pathlib
import time

import requests
import soundfile as sf

from paths import ROOT, LAB, ENGINE_ROOT
PROXY = None  # requests uses standard HTTP_PROXY / HTTPS_PROXY environment variables.

def download(row):
    path = ROOT / 'raw' / (row['id'] + '.ogg')
    path.parent.mkdir(exist_ok=True)
    try:
        if not path.exists():
            for attempt in range(3):
                try:
                    response = requests.get(row['url'], proxies=PROXY, timeout=35)
                    response.raise_for_status()
                    sf.info(__import__('io').BytesIO(response.content))
                    path.write_bytes(response.content)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(1 + attempt)
        info = sf.info(path)
        row.update(audio=str(path), seconds=info.duration, rate=info.samplerate,
                   channels=info.channels, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                   downloaded=True)
    except Exception as exc:
        row.update(downloaded=False, error=str(exc))
    return row

def main():
    rows = []
    for student in [108, 152, 574]:
        data = json.loads((ROOT / f'kivo-{student}.json').read_text('utf8'))['data']
        assert data['given_name_jp'] == 'アリス' and data['character_voice'] == '田中美海'
        for i, voice in enumerate(data['voice']):
            rows.append(dict(id=f'kivo_{student}_{i:03}', student=student, variant=data['skin_jp'] or 'original',
                             description=voice['description'], category=voice['category'],
                             text=voice['text_original'], translation=voice['text'], language='ja',
                             url='https:' + voice['file'] if voice['file'].startswith('//') else voice['file'],
                             source=f'https://kivo.wiki/data/character/{student}?mode=voice',
                             metadata=f'https://api.kivo.wiki/api/v1/data/students/{student}',
                             retrieved='2026-10-09', rights='Game voice audio; no open license asserted. Local experiment only.'))
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        results = []
        for row in pool.map(download, rows):
            results.append(row)
            if len(results) % 25 == 0:
                print(f'Downloaded {len(results)}/{len(rows)}', flush=True)
            (ROOT / 'sources.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False)+'\n' for r in results), encoding='utf8')
    good = [r for r in results if r['downloaded']]
    print(json.dumps(dict(files=len(good), failed=len(rows)-len(good), seconds=sum(r['seconds'] for r in good)), ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
