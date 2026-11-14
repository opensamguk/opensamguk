import re, sys, io, os, json, struct, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
d = open(os.path.join(G, 'KOEICDA.DLL'), 'rb').read()
bios = json.load(open(os.path.join(OUT, 'bios-all.json'), encoding='utf-8'))['entries']
dic = json.load(open(os.path.join(OUT, 'hsg-clean.json'), encoding='utf-8'))['dict']
def nm(x):
    x = x.split(b'\0')[0]
    if not x: return ''
    try: t = x.decode('cp949')
    except Exception: return None
    return t if re.fullmatch(r'[가-힣]{1,6}', t) else None
def row(p):
    a, i, y = struct.unpack('<HHH', d[p:p+6])
    return a, i, y, nm(d[p+6:p+11]), nm(d[p+11:p+16])
def ok(p):
    if p < 0 or p + 16 > len(d): return False
    a, i, y, s, g = row(p)
    return s not in (None, '') and g is not None and a < 4000 and i < 4000
p0 = 3124382
st = p0
while ok(st - 16): st -= 16
en = p0
while ok(en + 16): en += 16
rows = [row(p) for p in range(st, en + 16, 16)]
print('table', st, en, len(rows), rows[:4], rows[-2:])
print('a range', min(r[0] for r in rows), max(r[0] for r in rows), 'id range', min(r[1] for r in rows), max(r[1] for r in rows))
people = collections.OrderedDict()
for a, i, y, s, g in rows:
    q = people.setdefault(i, dict(id=i, sur=s, giv=g, years=[], a=[]))
    q['years'].append(y); q['a'].append(a)
print('people', len(people))
# 열전 대응 점검: 둘째 행의 a
checks = {'공록': '월수태수', '문호': '문흠의 아들', '유비': '촉한의 초대 황제', '장각': '태평도', '을파소': '', '세오녀': '연오랑의 아내', '사반': '구수왕의 맏아들', '조조': '기도위'}
byname = {v['sur'] + v['giv']: v for v in people.values()}
for n, kw in checks.items():
    v = byname.get(n)
    if not v: print(n, None); continue
    print(n, v['id'], v['years'], v['a'], (bios[v['a'][-1]][:40] if v['a'][-1] < len(bios) else None), kw in bios[v['a'][-1]] if v['a'][-1] < len(bios) else None)
out = []
for v in people.values():
    n = v['sur'] + v['giv']
    full = n
    if len(n) >= 3:
        c = [x for x in dic if x.startswith(n) and x != n]
        if len(c) == 1 and len(n) >= 4: full = c[0]
    if full.endswith('이사'): full += '금'
    ys = [y for y in v['years'] if 90 <= y <= 320 and y != 185]
    idx = v['a'][-1]
    bio = bios[idx] if idx < len(bios) else ''
    out.append(dict(id=v['id'], name=full, birth=ys[0] if ys else None, bioIndex=idx, bio=bio))
print('with birth', sum(1 for x in out if x['birth']), 'no birth', sum(1 for x in out if not x['birth']), 'with bio', sum(1 for x in out if x['bio']))
print('dup names', sum(c - 1 for c in collections.Counter(x['name'] for x in out).values() if c > 1))
print(' '.join(x['name'] for x in out[1228:1300]))
json.dump(out, open(os.path.join(OUT, 'hsg-all.json'), 'w', encoding='utf-8'), ensure_ascii=False)
