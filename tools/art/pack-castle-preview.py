"""성 화면 미리보기 아티팩트에 넣을 그림을 묶음 파일로 싼다(사용자 2026-11-17 "아티팩트에 반영해.").

아티팩트는 다른 주소의 그림을 불러오지 못하고 한 판에 파일 511개까지라, 공개 그림 목록의 성 화면 그림을
양식별 묶음(.wasm 이름, 14MB 안팎. 아티팩트가 받는 이진 파일 종류라 그 이름을 빌린다)으로 붙이고 index.json에 (묶음, 시작, 길이)를 적는다. 미리보기 화면이 묶음을 받아
blob 주소로 바꿔 쓴다(apps/web/src/stage/preview/).

python -I tools/art/pack-castle-preview.py <출력 폴더>
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPO = pathlib.Path('E:/opensamguk-images/public')
CATALOG = ROOT / 'packages/shared/src/publicImageCatalog.json'
LIMIT = 14 * 1024 * 1024
WANT = ('apps/web/src/art/city/', )


def group_of(source: str) -> str:
    rest = source.removeprefix('apps/web/src/art/city/')
    parts = rest.split('/')
    if parts[0] in ('castle-walls', 'slots') and len(parts) > 2 and parts[1] not in ('central', 'common'):
        return parts[1]
    return 'common'


def shrink(source: str, path: pathlib.Path) -> bytes:
    """미리보기에 넣을 때만 줄인다(2026-11-18 성벽 277곳과 슬롯 1612장이 아티팩트 한도 256MB를 넘어서).
    성 화면은 성벽을 자리표 크기(w, h)로, 슬롯을 그림 비율로 그리므로 줄여도 자리가 같다."""
    rest = source.removeprefix('apps/web/src/art/city/')
    if rest.startswith('castle-walls/') and '/wall-' in rest:
        scale = 0.5
    elif rest.startswith('slots/'):
        scale = 384 / 768
    else:
        return path.read_bytes()
    import io

    from PIL import Image

    im = Image.open(path)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=80, method=4)
    return buf.getvalue()


def main() -> int:
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    sources = sorted(e['source'] for e in catalog if e['source'].startswith(WANT))
    groups: dict[str, list[str]] = {}
    for s in sources:
        groups.setdefault(group_of(s), []).append(s)
    items: dict[str, list] = {}
    files: dict[str, list[str]] = {}
    for group, srcs in sorted(groups.items()):
        n, buf = 0, bytearray()

        def flush():
            nonlocal n, buf
            if not buf:
                return
            name = f'{group}-{n}.wasm'
            (out / name).write_bytes(bytes(buf))
            files.setdefault(group, []).append(name)
            n, buf = n + 1, bytearray()

        for s in srcs:
            data = shrink(s, REPO / s.removeprefix('apps/web/src/'))
            if len(buf) + len(data) > LIMIT:
                flush()
            items[s] = [f'{group}-{n}.wasm', len(buf), len(data)]
            buf += data
        flush()
    (out / 'index.json').write_text(json.dumps({'groups': files, 'items': items}, ensure_ascii=False), encoding='utf-8')
    total = sum((out / f).stat().st_size for g in files.values() for f in g)
    print('그림', len(items), '묶음', sum(len(v) for v in files.values()), 'MB', round(total / 1e6, 1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
