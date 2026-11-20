"""INT-27 세력 깃발 그림: Codex가 마젠타 바탕에 2×2 칸(칸마다 512×512)으로 그린 깃발 네 장면을 투명 가로 띠로 만든다.

python -I flag-strip.py <flag-sheet.png> <out.png> [frame_height]

사용자 2026-11-14: "깃발도 넣기로 하고." 지도는 이 띠를 네 장면으로 넘겨 펄럭이게 하고, 흰 천에 세력색을 곱해 그 위에
세력 이름 첫 글자를 얹는다(Map3D.module.css `.banner`). 깃대 아래 끝(칸 안 (152, 472))이 모든 장면에서 같은 자리라
잘라 낸 상자도 네 장면에 같게 쓴다. 배경 빼기는 sprite-key.py와 같은 마젠타 색 거리 식이다.
"""
import sys

import numpy as np
from PIL import Image

CELL = 512
ORDER = [(0, 0), (1, 0), (0, 1), (1, 1)]  # 좌상 → 우상 → 좌하 → 우하


def unmagenta(cell):
    im = np.asarray(cell.convert('RGB')).astype(np.float64)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    mag = np.clip((np.minimum(r, b) - g) / 255.0, 0, 1)
    alpha = np.clip((0.62 - mag) / 0.3, 0, 1)
    spill = np.clip(np.minimum(r, b) - g, 0, None) * (1 - alpha)
    rgb = im.copy()
    rgb[..., 0] -= spill
    rgb[..., 2] -= spill
    return np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)


def main():
    src, out = sys.argv[1], sys.argv[2]
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 160
    sheet = Image.open(src)
    cells = [unmagenta(sheet.crop((x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL))) for x, y in ORDER]
    # 네 장면 모두를 덮는 상자(깃대 기준이 같으므로 같은 상자로 자른다).
    alpha = np.max([c[..., 3] for c in cells], axis=0) > 8
    ys, xs = np.nonzero(alpha)
    box = (xs.min() - 2, ys.min() - 2, xs.max() + 3, ys.max() + 3)
    frames = [Image.fromarray(c, 'RGBA').crop(box) for c in cells]
    w, h = frames[0].size
    width = round(w * height / h)
    strip = Image.new('RGBA', (width * len(frames), height))
    for i, frame in enumerate(frames):
        strip.paste(frame.resize((width, height), Image.Resampling.LANCZOS), (i * width, 0))
    strip.save(out, optimize=True)
    pole_x = (152 - box[0]) / w
    print(out, strip.size, 'frame', (width, height), 'pole x', round(pole_x, 3), 'box', box)


if __name__ == '__main__':
    main()
