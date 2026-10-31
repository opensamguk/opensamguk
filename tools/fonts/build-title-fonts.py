"""제목 글꼴 서브셋을 만든다 (INT-20, D-047).

Run: python3 tools/fonts/build-title-fonts.py <원본 폴더>

원본은 hurss/fonts 3fc1181c의 ttf/DOSMyungjo.ttf, ttf/DOSIyagiBoldface.ttf (MIT, 이담허)다.
LICENSE가 고친 글꼴에 원래 이름을 쓰지 못하게 하므로 서브셋은 이름을 바꾼다.
"""

import hashlib
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/web/src/fonts'
REPO = 'https://github.com/hurss/fonts'
COMMIT = '3fc1181c6b4af095206068188c3ea966d6738add'
FONTS = {
    'DOSMyungjo.ttf': ('aa3861287e6375488d60fe666bbeafe5b8dc5bd76d8e05b60067501cda275a6b', 'OpenSamguk Myungjo', 'title-myungjo.woff'),
    'DOSIyagiBoldface.ttf': ('5548a69b50b9396b0d9c8141667ea8b8208ed61071aa9756e02a4e0f0d5c26f4', 'OpenSamguk Iyagi', 'title-iyagi.woff'),
}
# 화면 제목에 쓰는 한자. 늘릴 때 여기에 더하고 다시 만든다.
HANJA = '對魏吳蜀漢晉年月日天下榜將軍丞相府幕'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text():
    hangul = ''
    for lead in range(0xB0, 0xC9):
        for trail in range(0xA1, 0xFF):
            try:
                hangul += bytes([lead, trail]).decode('euc-kr')
            except UnicodeDecodeError:
                pass
    ascii_ = ''.join(chr(c) for c in range(0x20, 0x7F))
    return ascii_ + hangul + '·…‘’“”「」『』《》〈〉→←↑↓○●□■△▲※' + HANJA


def rename(font, family):
    for record in font['name'].names:
        if record.nameID in (1, 4, 16, 21):
            record.string = family
        elif record.nameID in (6, 20):
            record.string = family.replace(' ', '')


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    outputs = []
    for name, (digest, family, out) in FONTS.items():
        path = src / name
        if sha(path) != digest:
            raise SystemExit(f'{name}: 원본 해시가 다릅니다')
        font = TTFont(path)
        options = subset.Options()
        options.flavor = 'woff'
        options.name_IDs = ['*']
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(text=text())
        subsetter.subset(font)
        rename(font, family)
        OUT.mkdir(parents=True, exist_ok=True)
        font.flavor = 'woff'
        font.save(OUT / out)
        outputs.append(
            {
                'family': family,
                'file': f'apps/web/src/fonts/{out}',
                'sha256': sha(OUT / out),
                'bytes': (OUT / out).stat().st_size,
                'source': {'repository': REPO, 'commit': COMMIT, 'path': f'ttf/{name}', 'sha256': digest},
            }
        )
    meta = {
        'license': 'MIT, Copyright (c) 2016-2022 Damheo Lee (이담허)',
        'note': '원본 글꼴 이름은 LICENSE의 예약 이름이라 서브셋은 다른 이름을 쓴다.',
        'build': 'python3 tools/fonts/build-title-fonts.py <원본 폴더>',
        'fonts': outputs,
    }
    (OUT / 'sources.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


main()
