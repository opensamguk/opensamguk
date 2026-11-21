import re, sys, io, os, json, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
d = open(os.path.join(G, 'KOEICDA.DLL'), 'rb').read()
ppl = json.load(open(os.path.join(OUT, 'hsg-people.json'), encoding='utf-8'))['people']
meta = json.load(open(os.path.join(OUT, 'hsg-clean.json'), encoding='utf-8'))
N = [c[0] for c in meta['cities']]
entries = []
for m in re.finditer(rb'(?:\x01"(?:[\x20-\x7e]|[\x81-\xfe][\x41-\xfe])*\n?)+(?:\x05\x05\x05|\x05)*\x00', d[3200000:3700000]):
    t = m.group(0).decode('cp949', 'replace')
    entries.append(re.sub(r'\n?\x01"', ' ', t).replace('\x05', '').replace('\0', '').strip())
print('entries', len(entries))
# 번호 대조
check = {p['sur'] + p['giv']: p['id'] for p in ppl}
order_ = [p['sur'] + p['giv'] for p in ppl]
for nm in ['문호', '이요', '석우로', '요주', '수로왕', '고국천왕', '순심', '진물']:
    i = order_.index(nm) + 500
    print(nm, i, entries[i][:80])
# 권역 표(284바이트 줄)
row = 8707876 - 284
regions = {}
for k in range(0, 20):
    o = row + 284 * k
    nm_ = d[o:o+24].split(b'\0')[0]
    try: nm = nm_.decode('cp949')
    except Exception: continue
    if not nm or not re.fullmatch(r'[가-힣·]{1,8}', nm): continue
    blob = d[o+32:o+96]
    cap = blob[0]; cnt = blob[1]
    ids = list(blob[2:2+cnt])
    regions[nm] = dict(capital=N[cap] if cap < 250 else None, cities=[N[i] for i in ids if i < 250])
for k, v in regions.items():
    print(k, v['capital'], len(v['cities']), ' '.join(v['cities'])[:200])
cov = set(c for v in regions.values() for c in v['cities'])
print('covered', len(cov), 'uncovered', [n for n in N if n not in cov])
# 사람 정리
dic = meta['dict']
SIDE_EXACT = {
 'gog': '고국천왕 산상왕 동천왕 중천왕 서천왕 고발기 고계수 우씨왕후 어비류 좌가려 안류 을파소 고우루 명림어수 밀우 유옥구 유유 다우 명림홀도 고달가 득래 예물 사구 연씨왕후 관나부인 음우 상루 서천왕후 재사',
 'bj': '초고왕 구수왕 고이왕 진과 부여질 진충 진물',
 'sr': '벌휴이사 나해이사 조분이사 첨해이사 미추이사 구도 구수혜 이음 물계자 석우로 설부 술명 국량 훤견 윤종 충훤 연진 강훤 연충 아음부 장훤 양부 부도 익종 극종 직선 아아혜부 광명부인',
 'gy': '수로왕 거등왕 마품왕',
 'by': '위구태 간위거 마여 의려',
 'wa': '히미코 이요 난승미 도시우리 이성기 액야구 오월 히미쿠코 구코치히',
}
exact = {n: k for k, v in SIDE_EXACT.items() for n in v.split()}
RULES = [('gog', r'고구려'), ('bj', r'백제'), ('sr', r'신라|사로국|이사금'), ('gy', r'가락|가야|금관'), ('by', r'부여'), ('wa', r'왜의|왜 |야마타이|비미호|히미코'),
         ('xianbei', r'선비'), ('wuhuan', r'오환'), ('hun', r'흉노'), ('qiang', r'강족|강의 '), ('di', r'저족|저왕'), ('man', r'남만|남중|맹획'), ('shanyue', r'산월|단양의 도적'),
         ('hj', r'황건'), ('shu', r'촉한|촉의|유비|유선|제갈량|제갈양|강유'), ('wu', r'오의|손권|손책|손견|손호|손량|오나라|동오'), ('cao', r'위의|조조|조비|조예|사마|위나라|진의|서진|위에서|조방|진나라'),
         ('yuan', r'원소|원담|원상|원희'), ('ys', r'원술'), ('jing', r'유표'), ('yi', r'유언|유장'), ('liaodong', r'공손|요동'), ('gsz', r'공손찬'), ('dong', r'동탁|이각|곽사'), ('lu', r'여포'), ('ma', r'마등|마초'), ('zl', r'장로'), ('xu', r'도겸'), ('jiao', r'사섭'), ('han', r'후한|한의|영제|헌제|환제|하진|중상시|십상시')]
out = []
for k_, p in enumerate(ppl):
    nm = p['sur'] + p['giv']
    # 잘린 이름 복원
    full = nm
    if len(nm) >= 4:
        c = [x for x in dic if x.startswith(nm) and x != nm]
        if len(c) == 1: full = c[0]
    if full.endswith('이사'): full += '금'
    if full == '독발수기': full = '독발수기능'
    bio = entries[500 + k_] if 500 + k_ < len(entries) else ''
    death = None
    m = re.findall(r'(\d{3})년(?:까지 재위|[^.]{0,30}?(?:죽었|죽임|사망|처형|전사|살해|목이 베|자결|병사|병으로 죽|세상을 떠|독살))', bio)
    if m: death = int(m[-1])
    m2 = re.findall(r'(\d{3})년', bio)
    last = max(map(int, m2)) if m2 else None
    side = exact.get(nm)
    src = '표'
    if not side:
        best = None
        for k, rx in RULES:
            mm = re.search(rx, bio)
            if mm and (best is None or mm.start() < best[0]):
                best = (mm.start(), k)
        side = best[1] if best else None
        src = '열전'
    out.append(dict(id=p['id'], name=full, birth=p['birth'], death=death, last=last, side=side, src=src, bio=bio[:220]))
print('people', len(out), 'death found', sum(1 for x in out if x['death']), 'side', collections.Counter(x['side'] for x in out).most_common(40))
print([ (x['name'], x['birth'], x['death'], x['side']) for x in out if x['side'] in ('gog', 'bj', 'sr', 'gy', 'by', 'wa')][:70])
print('placeholder birth 185', sum(1 for x in out if x['birth'] == 185))
json.dump(dict(people=out, regions=regions), open(os.path.join(OUT, 'hsg-ext.json'), 'w', encoding='utf-8'), ensure_ascii=False)
