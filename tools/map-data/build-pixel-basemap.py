"""Build the game map pixel-art basemap from the shipped Natural Earth relief and GIS vectors only.

Run: python3 tools/map-data/build-pixel-basemap.py [--map san10]
The default is the 1000x700 integration map. --map san10 uses the 1400x1000 SAN10 inputs that
build-san10-relief.py cut from the same Natural Earth sources.
Offline and deterministic (Pillow only, no randomness): the same input bytes give the same PNG bytes.
Water, lakes and rivers come from the vectors; land bands come from the relief's colour (Natural Earth II
encodes land cover as hue and the grey high plateau as low saturation) and its local shading contrast.
"""
import colorsys
import hashlib
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
GEO = ROOT / 'apps/web/src/mapEditor/geodata'
OUT = ROOT / 'apps/web/src/main'
SAN10 = ROOT / 'resources/map-drafts/san10'
# SAN10 판의 표시 색 (INT-20). 고전 전략 지도처럼 밝은 초록 평지, 짙은 초록 산등성이, 선명한 파란 물이다.
# 지형 순서는 PALETTE와 같아서 화면은 색으로 같은 지형을 읽는다.
SAN10_PALETTE = {
    'deepSea': '#1e3a7a', 'sea': '#28509e', 'shallow': '#3d6fb8', 'lake': '#2c5faf', 'river': '#2b5eae',
    'plains': '#9ccb5c', 'farmland': '#b4d36c', 'grassland': '#83bf4f', 'forest': '#3f8f3c', 'loess': '#d6c07a',
    'desert': '#e4d4a0', 'hills': '#5fa045', 'mountains': '#2e6a34', 'highMountains': '#6b5d49', 'snow': '#f0ede4',
    'coastSand': '#e6d9a6',
}
PROFILES = {
    'integration': {'canvas': (1000, 700), 'vectors': GEO / 'natural-earth.json',
                    'relief': GEO / 'natural-earth-relief.webp', 'output': 'pixel-basemap'},
    'san10': {'canvas': (1400, 1000), 'vectors': SAN10 / 'pixel-sources.json', 'land': OUT / 'san10-basemap.json',
              'relief': SAN10 / 'natural-earth-relief.webp', 'output': 'san10-pixel-basemap',
              # INT-20 사용자 요청: 강과 산을 실제보다 크게 그린다.
              'exaggerate': True, 'sites': ROOT / 'resources/map/san10.json', 'palette': SAN10_PALETTE},
}
PROFILE = PROFILES[sys.argv[sys.argv.index('--map') + 1] if '--map' in sys.argv else 'integration']
CANVAS = PROFILE['canvas']
GRID = (CANVAS[0] // 2, CANVAS[1] // 2)  # one pixel = 2 units of the map viewBox
PALETTE = {
    'deepSea': '#2b4a6b', 'sea': '#3a6584', 'shallow': '#5d8ea6', 'lake': '#6fa3b5', 'river': '#4f86a3',
    'plains': '#b9bf86', 'farmland': '#a8b673', 'grassland': '#8fa865', 'forest': '#5f8a52', 'loess': '#cdb27a',
    'desert': '#dccb9c', 'hills': '#9c8d60', 'mountains': '#7d6a4c', 'highMountains': '#5f5140', 'snow': '#ebe6d6',
    'coastSand': '#d9c79a',
}
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
# Ordered bands on one axis: (band, upper limit, dither width). Dithering only mixes the two bands at one limit.
DEPTH = [('deepSea', 146, 6), ('sea', 164, 4), ('shallow', None, 0)]  # relief luminance of open water
HUE = [('desert', 44, 4), ('loess', 63, 4), ('grassland', 82, 4), ('green', None, 0)]  # relief hue in degrees
RELIEF = [('flat', 8, 2), ('hills', 19, 2), ('mountains', None, 0)]  # local shading contrast
ALPINE, SNOW = 0.12, 0.93  # relief saturation below ALPINE is the grey high plateau; value above SNOW is snow


def rings(d):
    for part in d.split('M')[1:]:
        yield [tuple(float(v) for v in p.split(',')) for p in part.rstrip('Z').split('L')]


def fill(paths, scale):
    """0/255 coverage; each path is filled even-odd (SVG fillRule) and separate paths are unioned."""
    size = (CANVAS[0] * scale, CANVAS[1] * scale)
    out = Image.new('1', size)
    for d in paths:
        shape = Image.new('1', size)
        for ring in rings(d):
            layer = Image.new('1', size)
            ImageDraw.Draw(layer).polygon([(x * scale - .5, y * scale - .5) for x, y in ring], fill=1)
            shape = ImageChops.logical_xor(shape, layer)
        out.paste(1, None, shape)
    return out.convert('L')


def river_width(river):
    """격자 칸 단위 강 폭. 과장 판은 장강·황하 4칸, 큰 강 2칸, 작은 강 1칸이고 아주 작은 강은 뺀다."""
    if PROFILE.get('exaggerate'):
        return 4 if river.get('major') else 2 if river['rank'] <= 6 else 1 if river['rank'] <= 8 else 0
    return 2 if river['rank'] <= 3 else 1


def strokes(rivers):
    """River lines on the grid: 1px, or 2px for scalerank <= 3."""
    out = Image.new('L', GRID)
    draw = ImageDraw.Draw(out)
    for river in rivers:
        width = river_width(river)
        if not width:
            continue
        line = []
        for part in river['path'].split('M')[1:]:
            a, b = [tuple(float(v) / 2 - .5 for v in p.split(',')) for p in part.split('L')]
            if line and line[-1] != a:
                draw.line(line, fill=255, width=width)
                line = []
            line += [b] if line else [a, b]
        draw.line(line, fill=255, width=width)
    return out


def flat(image):
    return list(image.get_flattened_data())


def mean(band, valid, radius, size):
    """Box mean of band over valid pixels only (normalized convolution), sampled at size."""
    num = ImageChops.multiply(band, valid).filter(ImageFilter.BoxBlur(radius)).resize(size, Image.Resampling.BOX)
    den = valid.filter(ImageFilter.BoxBlur(radius)).resize(size, Image.Resampling.BOX)
    return [n * 255 / d if d else 0. for n, d in zip(flat(num), flat(den))]


def grid(mask, at=128):
    return [v >= at for v in flat(mask.resize(GRID, Image.Resampling.BOX))]


def near(mask, pixels):
    return [v > 0 for v in flat(mask.filter(ImageFilter.MaxFilter(2 * pixels + 1)))]


def features(data, relief):
    land2, lake2 = fill(data['land'], 2), fill(data['lakes'], 2)
    r, g, b = relief.split()
    # Natural Earth II paints drainage blue on land; leave those pixels out of the land statistics.
    blue = [ImageChops.subtract(b, r, 1, -30), ImageChops.subtract(b, g, 1, 8)]
    drain = ImageChops.multiply(*(c.point(lambda v: 255 if v else 0) for c in blue))
    valid = ImageChops.subtract(ImageChops.subtract(land2, lake2), drain)
    lum = relief.convert('L')
    local = Image.new('L', lum.size)
    local.putdata([min(255, round(v)) for v in mean(lum, valid, 4, lum.size)])
    land = Image.new('L', GRID)
    land.putdata([255 if v else 0 for v in grid(land2)])
    major = strokes([river for river in data['rivers'] if river['rank'] <= 6])
    return {
        'land': grid(land2), 'lake': grid(lake2, 112), 'river': [v > 0 for v in flat(strokes(data['rivers']))],
        'coast': near(land, 1), 'sand': near(ImageChops.invert(land), 1),
        'farm': [v > 15 for v in flat(major.filter(ImageFilter.GaussianBlur(2.5)))],  # alluvial strip along rivers
        'rgb': list(zip(*(mean(c, valid, 6, GRID) for c in (r, g, b)))),
        'rough': mean(ImageChops.multiply(ImageChops.difference(lum, local), valid), valid, 6, GRID),
        'depth': mean(lum, ImageChops.invert(land2), 10, GRID),
    }


def band(value, bands, offset):
    for name, limit, width in bands:
        if limit is None or value < limit + offset * width:
            return name


def classify(f, i):
    o = (BAYER[i // GRID[0] % 4][i % GRID[0] % 4] + .5) / 16 - .5
    if f['lake'][i]:
        return 'lake'
    if not f['land'][i]:
        return 'shallow' if f['coast'][i] else band(f['depth'][i], DEPTH, o)
    if f['river'][i]:
        return 'river'
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in f['rgb'][i]))
    relief = band(f['rough'][i], RELIEF, o)
    if s < ALPINE + o * .02:
        if v > SNOW + o * .01:
            return 'snow'
        return 'highMountains' if relief == 'mountains' else 'mountains'
    if relief == 'mountains':
        return 'mountains'
    hue = band(h * 360, HUE, o)
    if relief == 'hills':
        return 'forest' if hue == 'green' else 'hills'
    if f['sand'][i]:
        return 'coastSand'
    if hue == 'green':
        return 'farmland' if f['farm'][i] else 'plains'
    return hue


def smooth_land(pixels, index, radius=2, rounds=2):
    """땅 칸을 5×5 다수결로 다듬어 잡티를 없애고 큰 덩어리로 뭉친다. 물 칸은 바꾸지 않는다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    for _ in range(rounds):
        out = list(pixels)
        for y in range(h):
            for x in range(w):
                i = y * w + x
                if pixels[i] in water:
                    continue
                counts = {}
                for dy in range(-radius, radius + 1):
                    for dx in range(-radius, radius + 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            kind = pixels[ny * w + nx]
                            if kind not in water:
                                counts[kind] = counts.get(kind, 0) + 1
                out[i] = max(sorted(counts), key=lambda kind: counts[kind])
        pixels = out
    return pixels


def widen_mountains(pixels, index):
    """산·고산을 둘레 1칸 넓힌다. 물 칸과 이미 산인 칸은 그대로 둔다. 고산이 산보다 먼저다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    out = list(pixels)
    for name in ('highMountains', 'mountains'):
        kind = index[name]
        for y in range(h):
            for x in range(w):
                i = y * w + x
                if pixels[i] in water or pixels[i] in (index['highMountains'], index['mountains']):
                    continue
                if any(0 <= x + dx < w and 0 <= y + dy < h and pixels[(y + dy) * w + x + dx] == kind
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    out[i] = kind
        pixels = out
        out = list(pixels)
    return pixels


def river_mouths(data, reach=40):
    """단순화한 해안선 때문에 바다에 못 닿은 장강·황하 하구를 가장 가까운 바다 칸까지 곧게 잇는다.
    다른 조각과 이어지지 않은 끝점 가운데 바다가 reach칸 안에 있는 것만 잇는다(상류 끝은 수백 칸 떨어져 빠진다)."""
    land = grid(fill(data['land'], 2))
    w, h = GRID
    # 지도 가장자리에서 이어지는 물만 바다다. 땅 속 호수는 하구가 아니다.
    ocean = [False] * (w * h)
    queue = [i for i in range(w * h) if not land[i] and (i % w in (0, w - 1) or i // w in (0, h - 1))]
    for i in queue:
        ocean[i] = True
    for i in queue:
        x, y = i % w, i // w
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            j = ny * w + nx
            if 0 <= nx < w and 0 <= ny < h and not land[j] and not ocean[j]:
                ocean[j] = True
                queue.append(j)
    ends = {}
    for river in data['rivers']:
        if not river.get('major'):
            continue
        for part in river['path'].split('M')[1:]:
            points = [tuple(float(v) for v in p.split(',')) for p in part.split('L')]
            for point in (points[0], points[-1]):
                ends[point] = ends.get(point, 0) + 1
    out = []
    for (x, y), count in sorted(ends.items()):
        if count != 1:
            continue
        cx, cy = int(x // 2), int(y // 2)
        best = None
        for dy in range(-reach, reach + 1):
            for dx in range(-reach, reach + 1):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < w and 0 <= ny < h and ocean[ny * w + nx]:
                    d = dx * dx + dy * dy
                    if best is None or d < best[0]:
                        best = (d, nx, ny)
        if best and best[0] > 0:
            tx, ty = best[1] * 2 + 1, best[2] * 2 + 1
            out.append({'rank': 1, 'major': True, 'path': f'M{x},{y}L{tx},{ty}'})
    return out


# 화면 표식 크기(지도 단위, apps/web/src/main/siteMarkers.ts의 LEVEL_UNITS·FACILITY_UNITS와 같다).
LEVEL_UNITS = [5, 6, 4, 6, 6, 7, 8, 9, 11, 13]
FACILITY_UNITS = {'PASS': 6, 'FIELD': 3.5}


def clear_sites(pixels, index):
    """강을 과장하면 강가 거점이 물에 잠긴다. 표식 칸은 땅으로 되돌리고 그리로 흐르던 물은
    거점 둘레 2칸 고리를 짧은 쪽으로 돌아 흐르게 한다. 항구 시설은 화면에 그리지 않아 뺀다. 다른 거점의 고리가 덮지 않게
    마지막에 모든 거점 자리를 한 번 더 땅으로 확정한다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    river = index['river']
    sites = json.loads(PROFILE['sites'].read_text(encoding='utf-8'))['sites']
    out = list(pixels)
    boxes = []
    for site in sites:
        if site['kind'] == 'PORT':
            continue
        units = LEVEL_UNITS[site.get('level', 5)] if site['kind'] == 'CITY' else FACILITY_UNITS[site['kind']]
        cx, cy = int(site['position']['x'] // 2), int(site['position']['y'] // 2)
        radius = int(units / 4 + 0.999)
        box = [(x, y) for y in range(cy - radius, cy + radius + 1) for x in range(cx - radius, cx + radius + 1)
               if 0 <= x < w and 0 <= y < h]
        boxes.append(box)
        if not any(out[y * w + x] in water for x, y in box):
            continue
        ring = [(x, y) for y in range(cy - radius - 2, cy + radius + 3) for x in range(cx - radius - 2, cx + radius + 3)
                if 0 <= x < w and 0 <= y < h and radius < max(abs(x - cx), abs(y - cy)) <= radius + 2]
        land = [out[y * w + x] for x, y in ring + box if out[y * w + x] not in water]
        fill = max(set(land), key=land.count) if land else index['plains']
        for x, y in box:
            if out[y * w + x] in water:
                out[y * w + x] = fill
        # 고리를 각도 64칸으로 나눠 물이 닿는 칸 사이의 빈 구간을 가장 긴 하나만 남기고 물로 잇는다.
        sectors = 64
        angle = lambda x, y: int((math.atan2(y - cy, x - cx) + math.pi) / (2 * math.pi) * sectors) % sectors
        wet = [False] * sectors
        for x, y in ring:
            if out[y * w + x] == river:
                wet[angle(x, y)] = True
        if wet.count(True) < 2:
            continue
        gaps, start = [], None
        first = wet.index(True)
        for step in range(1, sectors + 1):
            i = (first + step) % sectors
            if not wet[i] and start is None:
                start = i
            if wet[i] and start is not None:
                gaps.append((start, (i - start) % sectors))
                start = None
        if len(gaps) < 2:
            continue
        longest = max(gaps, key=lambda gap: gap[1])
        fill_sectors = {(g + k) % sectors for g, n in gaps if (g, n) != longest for k in range(n)}
        for x, y in ring:
            if angle(x, y) in fill_sectors and out[y * w + x] not in water:
                out[y * w + x] = river
    for box in boxes:
        land = [out[y * w + x] for x, y in box if out[y * w + x] not in water]
        fill = max(set(land), key=land.count) if land else index['plains']
        for x, y in box:
            if out[y * w + x] in water:
                out[y * w + x] = fill
    return out, {y * w + x for box in boxes for x, y in box}


def river_cells(river):
    """강 선을 칸 단위로 상하좌우로 이은 칸 줄로 바꾼다."""
    for part in river['path'].split('M')[1:]:
        points = [tuple(float(v) / 2 for v in p.split(',')) for p in part.split('L')]
        cells = []
        for (ax, ay), (bx, by) in zip(points, points[1:]):
            x, y, ex, ey = int(ax), int(ay), int(bx), int(by)
            if not cells or cells[-1] != (x, y):
                cells.append((x, y))
            while (x, y) != (ex, ey):
                if abs(ex - x) >= abs(ey - y):
                    x += 1 if ex > x else -1
                else:
                    y += 1 if ey > y else -1
                cells.append((x, y))
        yield cells


def reconnect_rivers(pixels, index, rivers, blocked):
    """거점 자리 때문에 강 줄기가 땅으로 끊긴 구간을 찾아, 거점 자리를 피해 앞뒤 물을 잇는 2칸 폭 물길을 낸다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    river = index['river']
    out = list(pixels)
    inside = lambda x, y: 0 <= x < w and 0 <= y < h
    for line in rivers:
        if not river_width(line):
            continue
        # 자료는 짧은 선분 조각이다. 끝과 처음이 맞닿는 조각을 한 줄로 이어 끊긴 구간이 여러 조각에 걸쳐도 찾는다.
        chains = []
        for cells in river_cells(line):
            if chains and abs(chains[-1][-1][0] - cells[0][0]) + abs(chains[-1][-1][1] - cells[0][1]) <= 1:
                chains[-1].extend(cells[1:] if chains[-1][-1] == cells[0] else cells)
            else:
                chains.append(list(cells))
        for cells in chains:
            cells = [c for c in cells if inside(*c)]
            i = 0
            while i < len(cells):
                x, y = cells[i]
                if out[y * w + x] in water or i == 0:
                    i += 1
                    continue
                start = cells[i - 1]
                j = i
                while j < len(cells) and out[cells[j][1] * w + cells[j][0]] not in water:
                    j += 1
                if j == len(cells):
                    break
                goal = cells[j]
                # 거점 자리를 피해 너비 우선으로 잇는다.
                previous = {start: None}
                queue = [start]
                for at in queue:
                    if at == goal:
                        break
                    ax, ay = at
                    for nx, ny in ((ax + 1, ay), (ax - 1, ay), (ax, ay + 1), (ax, ay - 1)):
                        if inside(nx, ny) and (nx, ny) not in previous and ny * w + nx not in blocked:
                            previous[(nx, ny)] = at
                            queue.append((nx, ny))
                at = goal if goal in previous else None
                while at is not None:
                    ax, ay = at
                    for dx, dy in ((0, 0), (1, 0), (0, 1)):
                        k = (ay + dy) * w + ax + dx
                        if inside(ax + dx, ay + dy) and k not in blocked and out[k] not in water:
                            out[k] = river
                    at = previous[at]
                i = j
    return out


def check_water(pixels, index, rivers):
    """장강·황하는 상류 끝에서 바다까지 물 칸으로 이어지고, 어떤 거점도 물 칸 위에 있지 않아야 한다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    sea = {index['deepSea'], index['sea']}
    sites = json.loads(PROFILE['sites'].read_text(encoding='utf-8'))['sites']
    wet = [site['name'] for site in sites
           if pixels[int(site['position']['y'] // 2) * w + int(site['position']['x'] // 2)] in water]
    if wet:
        raise SystemExit(f'물 칸 위 거점: {wet}')
    for river in rivers:
        if not river.get('major') or river['rank'] != 1 and river['rank'] != 3:
            continue
        for cells in river_cells(river):
            x, y = cells[0]
            if not (0 <= x < w and 0 <= y < h) or pixels[y * w + x] not in water:
                continue
            seen, queue = {(x, y)}, [(x, y)]
            for ax, ay in queue:
                if pixels[ay * w + ax] in sea:
                    break
                for nx, ny in ((ax + 1, ay), (ax - 1, ay), (ax, ay + 1), (ax, ay - 1)):
                    if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and pixels[ny * w + nx] in water:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            else:
                raise SystemExit(f'바다에 닿지 않는 큰 강 조각: {cells[0]}')


def main():
    data = json.loads(PROFILE['vectors'].read_bytes())
    inputs = [PROFILE['vectors'], PROFILE['relief']]
    if 'land' in PROFILE:
        data['land'] = json.loads(PROFILE['land'].read_bytes())['land']
        inputs.append(PROFILE['land'])
    if 'sites' in PROFILE:
        inputs.append(PROFILE['sites'])  # 거점 자리를 땅으로 되돌리고 강을 돌리는 데 쓴다
    if PROFILE.get('exaggerate'):
        data['rivers'] = data['rivers'] + river_mouths(data)
    f = features(data, Image.open(PROFILE['relief']).convert('RGB'))
    index = {name: i for i, name in enumerate(PALETTE)}
    pixels = [index[classify(f, i)] for i in range(GRID[0] * GRID[1])]
    if PROFILE.get('exaggerate'):
        pixels = smooth_land(pixels, index)
        pixels = widen_mountains(pixels, index)
        pixels, blocked = clear_sites(pixels, index)
        pixels = reconnect_rivers(pixels, index, data['rivers'], blocked)
        check_water(pixels, index, data['rivers'])
    image = Image.new('P', GRID)
    colors = PROFILE.get('palette', PALETTE)
    image.putpalette([int(c[k:k + 2], 16) for c in colors.values() for k in (1, 3, 5)])
    image.putdata(pixels)
    target = OUT / f"{PROFILE['output']}.png"
    image.save(target, optimize=True)
    meta = {
        'note': 'Derived only from Natural Earth (public domain): the shipped v5.1.2 vectors and Natural Earth II relief.',
        'script': 'tools/map-data/build-pixel-basemap.py',
        'sources': [{'file': path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                    for path in inputs],
        'grid': {'width': GRID[0], 'height': GRID[1], 'viewBoxUnitsPerPixel': 2},
        'palette': PROFILE.get('palette', PALETTE),
        'output': {'file': target.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()},
    }
    (OUT / f"{PROFILE['output']}.json").write_text(json.dumps(meta, indent=2) + '\n', newline='\n')
    print('Built', target.relative_to(ROOT), target.stat().st_size, 'bytes', meta['output']['sha256'])
    print({name: pixels.count(i) for name, i in index.items()})


if __name__ == '__main__':
    main()
