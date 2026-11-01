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
# D-052: 관은 길을 가로막는 긴 성벽 띠(siteMarkers.ts의 PASS_WALL)이고 양 끝에서 산줄기가 이어진다.
PASS_WALL = (12, 3)
RIDGE_CELLS = 8


# 실제 섬 거점. 그 밖의 거점이 작은 땅에 갇히면(강이 빙 둘러 섬이 되면) 생성을 멈춘다.
# 가짜 섬: 강·호수 건너편에 다른 땅이 있는데 이보다 작은 땅에 갇힌 거점(가짜 섬은 9~170칸이었다).
# 바다로만 둘러싸인 실제 섬(대마국·주호 등)과 섬 안 호수는 건너편 땅이 없어 통과한다.
ISLAND_CELLS = 3000
# D-052 역사 기슭표. 강에서 본 191년 전후 치소의 쪽이다. 동서로 흐르는 강에는 북안·남안을, 남북으로 흐르는 강에는
# 동안·서안을 쓰므로 합류점은 강마다 맞는 쪽이 골라진다. 본류(장강·황하)와 지류의 기슭이 다르면 {'major', 'other'}로
# 나눈다(하내는 黃河 북안이면서 沁水 남안이다). 주된 근거는 水經注 經·注의
# 「又東過某縣南/北」이다. 표에 있는 거점은 좌표보다 이 표를 따르고, 없는 거점은 좌표와 실제 강 중심선으로 정한다.
BANK_OVERRIDES = {
    '천수': ('남안',),  # 冀縣 「(渭水)又東過冀縣北」
    '한중': ('북안',),  # 南鄭 「東過南鄭縣南」
    '강주': ('북안',),  # 江州 「郡治江州巴水北」, 長江 북안(嘉陵江 기슭은 남성 이전 시기 미상)
    '영안': ('북안',),  # 魚復 「又東過魚復縣南」
    '업': ('남안',),  # 鄴 「(漳水)…過鄴縣西」, 洹水 「過鄴縣南」 사이(유력)
    '하내': {'major': ('북안',), 'other': ('남안', '서안')},  # 懷縣 黃河 북안, 「(沁水)又東過懷縣之北」 沁水 남안
    '양양': ('남안',),  # 襄陽 「又東過襄陽縣北」
    '강하': {'major': ('북안', '서안'), 'other': ('북안',)},  # 郤月城 「沔左有郤月城」(漢水 북안), 長江 북서안
    '무릉': ('북안',),  # 臨沅 「縣南臨沅水」
    '영릉': ('동안',),  # 泉陵 「(湘水)又東北過泉陵縣西」(유력)
    '건녕': ('동안',),  # 味縣·南盤江 기슭은 사료 미확인(UNKNOWN), 임시값
    '교지': ('북안', '동안'),  # 羸𨻻 紅河 동북쪽(유력)
    '양평관': ('북안',),  # 白馬城 「南面沔川」
    '남안': ('북안',),  # 獂道 「又東過獂道縣南」(유력)
    '진창': ('북안',),  # 陳倉 「又東過陳倉縣西」(불확실)
    '서성': ('북안',),  # 西城 「又東過西城縣南」(유력)
    '강양': ('북안',),  # 江陽 「又東過江陽縣南」
    '임강': ('북안',),  # 臨江 「江水又東逕臨江縣南」
    '사룡': ('서안',),  # 邪龍 巍山(불확실)
    '이릉': ('북안',),  # 夷陵 「北對夷陵縣之故城，城南臨大江」
    '유수구': ('북안',),  # 濡須口, 濡須水가 長江 북안으로 드는 어귀
    '서새산': ('남안',),  # 西塞 「江之右岸…謂之西塞」
    '적벽': ('남안',),  # 「右逕赤壁山北」(유력, 蒲圻설)
    '남창': ('동안',),  # 南昌 「又北過南昌縣西」
    '부춘': ('북안',),  # 富春 「浙江又東北逕富春縣南」
    '창오': ('북안', '동안'),  # 廣信(梧州설) 西江 북안·桂江 동안(桂江 불확실)
    '서안평': ('북안', '서안'),  # 丹東 일대 鴨綠江 북서안(유력)
    '국내성': ('북안',),  # 集安 鴨綠江 북안
    '백제국': ('남안',),  # 하남위례성(풍납토성)설(유력)
    '부여': ('동안',),  # 東團山 松花江 동안(유력)
}
BANK_VECTORS = {'북안': (0, -1), '남안': (0, 1), '서안': (-1, 0), '동안': (1, 0)}


def pass_axis(site, data):
    """화면 passAxis와 같다. 관을 지나는 땅길 이웃 쪽 단위 벡터의 가로·세로 성분 합이 큰 쪽이 길 방향이다."""
    by_id = {row['id']: row for row in data['sites']}
    dx = dy = 0.0
    for route in data['routes']:
        if not route.get('enabled', True) or site['id'] not in (route['from'], route['to']):
            continue
        other = by_id[route['to'] if route['from'] == site['id'] else route['from']]['position']
        length = math.hypot(other['x'] - site['position']['x'], other['y'] - site['position']['y'])
        if length:
            dx += abs(other['x'] - site['position']['x']) / length
            dy += abs(other['y'] - site['position']['y']) / length
    return 'ew' if dx > dy else 'ns'


def site_boxes():
    """거점마다 (거점, 중심 칸 x·y, 가로·세로 반지름 칸, 관 방향)을 낸다."""
    data = json.loads(PROFILE['sites'].read_text(encoding='utf-8'))
    for site in data['sites']:
        if site['kind'] == 'PORT':
            continue
        cx, cy = int(site['position']['x'] // 2), int(site['position']['y'] // 2)
        if site['kind'] == 'PASS':
            axis = pass_axis(site, data)
            width, height = PASS_WALL if axis == 'ns' else PASS_WALL[::-1]
            yield site, cx, cy, int(width / 4 + 0.999), int(height / 4 + 0.999), axis
            continue
        units = LEVEL_UNITS[site.get('level', 5)] if site['kind'] == 'CITY' else FACILITY_UNITS[site['kind']]
        radius = int(units / 4 + 0.999)
        yield site, cx, cy, radius, radius, None


def centerline(river):
    for part in river['path'].split('M')[1:]:
        points = [tuple(float(v) / 2 for v in p.split(',')) for p in part.split('L')]
        yield from zip(points, points[1:])


def nearest(segments, cx, cy):
    best = None
    for (ax, ay), (bx, by) in segments:
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy)))
        px, py = ax + t * dx, ay + t * dy
        d = math.hypot(cx - px, cy - py)
        if best is None or d < best[0]:
            best = (d, px, py, dx, dy)
    return best


def bank_name(nx, ny):
    """강에서 본 거점 방향(nx, ny; 아래가 +y)을 기슭 이름으로 바꾼다."""
    if abs(ny) >= abs(nx):
        return '북안' if ny < 0 else '남안'
    return '서안' if nx < 0 else '동안'


def bank_shields(pixels, index, rivers, crossings=None):
    """강 기슭을 지키는 마른 땅을 정한다(D-052). 강가 거점마다 표식 칸과 거점 쪽 반원(표식 반지름+2칸)에서
    강 칸을 걷어 낸다. 그 뒤 reconnect_rivers가 이 땅을 피해 끊긴 강을 다시 이으므로 강은 기슭 반대쪽으로만 돈다.
    거점 기슭은 BANK_OVERRIDES(사료)를, 없으면 거점 좌표와 실제 강 중심선을 따른다. 거점을 강 고리로 두르지 않는다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    river = index['river']
    out = list(pixels)
    shields, forbid, banks, ambiguous, per_site = set(), set(), [], [], []
    crossings = [] if crossings is None else crossings
    lines = [(line, river_width(line)) for line in rivers if river_width(line)]
    for site, cx, cy, rx, ry, _axis in site_boxes():
        radius = max(rx, ry)
        mx, my = cx + 0.5, cy + 0.5
        mine = set()
        for y in range(cy - ry, cy + ry + 1):
            for x in range(cx - rx, cx + rx + 1):
                if 0 <= x < w and 0 <= y < h:
                    shields.add(y * w + x)
        for line, width in lines:
            hit = nearest(centerline(line), mx, my)
            if hit is None or hit[0] > radius + width + 2:
                continue
            d, px, py, dx, dy = hit
            sides = BANK_OVERRIDES.get(site['name'])
            if isinstance(sides, dict):
                sides = sides['major' if line.get('major') else 'other']
            if sides:
                # 동서로 흐르는 구간이면 북안·남안, 남북이면 동안·서안을 고른다. 맞는 축이 없으면 있는 값을 쓴다.
                flows_east = abs(dx) >= abs(dy)
                fitting = [side for side in sides if (side in ('북안', '남안')) == flows_east]
                nx, ny = BANK_VECTORS[(fitting or list(sides))[0]]
            elif d < 0.75:
                ambiguous.append(site['name'])
                continue
            else:
                nx, ny = (mx - px) / d, (my - py) / d
            # 반지름+2칸은 강을 걷어 내는 곳, 반지름+4칸은 다시 이을 때 새 강이 지나지 못하는 곳이다(이미 물인 칸은 지난다).
            reach = radius + 4
            for y in range(cy - reach, cy + reach + 1):
                for x in range(cx - reach, cx + reach + 1):
                    ox, oy = x + 0.5 - mx, y + 0.5 - my
                    if not (0 <= x < w and 0 <= y < h) or ox * nx + oy * ny < -1:
                        continue
                    distance = math.hypot(ox, oy)
                    # 이미 물인 칸(다른 강·본류)은 막지 않는다. 지류 기슭 방패가 옆 본류를 막지 않게 한다.
                    if distance <= reach and (distance <= radius + 2 or pixels[y * w + x] not in water):
                        forbid.add(y * w + x)
                    if distance <= radius + 2:
                        shields.add(y * w + x)
                        mine.add(y * w + x)
            banks.append({'site': site['name'], 'bank': bank_name(nx, ny), 'major': bool(line.get('major')),
                          'source': '사료' if sides else '좌표'})
            length = math.hypot(dx, dy) or 1.0
            crossings.append((cx, cy, radius, nx, ny, dx / length, dy / length, width))
        if mine:
            per_site.append((cx, cy, radius, mine))
    if ambiguous:
        raise SystemExit(f'좌표로 기슭을 정할 수 없는 거점(BANK_OVERRIDES에 사료 기슭을 적으세요): {sorted(set(ambiguous))}')
    for k in shields:
        if out[k] == river:
            x, y = k % w, k // w
            around = [out[(y + j) * w + x + i] for j in (-1, 0, 1) for i in (-1, 0, 1)
                      if 0 <= x + i < w and 0 <= y + j < h and out[(y + j) * w + x + i] not in water]
            out[k] = max(set(around), key=around.count) if around else index['plains']
    return out, shields | forbid, banks, per_site


def bridge_shields(pixels, index, per_site, blocked, original):
    """방패 하나가 강 줄기를 끊었으면 방패 가장자리에 남은 강 조각들을 방패 바깥(기슭 반대쪽)으로 돌아 잇는다.
    지류처럼 바다 연결 검사가 없는 강도 거점에서 끊기지 않게 한다. 거점 둘레 창 안에서만 찾는다."""
    w, h = GRID
    river = index['river']
    out = list(pixels)
    near4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
    for cx, cy, radius, mine in per_site:
        span = radius + 14
        x0, x1, y0, y1 = max(0, cx - span), min(w - 1, cx + span), max(0, cy - span), min(h - 1, cy + span)
        edge = []
        for k in mine:
            if original[k] != river:
                continue
            x, y = k % w, k // w
            for dx, dy in near4:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and ny * w + nx not in blocked and out[ny * w + nx] == river:
                    edge.append((nx, ny))
        groups = []
        for cell in sorted(set(edge)):
            for group in groups:
                if any(abs(cell[0] - gx) <= 1 and abs(cell[1] - gy) <= 1 for gx, gy in group):
                    group.append(cell)
                    break
            else:
                groups.append([cell])
        water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
        # 강 하나가 지나가다 끊긴 경우(조각 둘)만 잇는다. 합류점처럼 셋 이상이면 모두 이을 때 거점이 갇힌다.
        if len(groups) != 2:
            continue
        for first, second in zip(groups, groups[1:]):
            # 창 안에서 이미 물로 이어져 있으면 새 물길을 내지 않는다(겹친 물길이 거점을 섬으로 가둔다).
            seen = set(first)
            queue = list(first)
            for ax, ay in queue:
                for dx, dy in near4:
                    nx, ny = ax + dx, ay + dy
                    if x0 <= nx <= x1 and y0 <= ny <= y1 and (nx, ny) not in seen and out[ny * w + nx] in water:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            if seen & set(second):
                continue
            previous = {cell: None for cell in first}
            queue = list(first)
            goal = None
            targets = set(second)
            for at in queue:
                if at in targets:
                    goal = at
                    break
                ax, ay = at
                for dx, dy in near4:
                    nx, ny = ax + dx, ay + dy
                    if x0 <= nx <= x1 and y0 <= ny <= y1 and (nx, ny) not in previous and ny * w + nx not in blocked:
                        previous[(nx, ny)] = at
                        queue.append((nx, ny))
            at = goal
            while at is not None:
                ax, ay = at
                for dx, dy in ((0, 0), (1, 0), (0, 1)):
                    k = (ay + dy) * w + ax + dx
                    if 0 <= ax + dx < w and 0 <= ay + dy < h and k not in blocked and out[k] != river:
                        if out[k] not in (index['deepSea'], index['sea'], index['shallow'], index['lake']):
                            out[k] = river
                at = previous[at]
    return out


def clear_sites(pixels, index):
    """표식 칸에 남은 물은 주변 땅으로 메운다. 강은 push_rivers가 이미 기슭 반대쪽으로 옮겼다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    out = list(pixels)
    boxes = []
    for _site, cx, cy, rx, ry, _axis in site_boxes():
        box = [(x, y) for y in range(cy - ry, cy + ry + 1) for x in range(cx - rx, cx + rx + 1)
               if 0 <= x < w and 0 <= y < h]
        boxes.append(box)
    for box in boxes:
        land = [out[y * w + x] for x, y in box if out[y * w + x] not in water]
        fill = max(set(land), key=land.count) if land else index['plains']
        for x, y in box:
            if out[y * w + x] in water:
                out[y * w + x] = fill
    return out, {y * w + x for box in boxes for x, y in box}


def pass_ridges(pixels, index, blocked):
    """관 성벽 양 끝에서 성벽 방향으로 산줄기를 잇는다(D-052). 길은 관문으로만 지날 수 있다는 걸 지형으로 보인다.
    물과 다른 거점 자리는 덮지 않는다. 끝으로 갈수록 한 칸씩 두꺼워진다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    out = list(pixels)
    for _site, cx, cy, rx, ry, axis in site_boxes():
        if axis is None:
            continue
        along, half = (rx, ry) if axis == 'ns' else (ry, rx)
        for sign in (-1, 1):
            for step in range(1, RIDGE_CELLS + 1):
                thick = half + (1 if step > RIDGE_CELLS // 2 else 0)
                for side in range(-thick, thick + 1):
                    a, b = sign * (along + step), side
                    x, y = (cx + a, cy + b) if axis == 'ns' else (cx + b, cy + a)
                    k = y * w + x
                    if 0 <= x < w and 0 <= y < h and k not in blocked and out[k] not in water:
                        out[k] = index['mountains']
    return out


def check_banks(pixels, index, original, shields):
    """새로 낸 강 칸(원래 강이 아니던 칸)이 기슭 방패(거점 쪽 반원, 재연결이 강을 못 내는 곳) 안에 있으면 멈춘다.
    방패는 강마다 그 강의 기슭 방향으로 만들고 이미 물인 칸은 빼므로, 두 강 사이 거점도 강마다 정확히 본다.
    재연결·복원이 기슭 쪽으로 강을 내는 회귀를 막는다."""
    river = index['river']
    wrong = sorted({(k % GRID[0] * 2, k // GRID[0] * 2) for k in shields
                    if pixels[k] == river and original[k] != river})
    if wrong:
        raise SystemExit(f'기슭 방패 안에 새 강이 난 곳(지도 좌표): {wrong[:20]}')


def check_islands(pixels, index):
    """강·호수 건너편에 다른 땅이 있는데 거점이 작은 땅(ISLAND_CELLS 미만)에 갇혀 있으면 멈춘다. 바다로만 둘러싸인
    실제 섬은 건너편 땅이 없고, 섬 안 호수는 건너도 같은 땅이라 통과한다."""
    w, h = GRID
    land_water = {index[name] for name in ('lake', 'river')}
    sea = {index[name] for name in ('deepSea', 'sea', 'shallow')}
    near = lambda x, y: ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
    inside = lambda x, y: 0 <= x < w and 0 <= y < h
    trapped = []
    for site, cx, cy, _rx, _ry, _axis in site_boxes():
        land, queue, shore = {(cx, cy)}, [(cx, cy)], set()
        for ax, ay in queue:
            if len(land) >= ISLAND_CELLS:
                break
            for nx, ny in near(ax, ay):
                if not inside(nx, ny) or (nx, ny) in land:
                    continue
                kind = pixels[ny * w + nx]
                if kind in land_water:
                    shore.add((nx, ny))
                elif kind not in sea:
                    land.add((nx, ny))
                    queue.append((nx, ny))
        if len(land) >= ISLAND_CELLS or not shore:
            continue
        # 강·호수 칸을 따라가 이 땅이 아닌 땅에 닿으면 강에 갇힌 것이다.
        seen, queue, across = set(shore), list(shore), False
        for ax, ay in queue:
            for nx, ny in near(ax, ay):
                if not inside(nx, ny) or (nx, ny) in seen:
                    continue
                kind = pixels[ny * w + nx]
                if kind in land_water:
                    seen.add((nx, ny))
                    queue.append((nx, ny))
                elif kind not in sea and (nx, ny) not in land:
                    across = True
                    break
            if across:
                break
        if across:
            trapped.append(f"{site['name']}({len(land)}칸)")
    if trapped:
        raise SystemExit(f'섬처럼 갇힌 거점: {trapped}')


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
                # 남은 강폭으로 이미 물이 이어져 있으면(방패가 강 한쪽만 걷어 낸 경우) 새 물길을 내지 않는다.
                margin = 40
                x0, x1 = min(start[0], goal[0]) - margin, max(start[0], goal[0]) + margin
                y0, y1 = min(start[1], goal[1]) - margin, max(start[1], goal[1]) + margin
                seen, queue = {start}, [start]
                for ax, ay in queue:
                    for nx, ny in ((ax + 1, ay), (ax - 1, ay), (ax, ay + 1), (ax, ay - 1)):
                        if (x0 <= nx <= x1 and y0 <= ny <= y1 and inside(nx, ny) and (nx, ny) not in seen
                                and out[ny * w + nx] in water):
                            seen.add((nx, ny))
                            queue.append((nx, ny))
                if goal in seen:
                    i = j
                    continue
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


def join_major_rivers(pixels, index, rivers, blocked):
    """장강·황하 조각이 기슭 방패에 막혀 바다로 이어지지 않으면, 그 물 덩어리에서 바다로 이어진 물까지 방패와 거점
    자리를 피하는 가장 짧은 길로 2칸 폭 물길을 낸다. 길이 없으면 그대로 두고 check_water가 멈춘다."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    sea = {index['deepSea'], index['sea']}
    out = list(pixels)
    near = lambda x, y: ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
    inside = lambda x, y: 0 <= x < w and 0 <= y < h

    def flood(starts, passable):
        seen = set(starts)
        queue = list(starts)
        for ax, ay in queue:
            for nx, ny in near(ax, ay):
                if inside(nx, ny) and (nx, ny) not in seen and passable(nx, ny):
                    seen.add((nx, ny))
                    queue.append((nx, ny))
        return seen

    reach = None
    for line in rivers:
        if not line.get('major') or line['rank'] != 1 and line['rank'] != 3:
            continue
        for cells in river_cells(line):
            x, y = cells[0]
            if not inside(x, y) or out[y * w + x] not in water:
                continue
            if reach is None:
                reach = flood([(i % w, i // w) for i in range(w * h) if out[i] in sea],
                              lambda nx, ny: out[ny * w + nx] in water)
            if (x, y) in reach:
                continue
            piece = flood([(x, y)], lambda nx, ny: out[ny * w + nx] in water)
            previous = {cell: None for cell in piece}
            queue = list(piece)
            goal = None
            for at in queue:
                if at in reach:
                    goal = at
                    break
                for nx, ny in near(*at):
                    if inside(nx, ny) and (nx, ny) not in previous and ny * w + nx not in blocked:
                        previous[(nx, ny)] = at
                        queue.append((nx, ny))
            at = goal
            while at is not None and at not in piece:
                ax, ay = at
                for dx, dy in ((0, 0), (1, 0), (0, 1)):
                    k = (ay + dy) * w + ax + dx
                    if inside(ax + dx, ay + dy) and k not in blocked and out[k] not in water:
                        out[k] = index['river']
                        reach.add((ax + dx, ay + dy))
                at = previous[at]
            if goal is not None:
                reach |= piece
    return out


def restore_bank_channels(pixels, index, crossings, original, blocked):
    """방패가 강의 시작·끝 구간을 통째로 걷어 내 거점 옆에 강이 남지 않았으면, 원래 강이 지나던 길이만큼 기슭 반대쪽
    (표식 반지름+2칸)에 강 방향으로 2칸 폭 물길을 다시 그린다(한중·양평관의 漢水 상류처럼)."""
    w, h = GRID
    water = {index[name] for name in ('deepSea', 'sea', 'shallow', 'lake', 'river')}
    out = list(pixels)
    for cx, cy, radius, nx, ny, tx, ty, width in crossings:
        mx, my = cx + 0.5, cy + 0.5
        reach = radius + 6
        river_side, along = 0, []
        for y in range(cy - reach, cy + reach + 1):
            for x in range(cx - reach, cx + reach + 1):
                if not (0 <= x < w and 0 <= y < h):
                    continue
                ox, oy = x + 0.5 - mx, y + 0.5 - my
                if math.hypot(ox, oy) > reach:
                    continue
                if out[y * w + x] in water and ox * nx + oy * ny < -1:
                    river_side += 1
                if original[y * w + x] == index['river']:
                    along.append(ox * tx + oy * ty)
        if river_side or not along:
            continue
        offset = radius + 2
        for extra in range(2):
            previous = None
            for step in range(math.floor(min(along)), math.ceil(max(along)) + 1):
                x = math.floor(mx + tx * step - nx * (offset + extra))
                y = math.floor(my + ty * step - ny * (offset + extra))
                # 대각선으로 한 번에 두 축이 바뀌면 사이 칸을 채워 상하좌우로 이어지게 한다.
                cells = [(x, y)] if previous is None or previous[0] == x or previous[1] == y else [(previous[0], y), (x, y)]
                for cx2, cy2 in cells:
                    k = cy2 * w + cx2
                    if 0 <= cx2 < w and 0 <= cy2 < h and k not in blocked and out[k] not in water:
                        out[k] = index['river']
                previous = (x, y)
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
        before_shields = pixels
        crossings = []
        pixels, shields, banks, per_site = bank_shields(pixels, index, data['rivers'], crossings)
        pixels, blocked = clear_sites(pixels, index)
        pixels = bridge_shields(pixels, index, per_site, blocked | shields, before_shields)
        pixels = pass_ridges(pixels, index, blocked)
        pixels = reconnect_rivers(pixels, index, data['rivers'], blocked | shields)
        pixels = join_major_rivers(pixels, index, data['rivers'], blocked | shields)
        pixels = restore_bank_channels(pixels, index, crossings, before_shields, blocked | shields)
        check_water(pixels, index, data['rivers'])
        check_islands(pixels, index)
        check_banks(pixels, index, before_shields, shields)
        report = SAN10 / 'river-banks.json'
        report.write_text(json.dumps({'note': '강가 거점이 놓인 기슭(거점 좌표와 실제 강 중심선 기준). 생성 결과다.',
                                      'banks': banks}, ensure_ascii=False, indent=1) + '\n', newline='\n')
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
