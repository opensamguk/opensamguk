"""Codex 생성 원본을 화면용 도트 자산으로 줄인다 (INT-20, D-047).

Run: python3 tools/pixel-assets/build.py <원본 폴더>

원본 폴더에는 icons-a.png, icons-b.png, keyart.png가 있어야 한다. 원본은 저장소에 넣지 않고
sources.json에 해시만 남긴다. 같은 원본이면 같은 결과가 나온다.
"""

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/web/src/art'
# 시트 이름: (열, 행, 저장 폴더, 이름들)
SHEETS = {
    'icons-a.png': (4, 2, 'icons', ['domestic', 'military', 'strategy', 'personal', 'nation', 'main', 'turns', 'map']),
    'icons-b.png': (4, 2, 'icons', ['diplomacy', 'operations', 'records', 'ranking', 'battle', 'personnel', 'help', 'messages']),
    'flags.png': (2, 1, 'flag', ['tall', 'square']),
}
# 지도 표식은 한 장씩 크게 생성한 탑다운 그림이다 (원본 폴더의 markers/). 확대하면 화면을 채우므로 128px판과
# 멀리 볼 때 쓰는 32px판을 함께 만든다. 규모(D-048): 0 무, 1 수=port, 2 진=field, 3 관=pass, 4 이, 5 소,
# 6 중, 7 대, 8 특, 9 경. ruin은 폐허 상태, ford는 나루.
MARKERS = ['level-0', 'level-4', 'level-5', 'level-6', 'level-7', 'level-8', 'level-9', 'ruin', 'port', 'pass', 'field', 'ford']
MARKER_LARGE = 128
MARKER_COLORS = 32
ICON = 32
ICON_COLORS = 16
KEYART = (480, 270)
KEYART_COLORS = 48


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def background(r, g, b):
    # 자홍 배경과 그 번짐. 붉은 술·주칠은 초록이 낮아도 파랑이 낮아 남는다.
    return r > 140 and b > 140 and g < 120 and abs(r - b) < 90


def main_box(alpha):
    # 넓혀 자른 칸에는 옆 아이콘 조각이 들어온다. 가장 큰 덩어리와 그 가까이의 조각(술, 끈)만 남긴다.
    small = alpha.resize((alpha.width // 4, alpha.height // 4), Image.Resampling.BOX)
    small = small.point(lambda a: 255 if a else 0).filter(ImageFilter.MaxFilter(7))
    w, h = small.size
    px = small.load()
    seen = set()
    parts = []
    for y in range(h):
        for x in range(w):
            if not px[x, y] or (x, y) in seen:
                continue
            stack, part = [(x, y)], []
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                part.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        stack.append((nx, ny))
            parts.append(part)
    if not parts:
        raise SystemExit('빈 칸이 있습니다')
    biggest = max(parts, key=len)
    xs = [p[0] for p in biggest]
    ys = [p[1] for p in biggest]
    return (min(xs) * 4, min(ys) * 4, (max(xs) + 1) * 4, (max(ys) + 1) * 4)


def icon(cell, size=ICON, colors=ICON_COLORS):
    rgb = cell.convert('RGB')
    w, h = rgb.size
    px = rgb.load()
    alpha = Image.new('L', (w, h), 0)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            if not background(*px[x, y]):
                ap[x, y] = 255
    # 원본 한 도트가 8px 안팎이라 5px 열기로 번짐 점만 지운다.
    alpha = alpha.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    box = main_box(alpha)
    alpha = alpha.crop(box)
    rgb = rgb.crop(box)
    box = alpha.getbbox()
    if box is None:
        raise SystemExit('빈 칸이 있습니다')
    rgba = rgb.convert('RGBA')
    rgba.putalpha(alpha)
    rgba = rgba.crop(box)
    side = max(rgba.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(rgba, ((side - rgba.size[0]) // 2, side - rgba.size[1]))
    small = square.resize((size, size), Image.Resampling.BOX)
    solid = small.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    flat = Image.new('RGB', small.size, (0, 0, 0))
    flat.paste(small.convert('RGB'), mask=solid)
    quant = flat.quantize(colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGBA')
    quant.putalpha(solid)
    return quant


def split_cloth(flag):
    # 깃발의 흰 천을 떼어 낸다. 화면은 천 모양에 국가색을 칠하고 그 위에 깃대·테두리를 얹는다.
    base = flag.copy()
    cloth = Image.new('RGBA', flag.size, (0, 0, 0, 0))
    src, bp, cp = flag.load(), base.load(), cloth.load()
    for y in range(flag.height):
        for x in range(flag.width):
            r, g, b, a = src[x, y]
            if a and min(r, g, b) >= 215:
                cp[x, y] = (255, 255, 255, 255)
                bp[x, y] = (0, 0, 0, 0)
    return base, cloth


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    return {'file': str(path.relative_to(ROOT)).replace('\\', '/'), 'sha256': sha(path), 'bytes': path.stat().st_size}


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    sources = json.loads((OUT / 'sources.json').read_text(encoding='utf-8'))
    outputs = []
    for sheet, (cols, rows, folder, names) in SHEETS.items():
        image = Image.open(src / sheet)
        w, h = image.size
        for i, name in enumerate(names):
            col, row = i % cols, i // cols
            pad = w // 64
            cell = image.crop(
                (
                    max(0, col * w // cols - pad),
                    max(0, row * h // rows - pad),
                    min(w, (col + 1) * w // cols + pad),
                    min(h, (row + 1) * h // rows + pad),
                )
            )
            if folder == 'flag':
                base, cloth = split_cloth(icon(cell))
                outputs.append({'from': sheet, **save(base, OUT / folder / f'{name}.png')})
                outputs.append({'from': sheet, **save(cloth, OUT / folder / f'{name}-cloth.png')})
            else:
                outputs.append({'from': sheet, **save(icon(cell), OUT / folder / f'{name}.png')})
    for name in MARKERS:
        source = Image.open(src / 'markers' / f'{name}.png')
        outputs.append({'from': f'markers/{name}.png', **save(icon(source), OUT / 'map' / f'{name}.png')})
        large = icon(source, MARKER_LARGE, MARKER_COLORS)
        outputs.append({'from': f'markers/{name}.png', **save(large, OUT / 'map' / f'{name}@128.png')})
    # 관문은 지나는 도로 방향에 맞춘다. 원본은 남북 도로, 90도 돌려 동서 도로판을 만든다. 위에서 본 그림이라 돌려도 된다.
    for suffix in ('', '@128'):
        passes = Image.open(OUT / 'map' / f'pass{suffix}.png')
        outputs.append({'from': 'markers/pass.png', **save(passes.transpose(Image.Transpose.ROTATE_90), OUT / 'map' / f'pass-ew{suffix}.png')})
    art = Image.open(src / 'keyart.png').convert('RGB').resize(KEYART, Image.Resampling.BOX)
    art = art.quantize(KEYART_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    outputs.append({'from': 'keyart.png', **save(art, OUT / 'keyart.png')})
    for original in sources['originals']:
        if sha(src / original['file']) != original['sha256']:
            raise SystemExit(f"{original['file']}: 원본 해시가 sources.json과 다릅니다")
    sources['outputs'] = outputs
    (OUT / 'sources.json').write_text(json.dumps(sources, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == "__main__":
    main()
