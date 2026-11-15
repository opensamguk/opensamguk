"""INT-27 그림 지도의 물 지도: 구운 그림 지도(painted/national.jpg)에서 물빛 픽셀을 읽어 지형 격자 크기의 물 지도를 만든다.

python -I painted-water.py <national.jpg> <out.png> <columns> <rows> [<detail.png> <width> <height>]

사용자 2026-11-14: "해안에 오지가 남아있는데" / "여기에 물이라고 나오면 어떡해?" 화면에 보이는 그림 지도와 옛 지형 칸
자료(Natural Earth 화소 지도)의 해안·호수가 달라, 그림에서는 땅인 곳이 물·오지로 잡혔다. 2D 지도에서는 보이는 그림을
땅·물의 기준으로 삼는다. 그림 지도의 해안은 시나리오 기획판 아티팩트의 땅 윤곽과 99.1% 일치한다.

- 지형 판의 꼭짓점 (c, r)은 그림의 (c / (columns − 1), r / (rows − 1)) 비율 자리다(PlaneGeometry). 그 둘레 픽셀의 평균색으로 판정한다.
- 물: 파랑이 빨강보다 뚜렷이 크고 초록에 뒤지지 않는 색(바다·호수·강의 청록·남색).
- 결과: 흑백 PNG(물 255, 땅 0). 지도는 이 그림으로 땅 높이·영지·풍선의 땅·물을 정한다(mapScene.applyWaterMask).
"""
import sys

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None


def main():
    src, out, columns, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    image = Image.open(src).convert('RGB')
    # 꼭짓점 둘레 평균색: 꼭짓점 간격만큼 흐린 뒤 꼭짓점 자리를 읽는다.
    w, h = image.size
    radius = max(1, round(w / (columns - 1) / 2))
    soft = np.asarray(image.filter(ImageFilter.BoxBlur(radius))).astype(np.int32)
    xs = np.round(np.arange(columns) / (columns - 1) * (w - 1)).astype(int)
    ys = np.round(np.arange(rows) / (rows - 1) * (h - 1)).astype(int)
    rgb = soft[ys[:, None], xs[None, :]]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    water = (b > r + 18) & (b >= g - 5)
    mask = Image.fromarray((water * 255).astype(np.uint8), 'L').filter(ImageFilter.MedianFilter(3))
    mask.save(out, optimize=True)
    print(out, mask.size, 'water', round(float((np.asarray(mask) > 127).mean()), 3))
    # 정밀 물 지도(선택): 캔버스 한 단위에 한 픽셀. 위 지형용 물 지도는 흐리기·중간값 거르기로 폭 2~3단위의 강(그림 속
    # 황하 하류)이 사라져, 수로가 강을 못 찾고 강 가운데로 그릴 수도 없었다(사용자 2026-11-14 "수로는 만약 강에 있으면
    # 강 안에 수로를 그려"). 그림 속 황하는 폭 약 9픽셀의 청록(초록이 파랑보다 조금 큼)이라, 원본 픽셀마다 강 색으로
    # 판정한 뒤 묶음 안에 물 픽셀이 하나라도 있으면 물로 줄인다. 수로 길찾기·강 가운데 맞추기에만 쓴다.
    if len(sys.argv) >= 7:
        detail_out, width, height = sys.argv[5], int(sys.argv[6]), int(sys.argv[7])
        step_x, step_y = w // width, h // height
        fine = np.zeros((height, width), bool)
        pixels = np.asarray(image)
        for top in range(0, height, 50):
            strip = pixels[top * step_y:(top + 50) * step_y, : width * step_x].astype(np.int16)
            r, g, b = strip[..., 0], strip[..., 1], strip[..., 2]
            wet = (b > r + 25) & (b >= g - 15)
            rows_here = wet.shape[0] // step_y
            fine[top:top + rows_here] = wet[: rows_here * step_y].reshape(rows_here, step_y, width, step_x).any(axis=(1, 3))
        Image.fromarray((fine * 255).astype(np.uint8), 'L').save(detail_out, optimize=True)
        print(detail_out, (width, height), 'water', round(float(fine.mean()), 3))


if __name__ == '__main__':
    main()
