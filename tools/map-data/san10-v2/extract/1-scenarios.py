import re, sys, io, os, struct, json, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
def rd(n): return open(os.path.join(G, n), 'rb').read()
d = rd('KOEICDA.DLL')
def cs(b):
    b = b.split(b'\0')[0]
    try: t = b.decode('cp949')
    except Exception: return None
    return t if t and all(ord(c) >= 0x20 for c in t) else None
start = 8586096
cities = []
for i in range(250):
    o = start + 28 * i
    cities.append((cs(d[o:o+12]), *struct.unpack('<4I', d[o+12:o+28])))
cname = [c[0] for c in cities]
print('idx 낙양', cname.index('낙양'), '허창', cname.index('허창'), '탁군', cname.index('탁군'), '거록', cname.index('거록'), '상당', cname.index('상당'))
HANGUL = re.compile(r'^[가-힣0-9 ·,()~∼월년:!?\-]+$')
print('== titles')
seen = 0
for m in re.finditer(rb'(?:[\x20-\x7e]|[\x81-\xfe][\x41-\xfe]){3,44}\x00', d[3200000:9000000]):
    t = cs(m.group(0))
    if not t or not HANGUL.match(t): continue
    if re.match(r'^\d{3}년', t) or re.search(r'^시나리오', t):
        seen += 1
        if seen < 80: print(3200000 + m.start(), t)
for kw in ['황건의', '시랑', '군웅', '천하이', '적벽', '관도', '출사', '오장원의', '영웅집결', '제갈탄']:
    print(kw, [ (3200000+m.start(), (cs(d[3200000+m.start()-12:3200000+m.start()+30]) or '')[:30]) for m in list(re.finditer(re.escape(kw.encode('cp949')), d[3200000:9000000]))[:3]])
# 시나리오 추출
REC = 650; FIRST = 98840 - 0
def rec_iter(b):
    # 이름 오프셋 = 98840 + k*650
    for k in range(-20, 700):
        o = 98840 + k * REC
        if o < 0 or o + REC > len(b): continue
        s = cs(b[o:o+6]); g = cs(b[o+6:o+12])
        if not s and not g: continue
        w = struct.unpack('<30H', b[o+24:o+24+60])
        yield k, o, s or '', g or '', w, b[o-24:o+24+120]
scen = []
for k in range(1, 31):
    b = rd(f'N240{k:02d}.S6')
    y, m0, no = struct.unpack('<HHH', b[:6])
    off = []
    for kk, o, s, g, w, raw in rec_iter(b):
        off.append(dict(k=kk, name=s + g, st=w[4], st2=w[5], debut=w[6], birth=w[7], w8=w[8], fac=w[10], stats=w[12:17], city=w[26]))
    scen.append(dict(file=k, year=y, month=m0, no=no, off=off))
    if k in (1, 3, 30):
        c = collections.Counter((x['st'], x['st2']) for x in off)
        print('file', k, y, m0, 'recs', len(off), c.most_common(10))
        c2 = collections.Counter(x['fac'] for x in off)
        print('   fac', sorted(c2.items())[:40])
b = rd('N24001.S6')
print('tail', b[553840:553840+80].hex())
for nm in ['하진', '장각', '조조', '동탁', '유언', '화타', '왕건', '비미호', '유리왕']:
    x = next((o for o in scen[0]['off'] if o['name'] == nm), None)
    print(nm, x and {k: x[k] for k in ('k','st','st2','debut','birth','fac','city','stats')}, x and (cname[x['city']] if x['city'] < 250 else None))
for fid in sorted(set(o['fac'] for o in scen[0]['off'] if o['fac'] != 65535)):
    mem = [o for o in scen[0]['off'] if o['fac'] == fid]
    r = [o['name'] for o in mem if o['st'] == 0]
    cities_ = collections.Counter(cname[o['city']] if o['city'] < 250 else '?' for o in mem)
    print(fid, 'rulers', r[:3], 'n', len(mem), list(cities_.items())[:8])
json.dump(dict(cities=cities, scen=scen), open(os.path.join(OUT, 'hsg-raw.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('all names', len(set(o['name'] for s in scen for o in s['off'])))
