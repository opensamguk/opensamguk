"""INT-27 화풍 분석: 사용자 참고 그림과 우리 결과를 같은 수치로 잰다 (Claude, 2026-11-14).

python -I analyze.py <out.json> <name=path[:x0,y0,x1,y1;...제외]> ...
분류: 물(청록), 식생(연두~녹), 짙은 숲, 흙·황토(노란 갈색), 바위·산(저채도). 각 분류의 비율·색(Lab)·명도 분포·
국소 대비·세부 결(라플라시안), 그리고 바위 영역의 밝기 기울기 평균으로 화면상 빛 방향을 잰다.
"""
import json
import math
import sys

import numpy as np
from PIL import Image


def srgb_to_lab(rgb):
    c = rgb / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def hsv(rgb):
    c = rgb / 255.0
    mx = c.max(-1)
    mn = c.min(-1)
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    h = np.zeros_like(mx)
    m = d > 1e-6
    rr = m & (mx == r)
    gg = m & (mx == g) & ~rr
    bb = m & ~rr & ~gg
    h[rr] = ((g - b)[rr] / d[rr]) % 6
    h[gg] = (b - r)[gg] / d[gg] + 2
    h[bb] = (r - g)[bb] / d[bb] + 4
    return h * 60, s, mx


def box(a, r):
    k = 2 * r + 1
    p = np.pad(a, r, mode='edge')
    c = p.cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def analyse(path, excludes):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    H, W, _ = im.shape
    valid = np.ones((H, W), bool)
    for x0, y0, x1, y1 in excludes:
        valid[int(y0):int(y1), int(x0):int(x1)] = False
    lab = srgb_to_lab(im)
    L = lab[..., 0]
    h, s, v = hsv(im)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    water = (h > 160) & (h < 215) & (s > 0.22) & (v > 0.25)
    veg = (h >= 55) & (h < 140) & (s > 0.16) & ~water
    forest = veg & (L < 42)
    plain = veg & ~forest
    soil = (h >= 25) & (h < 55) & (s > 0.28) & ~water
    rock = (s <= 0.2) & ~water & (L > 12)
    classes = {'water': water, 'plain': plain, 'forest': forest, 'soil': soil, 'rock': rock}
    m3 = box(L, 4)
    local = np.sqrt(np.maximum(box(L * L, 4) - m3 * m3, 0))
    lap = np.abs(4 * L - np.roll(L, 1, 0) - np.roll(L, -1, 0) - np.roll(L, 1, 1) - np.roll(L, -1, 1))
    out = {'size': [W, H], 'classes': {}}
    total = valid.sum()
    for name, mask in classes.items():
        mk = mask & valid
        n = int(mk.sum())
        if n < 200:
            out['classes'][name] = {'share': round(n / total, 4)}
            continue
        Ls = L[mk]
        out['classes'][name] = {
            'share': round(n / total, 4),
            'lab_median': [round(float(np.median(lab[..., i][mk])), 1) for i in range(3)],
            'rgb_median': [int(np.median(im[..., i][mk])) for i in range(3)],
            'L_p5_p50_p95': [round(float(np.percentile(Ls, q)), 1) for q in (5, 50, 95)],
            'chroma_median': round(float(np.median(chroma[mk])), 1),
            'local_contrast': round(float(np.median(local[mk])), 2),
            'detail': round(float(np.median(lap[mk])), 2),
        }
    gx = (np.roll(L, -1, 1) - np.roll(L, 1, 1)) / 2
    gy = (np.roll(L, -1, 0) - np.roll(L, 1, 0)) / 2
    rk = rock & valid & (np.hypot(gx, gy) > 2)
    if rk.sum() > 500:
        vx, vy = float(gx[rk].mean()), float(gy[rk].mean())
        # 기울기 평균은 어두운 쪽 → 밝은 쪽. 화면 각도(0=오른쪽, 90=아래).
        out['light_screen_deg'] = round(math.degrees(math.atan2(vy, vx)), 1)
        out['light_strength'] = round(math.hypot(vx, vy), 3)
    Lv = L[valid]
    out['global'] = {
        'L_p5_p50_p95': [round(float(np.percentile(Lv, q)), 1) for q in (5, 50, 95)],
        'chroma_median': round(float(np.median(chroma[valid])), 1),
        'local_contrast': round(float(np.median(local[valid])), 2),
        'detail': round(float(np.median(lap[valid])), 2),
    }
    return out


def main():
    res = {}
    for arg in sys.argv[2:]:
        name, rest = arg.split('=', 1)
        path, _, ex = rest.partition('::')
        excludes = [tuple(map(float, r.split(','))) for r in ex.split(';') if r]
        res[name] = analyse(path, excludes)
    json.dump(res, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


main()
