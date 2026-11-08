import re, sys, io, os, json, struct, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
d = open(os.path.join(G, 'KOEICDA.DLL'), 'rb').read()
entries = []
for m in re.finditer(rb'(?:\x01"(?:[\x20-\x7e]|[\x81-\xfe][\x41-\xfe])*\n?)+(?:\x05\x05\x05|\x05)*\x00', d[3200000:3700000]):
    t = m.group(0).decode('cp949', 'replace')
    entries.append(re.sub(r'\n?\x01"', ' ', t).replace('\x05', '').replace('\0', '').strip())
raw = json.load(open(os.path.join(OUT, 'hsg-raw.json'), encoding='utf-8'))
# N24 행 k → 열전 번호 대조
s0 = raw['scen'][0]['off']
kk = {o['name']: o['k'] for o in s0}
for nm in ['조조', '유비', '손권', '하진', '장각', '여포', '원소', '동탁']:
    k = kk.get(nm)
    print(nm, k, entries[k][:70] if k is not None and 0 <= k < len(entries) else None)
# 오프셋 탐색: 조조 열전 위치
for kw, nm in [('위의 시조', '조조'), ('촉한의 초대 황제', '유비'), ('중산정왕', '유비'), ('태평도', '장각'), ('적토마', '여포')]:
    idx = [i for i, t in enumerate(entries) if kw in t][:4]
    print(kw, nm, kk.get(nm), idx, [entries[i][:50] for i in idx[:2]])
print('head entries', [e[:40] for e in entries[:6]])
print('entries around 236', [e[:46] for e in entries[234:239]])
# 전쟁터 표
f = open(os.path.join(G, 'FIELDEXT.S6'), 'rb').read()
print('FIELDEXT', f[:6], struct.unpack('<H', f[6:8]) if len(f) > 8 else '', f[:64].hex())
names = []
for m in re.finditer(rb'(?:[\x81-\xfe][\x41-\xfe]){2,8}', f):
    try: names.append(m.group(0).decode('cp949'))
    except Exception: pass
print('field names', len(names), names[:60])
# 명승
json.dump(dict(entries=entries), open(os.path.join(OUT, 'bios-all.json'), 'w', encoding='utf-8'), ensure_ascii=False)
