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
    'city-5': {'n': 5, 'mat': 'earth', 'core': None, 'core_size': 0, 'empty': 0.3, 'towers': False},
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


def compose(parts, name, cfg, out):
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

    def run(part, slope, x0, y0, x1, target_h, tag):
        """(x0, y0)에서 기울기 slope로 x1까지 토막을 빈틈없이 잇는다. target_h는 밑선에서 위 끝까지 높이."""
        piece, base, tall = strip(os.path.join(parts, f'{part}.png'), slope)
        sc = target_h / tall
        piece = piece.resize((max(1, round(piece.size[0] * sc)), max(1, round(piece.size[1] * sc))), Image.Resampling.LANCZOS)
        base *= sc
        # 이음매: FEATHER px 겹치고 뒤 토막 왼쪽을 서서히 비치게 해 세로 줄이 보이지 않게 섞는다.
        feather = min(FEATHER, piece.size[0] // 4)
        ramp = np.ones(piece.size[0])
        ramp[:feather] = np.linspace(0, 1, feather)
        faded = np.asarray(piece).copy()
        faded[..., 3] = (faded[..., 3] * ramp[None, :]).astype(np.uint8)
        faded = Image.fromarray(faded, 'RGBA')
        step = piece.size[0] - feather
        x = x0
        first = True
        while x < x1 - 0.5:
            span = min(piece.size[0], int(np.ceil(x1 - x)) + 1)
            chunk = (piece if first else faded).crop((0, 0, span, piece.size[1]))
            first = False
            y = y0 + slope * (x - x0)
            canvas.alpha_composite(chunk, (int(round(x)), int(round(y - base))))
            x += step
        placed.append({'part': part, 'run': [round(x0, 1), round(y0, 1), round(x1, 1)], 'slope': slope, 'h': round(target_h, 1), **tag})

    def gate_at(part, slope, xc, yc, target_h, tag, measure=(0.15, 0.85)):
        """성문 토막 하나를 가운데 xc에서 밑선이 격자선(기울기 slope, (xc, yc) 지남)에 닿게 놓는다."""
        piece, base, tall = strip(os.path.join(parts, f'{part}.png'), slope, cut=0.02, measure=measure)
        sc = target_h / tall
        piece = piece.resize((max(1, round(piece.size[0] * sc)), max(1, round(piece.size[1] * sc))), Image.Resampling.LANCZOS)
        base *= sc
        x = xc - piece.size[0] / 2
        y = yc + slope * (x - xc)
        canvas.alpha_composite(piece, (int(round(x)), int(round(y - base))))
        placed.append({'part': part, 'x': round(xc, 1), 'y': round(yc, 1), 'h': round(target_h, 1), **tag})

    def put(part, x, y, bbox_width, anchor='bottom', tag=None):
        im = scaled(keyed(os.path.join(parts, f'{part}.png')), bbox_width)
        if anchor == 'bottom':
            ox, oy = x - im.size[0] / 2, y - im.size[1]
        elif anchor == 'bottom-right':
            ox, oy = x - im.size[0], y - im.size[1]
        else:  # bottom-left
            ox, oy = x, y - im.size[1]
        canvas.alpha_composite(im, (int(round(ox)), int(round(oy))))
        placed.append({'part': part, 'x': round(x, 1), 'y': round(y, 1), 'w': round(bbox_width, 1), 'anchor': anchor, **(tag or {})})

    # 1. 바닥: 성 안 자리마다 돌판(흙성은 흙 마당).
    ground = 'ground-paved' if mat == 'stone' else 'ground-earth'
    for i in range(n):
        for j in range(n):
            x, y = centre(i, j)
            put(ground, x, y + quarter + 2, W * 1.02, tag={'i': i, 'j': j, 'layer': 'ground'})

    # 2. 뒤쪽 성벽: 왼쪽 위 변(L→T)과 오른쪽 위 변(T→R).
    lx, ly = cx - n * half, top + n * quarter
    rx = cx + n * half
    run(f'wall-{mat}-back-left', -0.5, lx, ly, cx, WALL_H, {'edge': 'back-left'})
    run(f'wall-{mat}-back-right', 0.5, cx, top, rx, WALL_H, {'edge': 'back-right'})
    # 뒤쪽 두 변의 성문(안쪽 면 그림이 있을 때만).
    for edge, slope, (ex, ey) in (('back-left', -0.5, (cx - n * quarter, top + n * quarter / 2)), ('back-right', 0.5, (cx + n * quarter, top + n * quarter / 2))):
        if os.path.exists(os.path.join(parts, f'gatewall-{mat}-{edge}.png')):
            gate_at(f'gatewall-{mat}-{edge}', slope, ex, ey, WALL_H, {'edge': edge, 'gate': True}, measure=(0.02, 0.12))

    # 3. 안쪽 건물. 가운데 큰 건물, 두 문으로 가는 큰길(가운데 줄)은 비운다.
    mid = n // 2
    core, cs = cfg['core'], cfg['core_size']
    r = cs // 2
    taken = {(i, j) for i in range(mid - r, mid + r + 1) for j in range(mid - r, mid + r + 1)} if core else set()
    # 큰길: 성 가운데를 지나는 한 자리 폭 십자길. 네 변 한가운데의 성문으로 이어진다.
    streets = {(i, j) for i in range(n) for j in range(n) if i == mid or j == mid}
    if mat == 'stone':
        pool = ['house-1', 'house-2', 'house-3', 'house-4', 'house-5', 'house-6', 'house-1', 'house-3', 'house-4']
        extras = ['shop-row', 'granary-small', 'barracks-small', 'tree-1', 'tree-2']
    else:
        pool = ['house-earth-1', 'house-earth-2', 'house-earth-3']
        extras = ['granary-small', 'tree-1', 'tree-2']
    items = []
    for i in range(n):
        for j in range(n):
            if (i, j) in taken or (i, j) in streets:
                continue
            roll = rng.random()
            if roll < cfg['empty']:
                continue  # 빈 마당
            part = rng.choice(extras) if roll < cfg['empty'] + 0.18 else rng.choice(pool)
            if (abs(i - mid) == 1 or abs(j - mid) == 1) and mat == 'stone' and rng.random() < 0.35:
                part = 'shop-row'  # 큰길가 점포
            items.append((i + j, i, j, part, 1))
    if core:
        items.append((2 * mid, mid, mid, core, cs))
    for _, i, j, part, size in sorted(items):
        if part == core and size:
            # 가운데 건물: size 자리를 차지(1자리 관아는 조금 크게).
            x, y = centre(i, j)
            put(part, x, y + quarter * size, W * max(size * 0.9, 1.35), tag={'i': i, 'j': j, 'size': size})
        else:
            x, y = centre(i, j)
            put(part, x, y + quarter, W * 0.9, tag={'i': i, 'j': j, 'size': 1})

    # 4. 앞쪽 받침·성벽·성문: 왼쪽 아래 변(L→B), 오른쪽 아래 변(B→R).
    bx, by = cx, top + n * half
    # 받침은 성벽 밑선 아래로 내려온다: 받침 그림 위 끝이 격자선에 오게 밑선을 PLINTH_H만큼 내린다.
    run('plinth-left', 0.5, lx, ly + PLINTH_H, bx, PLINTH_H, {'edge': 'plinth-left'})
    run('plinth-right', -0.5, bx, by + PLINTH_H, rx, PLINTH_H, {'edge': 'plinth-right'})
    run(f'wall-{mat}-front-left', 0.5, lx, ly, bx, WALL_H, {'edge': 'front-left'})
    run(f'wall-{mat}-front-right', -0.5, bx, by, rx, WALL_H, {'edge': 'front-right'})
    # 성문은 앞쪽 두 변의 가운데(큰길 끝)에 성벽 위로 얹는다.
    # 성문은 각 변 한가운데(십자길 끝). 성벽에 박힌 성문 그림(gatewall-*)이 있으면 그것을 쓴다:
    # 양 끝이 성벽이라 높이는 양 끝에서 재 성벽 높이에 맞춘다.
    for edge, slope, (ex, ey) in (('front-left', 0.5, (lx + n * quarter, ly + n * quarter / 2)), ('front-right', -0.5, (bx + n * quarter, by - n * quarter / 2))):
        wall_gate = os.path.join(parts, f'gatewall-{mat}-{edge}.png')
        if os.path.exists(wall_gate):
            gate_at(f'gatewall-{mat}-{edge}', slope, ex, ey, WALL_H, {'edge': edge, 'gate': True}, measure=(0.02, 0.12))
        else:
            gate_at(f'gate-{mat}-{edge}', slope, ex, ey, GATE_H, {'edge': edge, 'gate': True})

    # 5. 모서리 누각: 위·왼쪽·오른쪽·아래 꼭짓점(뒤에서 앞 순서).
    for x, y in ((cx, top), (lx, ly), (cx + n * half, ly), (bx, by)) if cfg['towers'] else ():
        if os.path.exists(os.path.join(parts, f'corner-{mat}.png')):
            put(f'corner-{mat}', x, y + quarter * 0.35, CORNER, tag={'corner': True})
        else:
            put(f'tower-{mat}', x, y + quarter * 0.45, TOWER, tag={'corner': True})

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
    parts, out = sys.argv[1], sys.argv[2]
    names = sys.argv[3:] or list(LEVELS)
    meta_path = os.path.join(out, 'sprites.json')
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    for name in names:
        meta[name] = compose(parts, name, LEVELS[name], out)
        print(name, meta[name])
    json.dump(meta, open(meta_path, 'w'), indent=1)


main()
