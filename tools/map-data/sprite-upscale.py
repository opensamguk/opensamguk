"""INT-27 거점·시설·병종 그림 고해상도본: 지도 그림 폴더의 그림을 Real-ESRGAN x4로 키워 `hd/`에 둔다.

python -I sprite-upscale.py <realesrgan-ncnn-vulkan.exe> <sprites_dir> [name ...]

사용자 2026-11-14: "복잡하게 나누지 말고 통짜로 만들면 안되나? 큰걸로 만들어서." / "시설들도 만들었던게 있으면 업스케일
하도록. 군사들도." 성은 부품 조립을 그만두고 Codex가 그린 한 장을 쓴다. 생성 한 번의 크기로는 화면을 채울 때 흐리다.
조각을 다시 그리게 하면 조각마다 건물이 옮겨 가므로(구도 상관 0.48–0.56), 새로 그리지 않고 선명하게만 하는
확대 모델(realesrgan-x4plus)로 키운다.

- 입력은 지도에 이미 들어간 투명 그림(`<sprites_dir>/<name>.png`, sprite-key.py 결과 등)이다. 틀을 그대로 4배 하므로
  `sprites.json`의 크기·기준점은 그대로 두고 `hd: true`만 더한다. 지도는 가장 크게 볼 때 `hd/<name>.png`로 바꾼다.
- 확대 모델은 투명을 모르고, 마젠타 위에 얹어 키우면 불투명 가장자리 안쪽까지 분홍이 번진다(200배 확대에서 보임).
  그래서 투명한 곳을 그림 가장자리 색으로 바깥까지 번져 채운 뒤 키운다(`bleed`). 알파는 원래 알파를 같은 배율로 키운다.
- 확대 모델 실행본: https://github.com/xinntao/Real-ESRGAN 의 realesrgan-ncnn-vulkan(Windows, models/ 포함).
"""
import json
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image

SCALE = 4


def bleed(rgba):
    """투명한 곳을 가까운 불투명 색으로 채운다(알파 가중 흐림을 점점 넓혀 빈 곳만 메운다)."""
    rgb = rgba[..., :3].astype(np.float32)
    a = (rgba[..., 3].astype(np.float32) / 255.0)[..., None]
    out = rgb * (a > 0.5)
    filled = (a[..., 0] > 0.5)
    pre, wt = rgb * a, a[..., 0].copy()
    k = 3
    while not filled.all() and k < 2 * max(rgba.shape[:2]):
        bp = cv2.blur(pre, (k, k))
        bw = cv2.blur(wt, (k, k))
        ok = (bw > 1e-3) & ~filled
        out[ok] = bp[ok] / bw[ok][:, None]
        filled |= ok
        k *= 2
    return np.clip(out, 0, 255).astype(np.uint8)


def main():
    exe, sprites = sys.argv[1], sys.argv[2]
    meta_path = os.path.join(sprites, 'sprites.json')
    meta = json.load(open(meta_path))
    names = sys.argv[3:] or sorted(meta)
    os.makedirs(os.path.join(sprites, 'hd'), exist_ok=True)
    with tempfile.TemporaryDirectory(dir=sprites) as tmp:
        for name in names:
            im = Image.open(os.path.join(sprites, f'{name}.png')).convert('RGBA')
            small, big = os.path.join(tmp, 'in.png'), os.path.join(tmp, 'out.png')
            Image.fromarray(bleed(np.asarray(im)), 'RGB').save(small)
            subprocess.run(
                [exe, '-i', small, '-o', big, '-n', 'realesrgan-x4plus', '-s', str(SCALE)],
                cwd=os.path.dirname(os.path.abspath(exe)),
                check=True,
                capture_output=True,
            )
            rgb = np.asarray(Image.open(big).convert('RGB'))
            size = (im.size[0] * SCALE, im.size[1] * SCALE)
            alpha = np.asarray(im.getchannel('A').resize(size, Image.Resampling.LANCZOS))
            Image.fromarray(np.dstack([rgb, alpha]), 'RGBA').save(os.path.join(sprites, 'hd', f'{name}.png'))
            meta[name]['hd'] = True
            print(name, im.size, '->', size, flush=True)
    json.dump(meta, open(meta_path, 'w'), indent=1)


if __name__ == '__main__':
    main()
