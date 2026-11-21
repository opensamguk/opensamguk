import re, sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
raw = json.load(open(os.path.join(OUT, 'hsg-raw.json'), encoding='utf-8'))
meta = json.load(open(os.path.join(OUT, 'hsg-meta.json'), encoding='utf-8'))
def ks(name):
    # KS X 1001 완성형 2,350자만 사람 이름으로 본다
    try: b = name.encode('euc-kr')
    except Exception: return False
    return len(b) == 2 * len(name) and all(0xb0 <= b[i] <= 0xc8 for i in range(0, len(b), 2))
GEN = re.compile(r'^(남만|산월|강|저|오환|흉노|선비|왜|한)(왕|장수)$')
scen = []
for s in raw['scen']:
    rows = []
    for o in s['off']:
        n = o['name']
        if len(n) < 2 or not ks(n) or GEN.match(n): continue
        if o['st'] not in (0, 1, 2) or o['st2'] not in (0, 1, 2, 3, 5): continue
        if not (90 <= o['birth'] <= 300): continue
        rows.append([n, o['st'], o['st2'], o['debut'], o['birth'], o['fac'], o['city'], o['stats']])
    scen.append(dict(file=s['file'], year=s['year'], month=s['month'], title=meta['titles'][s['file']-1], rows=rows))
d = meta['dict']
# 앞쪽의 금칙어 묶음을 건너뛴다: 정렬이 처음 되돌아가는 지점 뒤가 인명 사전
start = 0
for i in range(1, len(d)):
    if d[i] < d[i-1]:
        start = i; break
names = [n for n in d[start:] if ks(n)]
print('dict cut', start, d[:start][:30], 'names', len(names), names[:8])
print('rows sample', len(scen[3]['rows']), scen[3]['rows'][:2])
all_names = set(r[0] for s in scen for r in s['rows'])
print('clean scenario names', len(all_names))
json.dump(dict(cities=raw['cities'], desc=meta['desc'], prov=meta['prov'], scen=scen, dict=names), open(os.path.join(OUT, 'hsg-clean.json'), 'w', encoding='utf-8'), ensure_ascii=False)
