"""INT-27 거점 그림 고해상도 만들기: 기본 그림을 키워 겹치는 조각으로 나누고, Codex가 조각마다 세부를 다시 그린 뒤 다시 잇는다.

python -I sprite-tiles.py split <base.png> <out_dir> [--size 3072] [--grid 3] [--margin 160]
python -I sprite-tiles.py merge <out_dir> <result.png>

split: 기본 그림(마젠타 배경)을 size로 키우고 grid×grid 조각(사방 margin 겹침)으로 자른다. 전부 마젠타인 조각은 건너뛴다.
       layout.json에 조각 자리를 적는다. Codex는 tiles/rNcM.png를 구도 그대로 세부만 더해 painted/rNcM.png로 그린다.
merge: painted 조각을 조각 크기로 맞추고 겹친 곳을 직선 가중으로 섞어 잇는다. 빠진 조각은 키운 기본 그림을 쓴다.
       조각마다 기본 그림과의 상관(구도가 지켜졌는지)을 적는다.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

MAGENTA = np.array([255, 0, 255], np.float64)


def is_magenta(a):
    return (np.minimum(a[..., 0], a[..., 2]) - a[..., 1]) > 150


def split(base, out, size, grid, margin):
    im = Image.open(base).convert('RGB')
    big = im.resize((size, size), Image.Resampling.LANCZOS)
    os.makedirs(os.path.join(out, 'tiles'), exist_ok=True)
    os.makedirs(os.path.join(out, 'painted'), exist_ok=True)
    big.save(os.path.join(out, 'upscaled.png'))
    a = np.asarray(big).astype(np.float64)
    core = size // grid
    tiles = []
    for r in range(grid):
        for c in range(grid):
            x0, y0 = max(c * core - margin, 0), max(r * core - margin, 0)
            x1, y1 = min((c + 1) * core + margin, size), min((r + 1) * core + margin, size)
            crop = a[y0:y1, x0:x1]
            if is_magenta(crop).mean() > 0.985:
                continue
            name = f'r{r + 1}c{c + 1}'
            big.crop((x0, y0, x1, y1)).save(os.path.join(out, 'tiles', f'{name}.png'))
            tiles.append({'name': name, 'box': [x0, y0, x1, y1]})
    json.dump({'size': size, 'grid': grid, 'margin': margin, 'tiles': tiles}, open(os.path.join(out, 'layout.json'), 'w'), indent=1)
    print(len(tiles), 'tiles')


def ramp(n, lo, hi, margin):
    w = np.ones(n)
    if lo:
        w[: 2 * margin] = np.linspace(0, 1, 2 * margin)
    if hi:
        w[n - 2 * margin:] = np.linspace(1, 0, 2 * margin)
    return w


def merge(out, result):
    layout = json.load(open(os.path.join(out, 'layout.json')))
    size, margin = layout['size'], layout['margin']
    up = np.asarray(Image.open(os.path.join(out, 'upscaled.png')).convert('RGB')).astype(np.float64)
    acc = np.zeros_like(up)
    wsum = np.zeros(up.shape[:2])
    report = []
    for t in layout['tiles']:
        x0, y0, x1, y1 = t['box']
        path = os.path.join(out, 'painted', f"{t['name']}.png")
        ref = up[y0:y1, x0:x1]
        if os.path.exists(path):
            p = np.asarray(Image.open(path).convert('RGB').resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS)).astype(np.float64)
            g1, g2 = ref.mean(-1), p.mean(-1)
            corr = float(np.corrcoef(g1.ravel(), g2.ravel())[0, 1])
        else:
            p, corr = ref, None
        report.append({'name': t['name'], 'corr': None if corr is None else round(corr, 3)})
        wy = ramp(y1 - y0, y0 > 0, y1 < size, margin)
        wx = ramp(x1 - x0, x0 > 0, x1 < size, margin)
        w = np.outer(wy, wx)
        acc[y0:y1, x0:x1] += p * w[..., None]
        wsum[y0:y1, x0:x1] += w
    covered = wsum > 1e-6
    res = up.copy()
    res[covered] = acc[covered] / wsum[covered][:, None]
    # 마젠타 바깥은 키운 기본 그림의 마젠타를 그대로 둔다(윤곽이 조각마다 흔들리지 않게).
    res[is_magenta(up)] = MAGENTA
    Image.fromarray(np.clip(res, 0, 255).astype(np.uint8)).save(result)
    json.dump(report, open(os.path.join(out, 'merge-report.json'), 'w'), indent=1)
    print(report)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'split':
        opts = dict(zip(sys.argv[4::2], sys.argv[5::2]))
        split(sys.argv[2], sys.argv[3], int(opts.get('--size', 3072)), int(opts.get('--grid', 3)), int(opts.get('--margin', 160)))
    else:
        merge(sys.argv[2], sys.argv[3])
