"""양식별 성벽 그림층을 이미지 저장소에 옮기고 웹이 읽을 자리표를 만든다 (사용자 2026-11-17 "지역별로 새로 만든건 전부 웹에 넣어.").

입력: D:/codex-artifacts/int29-castle-slots-20261116/web-layers/<양식>/wall-<등급>-{back,front}.webp, wall-<등급>.json
      (castletest3.py wall/<양식> <등급> _ layers web-layers/<양식> 으로 구운 것. 중원은 web-layers/ 바로 아래)
출력: <이미지 저장소>/public/art/city/castle-walls/<양식>/wall-<로마자 등급>-{back,front}.webp
      apps/web/src/stage/castleWallMeta.json  {양식: {등급: {back: {x, y, w, h}, front: {...}}}}
그 다음 이미지 저장소를 커밋하고 publish-ui-art.py --catalog-only --dest city/castle-walls/<양식> --sha <커밋> 으로 목록에 올린다.

python -I tools/art/stage-castle-walls.py
"""

import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = pathlib.Path('D:/codex-artifacts/int29-castle-slots-20261116/web-layers')
REPO = pathlib.Path('E:/opensamguk-images')
META = ROOT / 'apps/web/src/stage/castleWallMeta.json'
CITY = pathlib.Path('D:/codex-artifacts/int29-castle-slots-20261116/wall-city')


def keyed(path: pathlib.Path):
    """슬롯 그림과 같은 마젠타 빼기와 768 줄이기(stage-castle-slots.py의 keyed)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location('st', ROOT / 'tools/art/stage-castle-slots.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.keyed(path)


FILE = {'현': 'hyeon', '소': 'so', '중': 'jung', '대': 'dae', '특': 'teuk', '경': 'gyeong'}


def main() -> int:
    meta: dict[str, dict] = {}  # 이름을 주면 아래에서 기존 자리표를 읽는다
    styles = {'central': SRC} | {p.name: p for p in sorted(SRC.iterdir()) if p.is_dir()}
    only = set(sys.argv[1:])
    # 이름을 주면 그 폴더만 옮긴다(자리표는 기존 값에 덧쓴다).
    if only:
        meta = json.loads(META.read_text(encoding='utf-8')) if META.exists() else {}
        styles = {k: v for k, v in styles.items() if k in only}
    for style, folder in styles.items():
        grades = {}
        for grade, roman in FILE.items():
            info = folder / f'wall-{grade}.json'
            if not info.exists():
                continue
            row = json.loads(info.read_text(encoding='utf-8'))
            out = REPO / 'public/art/city/castle-walls' / style
            out.mkdir(parents=True, exist_ok=True)
            for part in ('back', 'front'):
                shutil.copyfile(folder / row[part]['file'], out / f'wall-{roman}-{part}.webp')
            grades[grade] = {part: {k: row[part][k] for k in ('x', 'y', 'w', 'h')} for part in ('back', 'front')}
        # 성마다 그린 지물(wall-city/<city|pass>-<번호>/landmark.png)을 같은 폴더에 landmark.webp로 둔다.
        if style.startswith('city-'):
            key = style.removeprefix('city-')
            for cand in (CITY / f'city-{key}' / 'landmark.png', CITY / f'pass-{key}' / 'landmark.png'):
                if cand.exists():
                    land = keyed(cand)
                    land.save(REPO / 'public/art/city/castle-walls' / style / 'landmark.webp', 'WEBP', quality=86, method=6)
                    break
        # 양식은 여섯 등급 모두, 성마다 그림(city-<거점 번호>)은 그 성 등급 한 벌만 있다.
        if len(grades) == len(FILE) or (style.startswith('city-') and grades):
            meta[style] = grades
        else:
            print('등급이 모자라 건너뜀', style, sorted(grades))
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print('양식', len(meta), sorted(meta))
    return 0


if __name__ == '__main__':
    sys.exit(main())
