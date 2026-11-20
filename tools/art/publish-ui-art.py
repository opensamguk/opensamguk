"""Codex가 그린 화면 그림을 이미지 저장소로 옮긴다 (D-099, 사용자 2026-11-15 "다른 이미지들도 마찬가지야").

- 마젠타(#FF00FF) 배경을 투명으로 바꾸고 가장자리의 마젠타 번짐을 걷어 낸다.
- 지정한 크기 안으로 줄여 webp로 저장한다: <이미지 저장소>/public/art/<dest>/<이름>.webp
- --sha를 주면 그 커밋 주소로 packages/shared/src/publicImageCatalog.json에 항목을 더하거나 고친다.
  카탈로그 전체를 그 커밋 하나로 다시 고정하고 manifest/public-assets.json과 APPROVED_MAP_IMAGES에도 올린다.
  끝나면 prettier로 세 파일을 정리한다.
  source는 저장소 안의 논리 경로 apps/web/src/art/<dest>/<이름>.webp 다(기존 항목과 같은 규칙).

예:
  python -I tools/art/publish-ui-art.py --src D:/codex-artifacts/int29-command-band-20261115/walls --dest band/walls --max 1600x200
  python -I tools/art/publish-ui-art.py --catalog-only --dest band/walls --sha <이미지 저장소 커밋>
"""

import argparse
import hashlib
import json
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
CATALOG = ROOT / 'packages/shared/src/publicImageCatalog.json'
RAW = 'https://raw.githubusercontent.com/opensamguk/opensamguk-images'


def key_magenta(image: Image.Image) -> Image.Image:
    rgba = image.convert('RGBA')
    px = rgba.load()
    width, height = rgba.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            # 마젠타에 가까울수록 투명하게. 가장자리 섞인 색은 반투명으로 두고 마젠타 성분을 뺀다.
            magenta = min(r, b) - g
            if magenta > 150:
                px[x, y] = (0, 0, 0, 0)
            elif magenta > 60:
                keep = (150 - magenta) / 90
                spill = min(r, b) - g
                px[x, y] = (max(0, r - spill // 2), g, max(0, b - spill // 2), int(a * keep))
    return rgba


def publish(src: pathlib.Path, dest: str, repo: pathlib.Path, max_size: tuple[int, int] | None, quality: int) -> list[dict]:
    out_dir = repo / 'public/art' / dest
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted(src.glob('*.png')):
        if path.stem in ('sheet', 'contact'):
            continue
        image = key_magenta(Image.open(path))
        if max_size:
            image.thumbnail(max_size, Image.LANCZOS)
        target = out_dir / f'{path.stem}.webp'
        image.save(target, 'WEBP', quality=quality, method=6)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        rows.append({'file': str(target), 'source': f'apps/web/src/art/{dest}/{path.stem}.webp', 'sha256': digest, 'size': image.size})
    return rows


MANIFEST = ROOT / 'manifest/public-assets.json'
APPROVED = ROOT / 'packages/shared/src/publicMapImages.ts'
SVG_RAW = 'https://rawcdn.githack.com/opensamguk/opensamguk-images'


def update_catalog(dest: str, repo: pathlib.Path, sha: str) -> int:
    """dest의 그림을 카탈로그와 승인 목록에 올리고, 모든 원격 그림을 sha 한 커밋으로 다시 고정한다.

    공개 빌드 검사(tools/public-assets/check.ts)는 카탈로그 전체가 manifest의 imageRevision 한 커밋 주소이고
    manifest mapImages가 APPROVED_MAP_IMAGES와 같은 순서이기를 요구한다. 그래서 새 그림만 새 커밋 주소로 두면 빌드가 깨진다.
    sha는 이전 그림을 모두 품은 이미지 저장소 커밋이어야 한다(이전 고정 커밋의 후손).
    """
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    by_source = {entry['source']: entry for entry in catalog}
    count = 0
    for target in sorted((repo / 'public/art' / dest).glob('*.webp')):
        source = f'apps/web/src/art/{dest}/{target.name}'
        entry = {'source': source, 'url': '', 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
        if source in by_source:
            by_source[source].update(entry)
        else:
            catalog.append(entry)
            by_source[source] = entry
        count += 1
    for entry in catalog:
        base = SVG_RAW if entry['source'].endswith('.svg') else RAW
        entry['url'] = f"{base}/{sha}/public/{entry['source'].removeprefix('apps/web/src/')}"
    catalog.sort(key=lambda entry: entry['source'])
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    manifest['imageRevision'] = sha
    manifest['imageBaseUrl'] = f'{RAW}/{sha}'
    manifest['svgImageBaseUrl'] = f'{SVG_RAW}/{sha}'
    listed = {image['source'] for image in manifest['bundledImages'] + manifest['mapImages']}
    added = [entry for entry in catalog if entry['source'] not in listed]
    for image in manifest['mapImages']:
        image['sha256'] = by_source.get(image['source'], image)['sha256']
    manifest['mapImages'] += [{'sha256': entry['sha256'], 'source': entry['source']} for entry in added]
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    if added:
        text = APPROVED.read_text(encoding='utf-8')
        end = text.rindex('] as const;')
        text = text[:end] + ''.join(f"  '{entry['source']}',\n" for entry in added) + text[end:]
        APPROVED.write_text(text, encoding='utf-8', newline='\n')
    return count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', type=pathlib.Path)
    parser.add_argument('--dest', required=True)
    parser.add_argument('--repo', type=pathlib.Path, default=pathlib.Path('E:/opensamguk-images'))
    parser.add_argument('--max', help='가로x세로 상한, 예 512x256')
    parser.add_argument('--quality', type=int, default=88)
    parser.add_argument('--sha')
    parser.add_argument('--catalog-only', action='store_true')
    args = parser.parse_args()
    if not args.catalog_only:
        if not args.src:
            parser.error('--src가 필요합니다')
        size = tuple(int(v) for v in args.max.split('x')) if args.max else None
        for row in publish(args.src, args.dest, args.repo, size, args.quality):
            print(row['source'], row['size'], row['sha256'][:12])
    if args.sha:
        print('catalog', update_catalog(args.dest, args.repo, args.sha))
    return 0


if __name__ == '__main__':
    sys.exit(main())
