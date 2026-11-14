"""INT-27 거점 그림(스프라이트) 정리: 코덱스가 마젠타(#FF00FF) 배경에 그린 그림을 투명 PNG로 바꾸고 sprites.json을 쓴다.

python -I sprite-key.py <in_dir> <out_dir> [name ...]

- 배경 빼기: 마젠타와의 색 거리로 알파를 정하고, 가장자리의 마젠타 번짐은 색에서 걷어 낸다.
- 기준점: 받침은 2:1 마름모라 가장 아래 꼭짓점이 그림의 맨 아래다. 받침 가로 = 불투명 영역 가로,
  바닥 가운데 = (가로 가운데, 맨 아래 - 가로/4). 받침 옆면 두께만큼 조금 올린다.
- 결과는 정사각으로 맞춰(투명 여백) 한 변을 size로 적는다. 지도는 이 값으로 그림을 칸에 맞춘다(mapScene.placeSiteSprites).
"""
import json
import os
import sys

import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
names = sys.argv[3:] or [f[:-4] for f in os.listdir(src) if f.endswith('.png') and f != 'contact.png']
os.makedirs(out, exist_ok=True)
meta_path = os.path.join(out, 'sprites.json')
meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
for name in names:
    im = np.asarray(Image.open(os.path.join(src, f'{name}.png')).convert('RGB')).astype(np.float64)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    # 마젠타스러움: 빨강·파랑이 초록보다 얼마나 높은가.
    mag = np.clip((np.minimum(r, b) - g) / 255.0, 0, 1)
    alpha = np.clip((0.62 - mag) / 0.3, 0, 1)
    # 번짐 걷기: 반투명 가장자리에서 마젠타 몫을 빼고 초록 쪽으로 맞춘다.
    spill = np.clip(np.minimum(r, b) - g, 0, None) * (1 - alpha)
    rgb = im.copy()
    rgb[..., 0] -= spill
    rgb[..., 2] -= spill
    rgb = np.clip(rgb, 0, 255)
    ys, xs = np.nonzero(alpha > 0.5)
    if not len(xs):
        print(name, '불투명 영역 없음')
        continue
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    base = x1 - x0
    side = int(max(base, y1 - y0) * 1.04) + 2
    canvas = np.zeros((side, side, 4), np.uint8)
    ox = (side - base) // 2 - x0
    oy = side - 1 - y1 + 1 - 2
    crop_rgb = rgb[y0:y1, x0:x1]
    crop_a = alpha[y0:y1, x0:x1]
    canvas[y0 + oy:y1 + oy, x0 + ox:x1 + ox, :3] = crop_rgb.astype(np.uint8)
    canvas[y0 + oy:y1 + oy, x0 + ox:x1 + ox, 3] = (crop_a * 255).astype(np.uint8)
    Image.fromarray(canvas, 'RGBA').save(os.path.join(out, f'{name}.png'), optimize=True)
    bottom = y1 + oy
    thickness = base * 0.035
    meta[name] = {
        'size': side,
        'anchor': [round(side / 2, 1), round(bottom - base / 4 - thickness, 1)],
        'basePx': int(base),
    }
    print(name, meta[name])
json.dump(meta, open(meta_path, 'w'), indent=1)
