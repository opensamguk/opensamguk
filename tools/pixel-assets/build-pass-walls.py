"""관 표식의 긴 성벽판을 기존 관 그림에서 잘라 만든다 (D-052, INT-20 사용자 요청).

Run: python3 tools/pixel-assets/build-pass-walls.py
관 그림(pass.png·pass@128.png, apps/web/src/art/sources.json의 markers/pass.png 생성물)에서 가로 성벽과 문루가 지나는
띠만 4:1로 잘라 남북 길용(가로 성벽) 판을 만들고, 90도 돌려 동서 길용(세로 성벽) 판을 만든다. 새 그림을 생성하지 않고
같은 바이트만 쓰므로 같은 입력이면 같은 결과다.
"""
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MAP = ROOT / 'apps/web/src/art/map'
SOURCES = ROOT / 'apps/web/src/art/sources.json'
# 128px 판의 성벽 띠(문루 지붕부터 성벽 아랫단까지). 32px 판은 4분의 1이다.
TOP, HEIGHT = 42, 32


def save(image, path):
    image.save(path, optimize=True)
    data = path.read_bytes()
    return {'from': 'markers/pass.png', 'file': path.relative_to(ROOT).as_posix(),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def main():
    outputs = []
    for suffix, scale in (('', 4), ('@128', 1)):
        source = Image.open(MAP / f'pass{suffix}.png').convert('RGBA')
        band = source.crop((0, TOP // scale, source.width, (TOP + HEIGHT) // scale))
        outputs.append(save(band, MAP / f'pass-wall{suffix}.png'))
        outputs.append(save(band.transpose(Image.Transpose.ROTATE_90), MAP / f'pass-wall-ew{suffix}.png'))
    sources = json.loads(SOURCES.read_text(encoding='utf-8'))
    names = {row['file'] for row in outputs}
    sources['outputs'] = [row for row in sources['outputs'] if row['file'] not in names] + outputs
    SOURCES.write_text(json.dumps(sources, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for row in outputs:
        print(row['file'], row['sha256'])


if __name__ == '__main__':
    main()
