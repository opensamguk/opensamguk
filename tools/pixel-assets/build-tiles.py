"""Codex 생성 원본으로 확대 지형 타일과 길 연결 타일을 만든다 (INT-20, D-047).

Run: python3 tools/pixel-assets/build-tiles.py <원본 폴더>

원본 폴더에는 지형 13장이 있어야 한다. 원본은 저장소에 넣지 않고 sources.json에 해시만 남긴다.
지형 타일은 평균 색을 도트 바탕의 같은 지형 색에 맞춰 확대 전후 색이 이어지게 한다.
길과 다리는 코드로 그린다. 북·동·남·서 연결 16가지(비트 북 1, 동 2, 남 4, 서 8)와 곧은 다리 2가지다.
같은 원본이면 같은 결과가 나온다.
"""

import importlib.util
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/web/src/art'
# 확대 타일은 SAN10 표시 색 판으로 물들인다(고전 전략 지도풍의 밝은 초록·짙은 초록·선명한 파랑).
PALETTE = json.loads((ROOT / 'apps/web/src/main/san10-pixel-basemap.json').read_text(encoding='utf-8'))['palette']
PROMPTS = json.loads((Path(__file__).with_name('tiles-prompts.json')).read_text(encoding='utf-8'))['prompts']
TILE = 32
TILE_COLORS = 12
CROP = 0.4
# 산·고산·구릉은 2×2칸에 한 장으로 크게 그린다(apps/web/src/art/tiles.ts의 TERRAIN_TILE_CELLS와 같다).
BIG_TILES = {'hills': 2, 'mountains': 2, 'highMountains': 2}
# 도트 바탕 지형 이름: 원본 파일. 물 네 가지는 같은 물 그림을 각 지형 색으로 맞춘다.
TERRAIN_SOURCES = {
    'deepSea': 'water.png', 'sea': 'water.png', 'shallow': 'shallow.png', 'lake': 'water.png', 'river': 'water.png',
    'plains': 'plains.png', 'farmland': 'farmland.png', 'grassland': 'grassland.png', 'forest': 'forest.png',
    'loess': 'loess.png', 'desert': 'desert.png', 'hills': 'hills.png', 'mountains': 'mountains.png',
    'highMountains': 'high-mountains.png', 'snow': 'snow.png', 'coastSand': 'coast-sand.png',
}
NORTH, EAST, SOUTH, WEST = 1, 2, 4, 8

# 배경 빼기·축소는 지도 표식과 같은 도구를 쓴다.
spec = importlib.util.spec_from_file_location('pixel_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def seamless(image):
    """반 칸 밀어 낸 사본은 가장자리끼리 이어진다. 가장자리로 갈수록 그 사본을 섞어 칸 경계를 없앤다."""
    size = image.size[0]
    half = size // 2
    rolled = Image.new('RGB', image.size)
    for dx in (0, half):
        for dy in (0, half):
            rolled.paste(image.crop((dx, dy, dx + half, dy + half)), ((dx + half) % size, (dy + half) % size))
    mask = Image.new('L', image.size)
    mask.putdata([round(255 * min(1, min(x + .5, size - x - .5, y + .5, size - y - .5) / (half * .6)))
                  for y in range(size) for x in range(size)])
    return Image.composite(image, rolled, mask)


def terrain_tile(source, color, cells=1):
    image = Image.open(source).convert('RGB')
    w, h = image.size
    # 원본 한 장은 여러 칸 넓이의 풍경이다. 가운데 CROP만큼을 한 칸으로 써서 봉우리·나무 모양이 남게 한다.
    side = round(min(w, h) * CROP * (1.5 if cells > 1 else 1))
    left, top = (w - side) // 2, (h - side) // 2
    size = TILE * cells
    image = image.crop((left, top, left + side, top + side)).resize((size, size), Image.Resampling.BOX)
    image = seamless(image)
    target = [int(color[k:k + 2], 16) for k in (1, 3, 5)]
    pixels = list(image.get_flattened_data())
    mean = [sum(p[c] for p in pixels) / len(pixels) for c in range(3)]
    shift = [t - m for t, m in zip(target, mean)]
    image.putdata([tuple(max(0, min(255, round(p[c] + shift[c]))) for c in range(3)) for p in pixels])
    return image.quantize(TILE_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


# 길은 생성 그림 대신 코드로 그린다(INT-20). 칸 폭의 1/4쯤 되는 미색 띠에 옅은 테두리를 두르고, 두 방향이
# 직각으로 만나는 칸은 둥글게 굽힌다. 물 칸을 지나는 곧은 길은 나무다리다. 4배로 그려 줄인 뒤 색 수를 줄인다.
ROAD_FILL = (238, 226, 184, 255)
ROAD_EDGE = (176, 150, 98, 255)
PLANK = (150, 104, 56, 255)
PLANK_GAP = (96, 64, 36, 255)
SCALE = 4


def road_shape(mask, half, scale=SCALE):
    """mask 모양의 띠 덮개(L). half는 띠 반폭(타일 px)."""
    size = TILE * scale
    c = size // 2
    h = half * scale
    shape = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(shape)
    corners = {NORTH | EAST: (size, 0), EAST | SOUTH: (size, size), SOUTH | WEST: (0, size), WEST | NORTH: (0, 0)}
    if mask in corners:
        cx, cy = corners[mask]
        r = c
        draw.ellipse((cx - r - h, cy - r - h, cx + r + h, cy + r + h), fill=255)
        draw.ellipse((cx - r + h, cy - r + h, cx + r - h, cy + r - h), fill=0)
        # 바깥 모서리를 중심으로 한 고리의 타일 안쪽 4분의 1이 굽은 길이다.
        return shape
    draw.ellipse((c - h, c - h, c + h, c + h), fill=255)
    if mask & NORTH:
        draw.rectangle((c - h, 0, c + h, c), fill=255)
    if mask & SOUTH:
        draw.rectangle((c - h, c, c + h, size), fill=255)
    if mask & WEST:
        draw.rectangle((0, c - h, c, c + h), fill=255)
    if mask & EAST:
        draw.rectangle((c, c - h, size, c + h), fill=255)
    return shape


def flatten(big):
    small = big.resize((TILE, TILE), Image.Resampling.BOX)
    solid = small.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    flat = Image.new('RGB', small.size, (0, 0, 0))
    flat.paste(small.convert('RGB'), mask=solid)
    out = flat.quantize(6, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGBA')
    out.putalpha(solid)
    return out


def road_tiles():
    size = TILE * SCALE
    tiles = {}
    for mask in range(16):
        outer = road_shape(mask, 5)
        inner = road_shape(mask, 3.5)
        big = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        big.paste(ROAD_EDGE, mask=outer)
        big.paste(ROAD_FILL, mask=inner)
        tiles[mask] = flatten(big)
    return tiles


def bridge_tiles():
    """남북(5)·동서(10) 곧은 길이 물 칸을 지날 때의 나무다리."""
    size = TILE * SCALE
    big = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    left, right = size // 2 - 7 * SCALE, size // 2 + 7 * SCALE
    draw.rectangle((left, 0, right, size), fill=PLANK_GAP)
    for top in range(0, size, 4 * SCALE):
        draw.rectangle((left + SCALE, top + SCALE // 2, right - SCALE, top + 3 * SCALE), fill=PLANK)
    draw.rectangle((left, 0, left + SCALE, size), fill=PLANK_GAP)
    draw.rectangle((right - SCALE, 0, right, size), fill=PLANK_GAP)
    north = flatten(big)
    return {NORTH | SOUTH: north, EAST | WEST: north.transpose(Image.Transpose.ROTATE_90)}


# 강둑 (INT-20). 강·호수 칸에서 땅과 맞닿는 변에 모래 둑과 진한 물가 선을 도트로 그린다.
# mask 비트는 땅이 있는 쪽이다(북 1, 동 2, 남 4, 서 8). 두 변이 만나는 안쪽 모서리는 한 칸 둥글린다.
BANK = (217, 199, 154, 255)
BANK_EDGE = (150, 128, 84, 255)
BANK_WIDTH = 4


def bank_tiles():
    tiles = {}
    for mask in range(1, 16):
        tile = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
        draw = ImageDraw.Draw(tile)
        sides = {
            NORTH: (0, 0, TILE - 1, BANK_WIDTH - 1),
            SOUTH: (0, TILE - BANK_WIDTH, TILE - 1, TILE - 1),
            WEST: (0, 0, BANK_WIDTH - 1, TILE - 1),
            EAST: (TILE - BANK_WIDTH, 0, TILE - 1, TILE - 1),
        }
        edges = {
            NORTH: (0, BANK_WIDTH, TILE - 1, BANK_WIDTH),
            SOUTH: (0, TILE - BANK_WIDTH - 1, TILE - 1, TILE - BANK_WIDTH - 1),
            WEST: (BANK_WIDTH, 0, BANK_WIDTH, TILE - 1),
            EAST: (TILE - BANK_WIDTH - 1, 0, TILE - BANK_WIDTH - 1, TILE - 1),
        }
        for bit, box in sides.items():
            if mask & bit:
                draw.rectangle(box, fill=BANK)
        for bit, box in edges.items():
            if mask & bit:
                draw.rectangle(box, fill=BANK_EDGE)
        # 두 변이 만나는 모서리는 둑을 한 칸 더 채워 계단처럼 둥글린다.
        for a, b, x, y in ((NORTH, WEST, BANK_WIDTH, BANK_WIDTH), (NORTH, EAST, TILE - BANK_WIDTH - 2, BANK_WIDTH),
                           (SOUTH, WEST, BANK_WIDTH, TILE - BANK_WIDTH - 2), (SOUTH, EAST, TILE - BANK_WIDTH - 2, TILE - BANK_WIDTH - 2)):
            if mask & a and mask & b:
                draw.rectangle((x, y, x + 1, y + 1), fill=BANK_EDGE)
        tiles[mask] = tile
    return tiles


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    sources = json.loads((OUT / 'sources.json').read_text(encoding='utf-8'))
    names = sorted(set(TERRAIN_SOURCES.values()))
    originals = [o for o in sources['originals'] if not o['file'].startswith('tiles/')]
    for name in names:
        with Image.open(src / name) as image:
            size = list(image.size)
        originals.append({'file': f'tiles/{name}', 'sha256': build.sha(src / name), 'size': size,
                          'prompt': PROMPTS[name]})
    outputs = [o for o in sources['outputs'] if not o['from'].startswith(('tiles/', 'tools/pixel-assets/build-tiles'))]
    for terrain, name in TERRAIN_SOURCES.items():
        cells = BIG_TILES.get(terrain, 1)
        if terrain == 'lake':
            continue  # 확대하면 호수는 강 타일을 함께 쓴다(이어진 물이 얼룩져 보이지 않게). apps/web/src/art/tiles.ts
        color = PALETTE[terrain]
        outputs.append({'from': f'tiles/{name}', **build.save(terrain_tile(src / name, color, cells),
                                                               OUT / 'terrain' / f'{terrain}.png')})
    for mask, tile in road_tiles().items():
        outputs.append({'from': 'tools/pixel-assets/build-tiles.py', **build.save(tile, OUT / 'road' / f'road-{mask}.png')})
    for mask, tile in bank_tiles().items():
        outputs.append({'from': 'tools/pixel-assets/build-tiles.py', **build.save(tile, OUT / 'water' / f'bank-{mask}.png')})
    for mask, tile in bridge_tiles().items():
        outputs.append({'from': 'tools/pixel-assets/build-tiles.py', **build.save(tile, OUT / 'road' / f'bridge-{mask}.png')})
    sources['originals'] = originals
    sources['outputs'] = outputs
    (OUT / 'sources.json').write_text(json.dumps(sources, ensure_ascii=False, indent=2) + '\n', encoding='utf-8',
                                      newline='\n')
    print('terrain', len(TERRAIN_SOURCES), 'road', 16)


if __name__ == '__main__':
    main()
