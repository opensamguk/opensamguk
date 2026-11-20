"""INT-27 2D 지도 그림을 이미지 저장소(opensamguk-images)에 싣는다.

python -I publish-map-assets.py <map_dir> <images_repo> <names.json>

사용자 2026-11-14: "구운건 나중에 저장을 해서 이미지 레포에서 가져오는걸로 하자. 다른 이미지들도 마찬가지야." /
"배경도 이미지 레포에 넣을거야."

- 입력 <map_dir>: 개발 미리보기 폴더(painted/, sprites/, sprites/hd/). <names.json>: 지도가 쓰는 거점 그림 이름 목록
  (apps/web/src/map3d/siteModels.ts의 MODEL_NAMES. node --experimental-strip-types로 뽑는다).
- 결과: <images_repo>/public/map/2d/ 아래
  - painted/national-roads.webp(길을 구운 그림 지도), painted/water-mask.png, painted/water-detail.png
  - sprites/<이름>.webp, sprites/hd/<이름>.webp(4배), sprites/sprites.json(크기·기준점에 ext 'webp'), sprites/flag-castle-strip.png
- 거점 그림 PNG는 4배 고해상도본이 장당 최대 45MB라 WebP(보통 90, 고해상도 85)로 바꾼다(약 17분의 1).
- <images_repo>/public/manifest.json에 경로·SHA-256·바이트를 넣는다. 공개 승인(public)은 false로 두고 공개 전
  라이선스 관문에서 정한다. 쓰지 않는 그림(시설·병종·배·다리, Rodin 3D 모형)은 싣지 않는다.
"""
import hashlib
import json
import os
import shutil
import sys

from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def main():
    src, repo, names_path = sys.argv[1], sys.argv[2], sys.argv[3]
    names = json.load(open(names_path, encoding='utf-8'))
    out = os.path.join(repo, 'public', 'map', '2d')
    os.makedirs(os.path.join(out, 'painted'), exist_ok=True)
    os.makedirs(os.path.join(out, 'sprites', 'hd'), exist_ok=True)
    written = []

    # 그림 지도·물 지도
    Image.open(os.path.join(src, 'painted', 'national-roads.jpg')).convert('RGB').save(
        os.path.join(out, 'painted', 'national-roads.webp'), 'WEBP', quality=90, method=6)
    written.append(('painted/national-roads.jpg', 'painted/national-roads.webp'))
    for name in ('water-mask.png', 'water-detail.png'):
        shutil.copyfile(os.path.join(src, 'painted', name), os.path.join(out, 'painted', name))
        written.append((f'painted/{name}', f'painted/{name}'))

    # 거점 그림
    meta = json.load(open(os.path.join(src, 'sprites', 'sprites.json')))
    published = {}
    for name in names:
        if name not in meta or not os.path.exists(os.path.join(src, 'sprites', f'{name}.png')):
            continue
        Image.open(os.path.join(src, 'sprites', f'{name}.png')).save(
            os.path.join(out, 'sprites', f'{name}.webp'), 'WEBP', quality=90, method=6)
        written.append((f'sprites/{name}.png', f'sprites/{name}.webp'))
        entry = {**meta[name], 'ext': 'webp'}
        hd = os.path.join(src, 'sprites', 'hd', f'{name}.png')
        if meta[name].get('hd') and os.path.exists(hd):
            Image.open(hd).save(os.path.join(out, 'sprites', 'hd', f'{name}.webp'), 'WEBP', quality=85, method=6)
            written.append((f'sprites/hd/{name}.png', f'sprites/hd/{name}.webp'))
        else:
            entry.pop('hd', None)
        published[name] = entry
        print(name, flush=True)
    json.dump(published, open(os.path.join(out, 'sprites', 'sprites.json'), 'w'), indent=1)
    written.append(('sprites/sprites.json', 'sprites/sprites.json'))
    shutil.copyfile(os.path.join(src, 'sprites', 'flag-castle-strip.png'), os.path.join(out, 'sprites', 'flag-castle-strip.png'))
    written.append(('sprites/flag-castle-strip.png', 'sprites/flag-castle-strip.png'))

    # manifest
    manifest_path = os.path.join(repo, 'public', 'manifest.json')
    manifest = json.load(open(manifest_path, encoding='utf-8'))
    prefix = 'public/map/2d/'
    images = [image for image in manifest['images'] if not image['path'].startswith(prefix)]
    for source, path in written:
        data = open(os.path.join(out, path), 'rb').read()
        images.append({
            'source': f'D:/codex-artifacts/int27-fidelity-20261114/rodin/map/{source}',
            'path': prefix + path,
            'sha256': hashlib.sha256(data).hexdigest(),
            'bytes': len(data),
            'public': False,
        })
    manifest['images'] = images
    json.dump(manifest, open(manifest_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    total = sum(os.path.getsize(os.path.join(out, path)) for _, path in written)
    print('files', len(written), 'sprites', len(published), 'MB', round(total / 1e6, 1))


if __name__ == '__main__':
    main()
