"""UI 쇼케이스 쪽을 만든다 (사용자 2026-11-15 "모든 UI를 ... 코덱스를 이용하여 이미지로 뽑고 UI 쇼케이스를 만들어줘").

Codex가 그린 UI 키트(kit.json), 명령 띠, 인수 표지, 전장 그림을 마젠타 투명 처리해 한 폴더에 모으고,
9분할 부품은 CSS border-image로, 상태가 있는 부품은 상태마다 잘라 보이는 HTML 한 장을 쓴다.

python -I tools/art/build-showcase.py --out apps/web/.tmp-model/showcase
"""

import argparse
import html
import json
import pathlib
import shutil
import sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import importlib.util

_spec = importlib.util.spec_from_file_location('publish', pathlib.Path(__file__).parent / 'publish-ui-art.py')
assert _spec and _spec.loader
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

ART = pathlib.Path('D:/codex-artifacts')
KIT = ART / 'int29-ui-kit-20261115'
BAND = ART / 'int29-command-band-20261115'
FIELD = ART / 'int29-battlefield-20261115'
UNITS = ART / 'int29-battle-units-20261115'
LABELS = ART / 'int29-labels-20261115'


def keyed(src: pathlib.Path, dst: pathlib.Path, max_side: int | None = None) -> tuple[int, int]:
    image = publish.key_magenta(Image.open(src))
    if max_side and max(image.size) > max_side:
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    image.save(dst, 'WEBP', quality=88, method=6)
    return image.size


def kit_section(out: pathlib.Path, part: str) -> list[str]:
    root = KIT / part
    for candidate in (root, root / 'kit', root / 'work' / 'kit'):
        if (candidate / 'kit.json').exists():
            root = candidate
            break
    meta_path = root / 'kit.json'
    if not meta_path.exists():
        return [f'<p class="todo">UI 키트 {part.upper()}가 아직 없습니다.</p>']
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    entries = meta if isinstance(meta, list) else meta.get('files') or meta.get('items') or []
    rows = []
    for entry in entries:
        rel = entry.get('file') or entry.get('path')
        if not rel:
            continue
        src = root / rel
        if not src.exists():
            src = root / 'kit' / pathlib.Path(rel).name
        if not src.exists():
            continue
        name = pathlib.Path(rel).stem
        dst = out / 'kit' / part / f'{name}.webp'
        w, h = keyed(src, dst)
        states = int(entry.get('states') or 1)
        sl = entry.get('slice')
        url = f'kit/{part}/{name}.webp'
        part_dir = part
        cell = []
        if sl:
            t, r, b, l = sl
            ow = Image.open(src).size[0]
            sx = w / ow
            t, r, b, l = (round(v * sx) for v in (t, r, b, l))
            names = ['평상', '올림', '누름', '불가'] if states == 4 else [f'{i + 1}' for i in range(states)]
            sheet = Image.open(dst)
            cw = w // states
            cell.append('<div class="states">')
            for i in range(states):
                piece = sheet.crop((i * cw, 0, (i + 1) * cw, h))
                part_rel = f'kit/{part_dir}/{name}-{i}.webp'
                piece.save(out / part_rel, 'WEBP', quality=88, method=6)
                # 상태마다 잘라 9분할로 늘린 모양을 보인다.
                cell.append(
                    f'<figure><div class="slice" style="width:220px;border-width:{t}px {r}px {b}px {l}px;'
                    f'border-image:url({part_rel}) {t} {r} {b} {l} fill / {t}px {r}px {b}px {l}px stretch">'
                    f'<span>{names[i]}</span></div></figure>'
                )
            cell.append('</div>')
        part_dir = part
        if states > 1 and not sl:
            cw = w // states
            cell.append('<div class="states">')
            for i, label in enumerate(['평상', '올림', '누름', '불가'][:states] if states <= 4 else range(states)):
                cell.append(
                    f'<figure><div class="sprite" style="width:{cw}px;height:{h}px;'
                    f'background:url({url}) -{i * cw}px 0 / {w}px {h}px no-repeat"></div>'
                    f'<figcaption>{label}</figcaption></figure>'
                )
            cell.append('</div>')
        cell.append(f'<img src="{url}" alt="" loading="lazy" style="max-width:min(100%,{w}px)">')
        note = html.escape(entry.get('note') or entry.get('kind') or '')
        rows.append(
            f'<article class="part"><h3>{html.escape(name)}</h3><p class="note">{note}</p>{"".join(cell)}</article>'
        )
    return rows


def folder_section(
    out: pathlib.Path, src_dir: pathlib.Path, dest: str, max_side: int | None = None, pattern: str = '*.png'
) -> list[str]:
    if not src_dir.exists():
        return [f'<p class="todo">{html.escape(str(src_dir))} 없음</p>']
    rows = []
    for src in sorted(src_dir.glob(pattern)):
        dst = out / dest / f'{src.stem}.webp'
        keyed(src, dst, max_side)
        rows.append(
            f'<figure class="thumb"><img src="{dest}/{src.stem}.webp" alt="" loading="lazy"><figcaption>{html.escape(src.stem)}</figcaption></figure>'
        )
    return rows


def latest(root: pathlib.Path, names: list[str]) -> pathlib.Path:
    for name in names:
        if (root / name).exists() and any((root / name).glob('*.png')):
            return root / name
    return root / names[-1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    # 다 만든 뒤 바꿔 끼워, 만드는 동안에도 옛 쪽이 열리게 한다.
    final = args.out
    out = final.with_name(final.name + '.building')
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    sections = [
        ('틀, 판, 단추, 입력, 게이지', 'kitA', kit_section(out, 'a')),
        ('얼굴 틀, 아이콘, 삽화, 로고', 'kitB', kit_section(out, 'b')),
        ('명령 띠 담장 조각', 'walls', folder_section(out, BAND / 'walls2', 'band/walls', 512)),
        ('명령 패 (5칸 동작: 평상, 올림, 드는 중, 고름, 불가)', 'plaques', folder_section(out, BAND / 'plaques2', 'band/plaques', 800)),
        ('세부 명령 목록 패와 받침 판', 'sublist', folder_section(out, BAND / 'sublist', 'band/sublist', 1024)),
        ('국가색 칩 (무채색 판에 나라 색을 곱함)', 'nation', folder_section(out, ART / 'int29-nation-chip-20261115' / 'out', 'nation', 1200)),
        ('직위 인수 표지', 'badges', folder_section(out, latest(BAND, ['badges4', 'badges3']), 'band/badges', 160)),
        ('황제 표지(전국옥새)', 'emperor', folder_section(out, BAND / 'badges-emperor', 'band/emperor', 256)),
        ('패 글자', 'labels', folder_section(out, LABELS / 'labels', 'labels', 256)),
        ('전장 지형 칸', 'tiles', folder_section(out, FIELD / 'tiles', 'battle/tiles', 256)),
        ('전장 표지', 'marks', folder_section(out, FIELD / 'marks', 'battle/marks', 160)),
        ('작전 회의', 'council', folder_section(out, FIELD / 'council', 'battle/council', 900)),
        ('공성전', 'siege', folder_section(out, FIELD / 'siege', 'battle/siege', 900)),
        ('공성 부대 (방향 고친 판)', 'siege2', folder_section(out, FIELD / 'siege2', 'battle/siege2', 900)),
        ('공성 장면 3판 (층, 크기, 그림자)', 'siege3', folder_section(out, FIELD / 'siege3', 'battle/siege3', 900)),
        ('공성 장면 B 치성 (재질 세 벌 × 손상 0, 3, 6)', 'siegeB', folder_section(out, FIELD / 'siegeB', 'battle/siegeB', 1200, 'preview-*.jpg')),
        ('도시 상태 아이콘', 'citystate', folder_section(out, ART / 'int29-city-state-20261115' / 'icons', 'city/state', 128)),
        ('전투 화면 틀', 'frames', folder_section(out, FIELD / 'frames', 'battle/frames', 512)),
        ('병종과 배 표지', 'units', folder_section(out, UNITS / 'units', 'battle/units', 256)),
    ]
    nav = ''.join(f'<a href="#{key}">{html.escape(title)}</a>' for title, key, _ in sections)
    body = ''.join(
        f'<section id="{key}"><h2>{html.escape(title)}</h2><div class="grid">{"".join(rows)}</div></section>'
        for title, key, rows in sections
    )
    page = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>오픈삼국 UI 쇼케이스</title><style>
:root{{--bg:#1d1712;--fg:#efe3c8;--muted:#b9aa8c;--line:#5a4430;--accent:#e2b448}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Pretendard",system-ui,sans-serif}}
header{{position:sticky;top:0;z-index:2;background:#120d09;border-bottom:2px solid var(--line);padding:8px 16px}}
header h1{{margin:0 0 4px;font-size:20px;color:var(--accent)}}
nav{{display:flex;flex-wrap:wrap;gap:6px}} nav a{{color:var(--fg);text-decoration:none;padding:4px 8px;border:1px solid var(--line)}}
main{{padding:16px}} section{{margin-bottom:40px}} h2{{color:var(--accent);border-bottom:1px solid var(--line)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}}
.part{{background:#2a1f16;border:1px solid var(--line);padding:8px}} .part h3{{margin:0;font-size:14px}} .note{{margin:0 0 6px;color:var(--muted);font-size:12px}}
.part img{{display:block;background:repeating-conic-gradient(#3a3028 0 25%,#2a2018 0 50%) 0 0/16px 16px}}
.slice{{min-height:80px;margin:6px 0;display:grid;place-items:center;color:#fff;text-shadow:0 1px 2px #000}}
.states{{display:flex;flex-wrap:wrap;gap:6px}} .states figure{{margin:0;text-align:center;font-size:12px;color:var(--muted)}} .sprite{{max-width:100%}}
.thumb{{margin:0;background:#2a1f16;border:1px solid var(--line);padding:6px;text-align:center}}
.thumb img{{max-width:100%;max-height:220px;background:repeating-conic-gradient(#3a3028 0 25%,#2a2018 0 50%) 0 0/16px 16px}}
.thumb figcaption{{font-size:12px;color:var(--muted)}} .todo{{color:#ff9a7a}}
</style></head><body><header><h1>오픈삼국 UI 쇼케이스</h1><nav>{nav}</nav></header><main>{body}</main></body></html>'''
    (out / 'index.html').write_text(page, encoding='utf-8')
    if final.exists():
        shutil.rmtree(final)
    try:
        out.rename(final)
    except PermissionError:
        # 개발 서버가 폴더를 지켜보면 Windows가 이름 바꾸기를 막는다. 그때는 복사한다.
        shutil.copytree(out, final)
        shutil.rmtree(out, ignore_errors=True)
    print('ok', final / 'index.html')
    return 0


if __name__ == '__main__':
    sys.exit(main())
