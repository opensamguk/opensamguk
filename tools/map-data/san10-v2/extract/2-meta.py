import re, sys, io, os, struct, json, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
def rd(n): return open(os.path.join(G, n), 'rb').read()
d = rd('KOEICDA.DLL')
raw = json.load(open(os.path.join(OUT, 'hsg-raw.json'), encoding='utf-8'))
N = [c[0] for c in raw['cities']]
HG = re.compile(r'^[가-힣]{1,6}$')
# 정렬된 이름 사전
def dict_at(anchor):
    a = anchor
    # 뒤로
    names = []
    p = anchor
    while True:
        q = d.rfind(b'\0', p - 16, p - 1)
        if q < 0: break
        try: t = d[q+1:p-1].decode('cp949')
        except Exception: break
        if not HG.match(t): break
        names.insert(0, t); p = q + 1
    start = p
    p = anchor
    while True:
        q = d.find(b'\0', p, p + 16)
        if q < 0: break
        try: t = d[p:q].decode('cp949')
        except Exception: break
        if not HG.match(t): break
        names.append(t); p = q + 1
    return start, names
s, names = dict_at(3779146)
print('dict start', s, 'count', len(names), names[:12], names[-8:])
s2, names2 = dict_at(6375982)
print('dict2', s2, len(names2), names == names2)
# 표: 성, 이름, 전체 이름 구조 @8579170
base = 8579170
print(d[base-60:base+200].hex())
print('== 표 줄 간격')
for nm in ['독발수기능', '모용섭귀', '탁발역미', '마륭', '문호']:
    hits = [m.start() for m in re.finditer(re.escape(nm.encode('cp949') + b'\0'), d[8500000:8620000])]
    print(nm, [8500000 + h for h in hits][:6])
# 제목
i = d.find('황건의 난'.encode('cp949'), 8533000)
titles = []; p = i
while len(titles) < 30 and p < i + 800:
    q = d.find(b'\0', p); titles.append(d[p:q].decode('cp949', 'replace'))
    p = q + 1
    while p < len(d) and d[p] == 0: p += 1
print('titles', titles)
print('== 승리 조건')
w = d[8555690:8557000].decode('cp949', 'replace')
print(re.sub(r'[\x00-\x1f\ufffd]+', '|', w)[:700])
# 도시 설명
desc = {}
for m in re.finditer(rb'(?:[\x81-\xfe][\x41-\xfe]){1,5}\r?\n(?:[\x20-\x7e\r\n]|[\x81-\xfe][\x41-\xfe]){20,700}\x00', d[8480000:8660000]):
    try: t = m.group(0)[:-1].decode('cp949')
    except Exception: continue
    head, _, body = t.partition('\n')
    head = head.strip()
    if head in N and head not in desc:
        desc[head] = re.sub(r'\s*\r?\n\s*', ' ', body).strip()
print('desc', len(desc), 'missing', [n for n in N if n not in desc][:60])
prov = {}
for n, t in desc.items():
    m = re.match(r'^(\S{1,3}주)\s', t)
    prov[n] = m.group(1) if m else None
print(collections.Counter(prov.values()).most_common(24))
# 상태 해석
s4 = raw['scen'][3]
groups = collections.defaultdict(list)
for x in s4['off']:
    groups[(x['st'], x['st2'])].append(x)
print('file4', s4['year'], s4['month'])
for key, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:8]:
    print(key, len(v), [f"{o['name']}@{N[o['city']] if o['city'] < 250 else o['city']}/f{o['fac'] if o['fac'] != 65535 else '-'}/{o['birth']}" for o in v[:8]])
for idx, s_ in enumerate(raw['scen']):
    rulers = {}
    for x in s_['off']:
        if x['st'] == 0 and x['st2'] == 0 and x['fac'] < 64 and HG.match(x['name']):
            rulers[x['fac']] = x['name']
    print(idx + 1, s_['year'], s_['month'], titles[idx] if idx < len(titles) else '', len(rulers), ' '.join(rulers[f] for f in sorted(rulers))[:260])
reg = json.load(open(os.path.join(OUT, '..', 'roster-merged.json'), encoding='utf-8'))
rn = set(r['name'] for r in reg)
dn = set(names)
mod = set(o['name'] for s_ in raw['scen'] for o in s_['off'] if HG.match(o['name']))
print('registry', len(rn), 'dict', len(dn), 'both', len(rn & dn), 'scenario names', len(mod), 'scen∩dict', len(mod & dn))
print('registry not in dict', len(rn - dn), ' '.join(sorted(rn - dn))[:400])
print('dict not in registry', len(dn - rn), ' '.join(sorted(dn - rn))[:1200])
json.dump(dict(titles=titles, desc=desc, prov=prov, dict=names), open(os.path.join(OUT, 'hsg-meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)
