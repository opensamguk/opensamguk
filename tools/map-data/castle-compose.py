"""INT-27 성 조립: Codex가 그린 성 부품(마젠타 배경)을 2:1 마름모 자리 격자에 놓아 큰 성 그림을 만든다.

python -I castle-compose.py <parts_dir> <out_dir> [name ...]

사용자 2026-11-14: "성 스프라이트가 화면을 가득 채워야 할 수도 있어. 한 그리드 안의 세세한 무언가 행동이라던지도 들어야 할 수 있어."
성 한 장을 조각으로 다시 그리면 조각마다 배치가 달라져 잇지 못했다. 그래서 부품을 자리 단위로 놓는다.

- 성은 한 변 N자리 마름모. 자리 하나는 화면 가로 W px, 세로 W/2 px 마름모다.
- 그리는 순서(화가 순서): 바닥 → 뒤쪽 성벽 → 안쪽 건물(깊이 순) → 앞쪽 받침·성벽·성문 → 모서리 누각.
- 결과: <out>/hd/<name>.png(큰 그림), <out>/<name>.png(1024 줄인 그림, 같은 틀), <out>/<name>.layout.json(자리마다 놓은 부품).
  게임 안 조립(집마다 짓기·불타기)도 같은 배치 정보를 쓴다.
"""
import json
import os
import random
import sys

import numpy as np
from PIL import Image

W = 512  # 자리 하나의 화면 가로(px)
WALL_H = W * 0.42  # 성벽: 밑선에서 여장 위 끝까지 높이
GATE_H = W * 0.95  # 성문: 밑선에서 문루 지붕 끝까지 높이
PLINTH_H = W * 0.07  # 받침 옆면 두께
FEATHER = 28  # 성벽 토막 이음매를 섞는 너비(px)
TOWER = W * 0.6  # 옛 모서리 망루 그림 가로(각루 그림이 없을 때)
CORNER = W * 0.62  # 모서리 각루 그림 가로

LEVELS = {
    # 경 > 특 > 대 > 중 > 소. 중·소는 크기가 같고 집이 드물다. 소(흙성)는 참고 그림(강하)처럼 누각이 없다.
    # 홀수 자리라 한 자리 폭 큰길이 정확히 가운데를 지나 네 변 한가운데 성문으로 간다. 가운데 건물은 큰길이 만나는 곳.
    'city-9': {'n': 11, 'mat': 'stone', 'core': 'palace-gold', 'core_size': 3, 'empty': 0.08, 'towers': True},
    'capital': {'n': 9, 'mat': 'stone', 'core': 'palace-gold', 'core_size': 3, 'empty': 0.1, 'towers': True},
    'city-7': {'n': 7, 'mat': 'stone', 'core': 'hall-grey', 'core_size': 1, 'empty': 0.12, 'towers': True},
    'city-6': {'n': 5, 'mat': 'stone', 'core': None, 'core_size': 0, 'empty': 0.2, 'towers': True},
    'city-5': {'n': 5, 'mat': 'earth', 'core': None, 'core_size': 0, 'empty': 0.3, 'towers': True},
}


def keyed(path, cache={}):
    """마젠타 배경을 알파로 바꾸고 불투명 영역으로 잘라 (그림, 가로) 를 돌려준다."""
    if path in cache:
        return cache[path]
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    mag = np.clip((np.minimum(a[..., 0], a[..., 2]) - a[..., 1]) / 255.0, 0, 1)
    alpha = np.clip((0.62 - mag) / 0.3, 0, 1)
    spill = np.clip(np.minimum(a[..., 0], a[..., 2]) - a[..., 1], 0, None) * (1 - alpha)
    rgb = a.copy()
    rgb[..., 0] -= spill
    rgb[..., 2] -= spill
    ys, xs = np.nonzero(alpha > 0.5)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    rgba = np.dstack([np.clip(rgb, 0, 255), alpha * 255])[y0:y1, x0:x1].astype(np.uint8)
    im = Image.fromarray(rgba, 'RGBA')
    cache[path] = im
    return im


def scaled(im, width):
    s = width / im.size[0]
    return im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.Resampling.LANCZOS)


def strip(path, slope, cut=0.12, measure=(0.15, 0.85)):
    """성벽·받침 토막을 이어 붙일 수 있게 바로잡는다(사용자 2026-11-14: "성벽이 끊겨보인다니까?").

    그린 토막은 기울기가 격자(±0.5)와 조금 다르고 양 끝에 마감면이 있다. 밑선 기울기를 재서 격자 기울기로
    기울여 맞추고(세로 밀기), 양 끝을 잘라 낸다. 그러면 같은 토막을 격자선을 따라 빈틈없이 이을 수 있다.
    돌려주는 것: (토막 그림, 왼쪽 끝 열의 밑선 높이, 밑선에서 위 끝까지 높이).
    """
    im = keyed(path)
    a = np.asarray(im)[..., 3] > 128
    h, w = a.shape
    xs, yb, yt = [], [], []
    # 밑선 기울기는 가운데에서 재고, 높이는 measure 구간(성문은 양 끝 성벽 부분)에서 잰다.
    for x in range(int(w * 0.15), int(w * 0.85)):
        rows = np.nonzero(a[:, x])[0]
        if len(rows):
            xs.append(x)
            yb.append(rows.max())
            yt.append(rows.min())
    fit_a, fit_b = np.polyfit(xs, yb, 1)
    k = slope - fit_a
    off = max(0.0, -k * w)
    height = int(h + abs(k) * w + 2)
    sheared = im.transform((w, height), Image.Transform.AFFINE, (1, 0, 0, -k, 1, -off), resample=Image.Resampling.BICUBIC)
    c0, c1 = int(w * cut), int(w * (1 - cut))
    piece = sheared.crop((c0, 0, c1, height))
    hs = []
    for x in range(int(w * measure[0]), int(w * measure[1])):
        rows = np.nonzero(a[:, x])[0]
        if len(rows):
            hs.append(rows.max() - rows.min())
    return piece, slope * c0 + fit_b + off, float(np.median(hs))


def compose(parts, name, cfg, out, walls_only=False):
    n, mat = cfg['n'], cfg['mat']
    rng = random.Random(name)
    half = W / 2
    quarter = W / 4
    margin_top = int(W * 1.6)  # 누각·문루가 위로 솟는 여유
    width = int(n * W + W)
    height = int(margin_top + n * half + W * 0.6)
    cx = width / 2
    top = margin_top

    def centre(i, j):
        """자리 (i, j)의 마름모 가운데. i는 위 꼭짓점에서 오른쪽 아래로, j는 왼쪽 아래로."""
        return cx + (i - j) * half, top + (i + j + 1) * quarter

    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    placed = []
    # 에이지 오브 엠파이어 2 방식(2026-11-14 분석): 성벽은 칸 단위 토막이고, 토막·누각·성문·집을 모두
    # 앞뒤 깊이(u+v, 자리 좌표) 순서로 그린다. 그래야 가까운 성벽이 성문 끝·누각 밑을 가리고 뒤쪽 누각은
    # 앞의 집에 가린다. 성문은 성벽을 끊은 자리에 놓는다.
    drawables = []  # (깊이, 밑 y, 그림, 왼쪽 위 x, 왼쪽 위 y)

    def add(depth, im, ox, oy):
        drawables.append((depth, oy + im.size[1], im, int(round(ox)), int(round(oy))))

    lx, ly = cx - n * half, top + n * quarter
    rx = cx + n * half
    bx, by = cx, top + n * half
    # 변마다: 왼쪽 끝 x, 그 점의 y, 기울기, x → 깊이.
    edges = {
        'back-left': (lx, ly, -0.5, lambda x: n - (x - lx) / half),
        'back-right': (cx, top, 0.5, lambda x: (x - cx) / half),
        'front-left': (lx, ly, 0.5, lambda x: (x - lx) / half + n),
        'front-right': (bx, by, -0.5, lambda x: n + n - (x - bx) / half),
    }

    def run(part, edge, xa, xb, target_h, lift=0.0, bias=0.0):
        """변 edge를 따라 xa..xb에 토막을 빈틈없이 잇고, 한 자리(가로 half px)씩 잘라 깊이별로 넣는다."""
        x0, y0, slope, depth_of = edges[edge]
        piece, base, tall = strip(os.path.join(parts, f'{part}.png'), slope)
        sc = target_h / tall
        piece = piece.resize((max(1, round(piece.size[0] * sc)), max(1, round(piece.size[1] * sc))), Image.Resampling.LANCZOS)
        base *= sc
        feather = min(FEATHER, piece.size[0] // 4)
        ramp = np.ones(piece.size[0])
        ramp[:feather] = np.linspace(0, 1, feather)
        faded = np.asarray(piece).copy()
        faded[..., 3] = (faded[..., 3] * ramp[None, :]).astype(np.uint8)
        faded = Image.fromarray(faded, 'RGBA')
        layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        x = xa
        first = True
        while x < xb - 0.5:
            span = min(piece.size[0], int(np.ceil(xb - x)) + 1)
            chunk = (piece if first else faded).crop((0, 0, span, piece.size[1]))
            first = False
            y = y0 + slope * (x - x0) + lift
            layer.alpha_composite(chunk, (int(round(x)), int(round(y - base))))
            x += piece.size[0] - feather
        # 한 자리씩 세로로 잘라 깊이를 준다(마지막 조각은 벽 두께만큼 오른쪽으로 더 받는다).
        k = int(np.floor((xa - x0) / half))
        while x0 + k * half < xb:
            c0 = max(int(round(x0 + k * half)), int(xa) - 2)
            c1 = int(round(x0 + (k + 1) * half))
            if x0 + (k + 1) * half >= xb:
                c1 = width
            box = (max(c0, 0), 0, min(c1, width), height)
            if box[2] > box[0]:
                sl = layer.crop(box)
                if sl.getbbox():
                    add(depth_of(x0 + (k + 0.5) * half) + bias, sl, box[0], 0)
            k += 1
        placed.append({'part': part, 'edge': edge, 'run': [round(xa, 1), round(xb, 1)], 'h': round(target_h, 1)})

    def gate_piece(part, edge, xc, target_h, measure, cut=0.02):
        """성문 토막을 변 edge 위 가운데 xc에 놓고 가로 범위를 돌려준다."""
        x0, y0, slope, depth_of = edges[edge]
        piece, base, tall = strip(os.path.join(parts, f'{part}.png'), slope, cut=cut, measure=measure)
        sc = target_h / tall
        piece = piece.resize((max(1, round(piece.size[0] * sc)), max(1, round(piece.size[1] * sc))), Image.Resampling.LANCZOS)
        base *= sc
        x = xc - piece.size[0] / 2
        y = y0 + slope * (x - x0)
        add(depth_of(xc), piece, x, y - base)
        placed.append({'part': part, 'edge': edge, 'x': round(xc, 1), 'h': round(target_h, 1), 'gate': True})
        return x, x + piece.size[0]

    def put(part, x, y, bbox_width, depth, tag=None):
        im = scaled(keyed(os.path.join(parts, f'{part}.png')), bbox_width)
        add(depth, im, x - im.size[0] / 2, y - im.size[1])
        placed.append({'part': part, 'x': round(x, 1), 'y': round(y, 1), 'w': round(bbox_width, 1), **(tag or {})})

    # 1. 바닥(가장 먼저).
    ground = 'ground-paved' if mat == 'stone' else 'ground-earth'
    for i in range(n):
        for j in range(n):
            x, y = centre(i, j)
            put(ground, x, y + quarter + 2, W * 1.02, -10, {'i': i, 'j': j, 'layer': 'ground'})

    # 2. 모서리 누각(각루). 성벽은 누각 면에서 끊는다.
    corner_part = f'corner-{mat}' if os.path.exists(os.path.join(parts, f'corner-{mat}.png')) else f'tower-{mat}'
    corner_w = CORNER if corner_part.startswith('corner') else TOWER
    # 누각 바닥(돌 받침 가로 ≈ 그림 가로의 0.66) 안쪽까지 성벽이 들어가 끝면이 누각에 가린다.
    inset = corner_w * 0.14 if cfg["towers"] else 0.0
    if cfg['towers']:
        for (x, y), d in (((cx, top), 0), ((lx, ly), n), ((rx, ly), n), ((bx, by), 2 * n)):
            put(corner_part, x, y + quarter * 0.4, corner_w, d + 0.05, {'corner': True})

    # 3. 성문: 네 변 한가운데. 성벽에 박힌 성문(gatewall-*)이 있으면 그것을 쓴다(높이는 양 끝 성벽 부분에서 잰다).
    mids = {'front-left': lx + n * quarter, 'front-right': bx + n * quarter, 'back-left': lx + n * quarter, 'back-right': cx + n * quarter}
    spans = {}
    for edge in ('back-left', 'back-right', 'front-left', 'front-right'):
        if os.path.exists(os.path.join(parts, f'gatewall-{mat}-{edge}.png')):
            # 성문 그림 양 끝의 성벽 마감면을 잘라 내고, 높이는 끝 바로 안쪽 성벽 부분에서 재 이웃 성벽과 맞춘다.
            spans[edge] = gate_piece(f'gatewall-{mat}-{edge}', edge, mids[edge], WALL_H, (0.12, 0.22), cut=0.1)
        elif edge.startswith('front'):
            spans[edge] = gate_piece(f'gate-{mat}-{edge}', edge, mids[edge], GATE_H, (0.15, 0.85))

    # 4. 성벽(성문 자리와 누각 면을 비우고) — 앞쪽 변은 받침도.
    ends = {'back-left': (lx, cx), 'back-right': (cx, rx), 'front-left': (lx, bx), 'front-right': (bx, rx)}
    for edge, (xa, xb) in ends.items():
        mat_part = f'wall-{mat}-{edge}'
        if edge.startswith('front'):
            plinth = 'plinth-left' if edge == 'front-left' else 'plinth-right'
            run(plinth, edge, xa, xb, PLINTH_H, lift=PLINTH_H, bias=-0.02)
        pieces = [(xa + inset, xb - inset)]
        if edge in spans:
            g0, g1 = spans[edge]
            pieces = [(xa + inset, g0 + FEATHER), (g1 - FEATHER, xb - inset)]
        for a, b in pieces:
            if b > a:
                run(mat_part, edge, a, b, WALL_H)

    # 5. 안쪽 건물. 가운데 큰 건물, 네 성문으로 가는 큰길은 비운다(--walls-only면 건너뛴다).
    mid = n // 2
    if walls_only:
        cfg = {**cfg, 'empty': 1.1, 'core': None}
    core, cs = cfg['core'], cfg['core_size']
    r = cs // 2
    taken = {(i, j) for i in range(mid - r, mid + r + 1) for j in range(mid - r, mid + r + 1)} if core else set()
    streets = {(i, j) for i in range(n) for j in range(n) if i == mid or j == mid}
    if mat == 'stone':
        pool = ['house-1', 'house-2', 'house-3', 'house-4', 'house-5', 'house-6', 'house-1', 'house-3', 'house-4']
        extras = ['shop-row', 'granary-small', 'barracks-small', 'tree-1', 'tree-2']
    else:
        pool = ['house-earth-1', 'house-earth-2', 'house-earth-3']
        extras = ['granary-small', 'tree-1', 'tree-2']
    for i in range(n):
        for j in range(n):
            if (i, j) in taken or (i, j) in streets:
                continue
            roll = rng.random()
            if roll < cfg['empty']:
                continue
            part = rng.choice(extras) if roll < cfg['empty'] + 0.18 else rng.choice(pool)
            if (abs(i - mid) == 1 or abs(j - mid) == 1) and mat == 'stone' and rng.random() < 0.35:
                part = 'shop-row'
            x, y = centre(i, j)
            put(part, x, y + quarter, W * 0.9, i + j + 1, {'i': i, 'j': j, 'size': 1})
    if core:
        x, y = centre(mid, mid)
        put(core, x, y + quarter * cs, W * max(cs * 0.9, 1.35), 2 * mid + 1 + r, {'i': mid, 'j': mid, 'size': cs})

    # 6. 깊이 순서로 그린다.
    for _, _, im, ox, oy in sorted(drawables, key=lambda d: (d[0], d[1])):
        canvas.alpha_composite(im, (ox, oy))

    os.makedirs(os.path.join(out, 'hd'), exist_ok=True)
    # 정사각 틀로 맞춘다(아래쪽 받침 꼭짓점이 기준).
    bbox = canvas.getbbox()
    assert bbox
    crop = canvas.crop(bbox)
    ox, oy = 4, 4
    framed = Image.new('RGBA', (crop.size[0] + 8, crop.size[1] + 8), (0, 0, 0, 0))
    framed.alpha_composite(crop, (ox, oy))
    framed.save(os.path.join(out, 'hd', f'{name}.png'), optimize=True)
    side = framed.size[0]
    small = framed.resize((1024, round(framed.size[1] * 1024 / side)), Image.Resampling.LANCZOS)
    small.save(os.path.join(out, f'{name}.png'), optimize=True)
    # 바닥 마름모: 가로 n·W, 아래 꼭짓점 (bx, by + 받침 두께).
    k = side / 1024
    base_px = n * W / k
    anchor = [((bx - bbox[0]) + ox) / k, ((by - n * quarter - bbox[1]) + oy) / k]
    json.dump({'n': n, 'slot': W, 'placed': placed}, open(os.path.join(out, f'{name}.layout.json'), 'w'), indent=0)
    return {'size': [small.size[0], small.size[1]], 'anchor': [round(anchor[0], 1), round(anchor[1], 1)], 'basePx': round(base_px, 1), 'hd': True}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    walls_only = '--walls-only' in sys.argv
    parts, out = args[0], args[1]
    names = args[2:] or list(LEVELS)
    meta_path = os.path.join(out, 'sprites.json')
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    for name in names:
        meta[name] = compose(parts, name, LEVELS[name], out, walls_only)
        print(name, meta[name])
    json.dump(meta, open(meta_path, 'w'), indent=1)


main()
