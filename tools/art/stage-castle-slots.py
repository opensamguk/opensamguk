"""양식별 슬롯 그림(바닥 층, 건물 층)을 이미지 저장소로 옮긴다 (사용자 2026-11-17 "지역별로 새로 만든건 전부 웹에 넣어.").

입력: D:/codex-artifacts/int29-castle-slots-20261116/slot/<양식>/<키>-<단계>.png 와 같은 이름의 -ground.png, -building.png
      (1254 x 1254, 받침 마름모 가로 80%, 아래 꼭짓점 높이 85%, 바탕 마젠타)
출력: <이미지 저장소>/public/art/city/slots/<양식>/<키>-<단계>-ground.webp, -building.webp (나눈 층이 있을 때)
      나눈 층이 아직 없으면 <키>-<단계>.webp 한 장(바닥과 건물이 붙은 그림).
      공통 그림(빈 터, 공사 터)은 city/slots/common/.
마젠타는 투명으로, 가장자리 마젠타 번짐은 덜어 낸다. 크기는 768 x 768.
그 다음 이미지 저장소를 커밋하고 publish-ui-art.py --catalog-only --dest city/slots/<양식> --sha <커밋> 으로 목록에 올린다.

python -I tools/art/stage-castle-slots.py [양식 ...]
"""

import pathlib
import re
import sys

import numpy as np
from PIL import Image

SRC = pathlib.Path('D:/codex-artifacts/int29-castle-slots-20261116/slot')
REPO = pathlib.Path('E:/opensamguk-images')
SIZE = 768
NAME = re.compile(r'^[a-z_]+-[0-9]$')


def keyed(path: pathlib.Path) -> Image.Image:
    a = np.asarray(Image.open(path).convert('RGBA')).astype(np.int16)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    m = np.minimum(r, b) - g
    keep = np.clip((150 - m) / 90, 0, 1)
    out = a.copy()
    edge = (m > 60) & (m <= 150)
    out[..., 0] = np.where(edge, np.maximum(0, r - m // 2), r)
    out[..., 2] = np.where(edge, np.maximum(0, b - m // 2), b)
    out[..., 3] = np.where(m > 150, 0, np.where(edge, (al * keep).astype(np.int16), al))
    im = Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGBA')
    return im.resize((SIZE, SIZE), Image.LANCZOS)


def fresh(target: pathlib.Path, *sources: pathlib.Path) -> bool:
    """이미 만든 webp가 원본보다 새것이면 다시 만들지 않는다(전체를 다시 만들면 한 시간 걸린다, 2026-11-18)."""
    return target.exists() and all(target.stat().st_mtime >= s.stat().st_mtime for s in sources)


def save(im: Image.Image, target: pathlib.Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    im.save(target, 'WEBP', quality=86, method=6)


def stage(style: str) -> tuple[int, int]:
    folder = SRC / style
    out = REPO / 'public/art/city/slots' / style
    split = whole = 0
    for path in sorted(folder.glob('*.png')):
        if not NAME.match(path.stem):
            continue
        ground, building = folder / f'{path.stem}-ground.png', folder / f'{path.stem}-building.png'
        if ground.exists() and building.exists():
            if not fresh(out / f'{path.stem}-ground.webp', ground):
                save(keyed(ground), out / f'{path.stem}-ground.webp')
            if not fresh(out / f'{path.stem}-building.webp', building):
                save(keyed(building), out / f'{path.stem}-building.webp')
            (out / f'{path.stem}.webp').unlink(missing_ok=True)
            split += 1
        elif not fresh(out / f'{path.stem}.webp', path):
            save(keyed(path), out / f'{path.stem}.webp')
            whole += 1
        else:
            whole += 1
    return split, whole


def main() -> int:
    styles = sys.argv[1:] or sorted(p.name for p in SRC.iterdir() if p.is_dir() and not p.name.startswith(('_', 'central-')) and not p.name.endswith('.acl-old') and p.name != 'common')
    for style in styles:
        print(style, *stage(style), flush=True)
    for name in ('lot-out', 'build-out'):
        if (SRC / 'common' / f'{name}.png').exists():
            save(keyed(SRC / 'common' / f'{name}.png'), REPO / 'public/art/city/slots/common' / f'{name}.webp')
    return 0


if __name__ == '__main__':
    sys.exit(main())
