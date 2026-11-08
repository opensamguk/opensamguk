import re, sys, io, os, json, struct, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data
d = open(os.path.join(G, 'KOEICDA.DLL'), 'rb').read()
def nm(x):
    x = x.split(b'\0')[0]
    if not x: return ''
    try: t = x.decode('cp949')
    except Exception: return None
    return t if re.fullmatch(r'[가-힣]{1,6}', t) else None
REC = 16
def ok(p):
    if p < 0 or p + REC > len(d): return False
    a, i, y = struct.unpack('<HHH', d[p:p+6])
    s = nm(d[p+6:p+11]); g = nm(d[p+11:p+16])
    return s not in (None, '') and g is not None and 90 <= y <= 300 and 500 <= i <= 4000
b = 3129988 - 6
b = d.find(bytes.fromhex('a5025a039f00'))
print('anchor', b, ok(b), d[b:b+16].hex())
st = b
while ok(st - REC): st -= REC
en = b
while ok(en + REC): en += REC
print('table', st, en, (en - st) // REC + 1)
rows = []
for p in range(st, en + REC, REC):
    a, i, y = struct.unpack('<HHH', d[p:p+6])
    rows.append((a, i, y, nm(d[p+6:p+11]), nm(d[p+11:p+16])))
print(rows[:6]); print(rows[-6:])
people = {}
order = []
for a, i, y, s, g in rows:
    if i not in people:
        people[i] = dict(id=i, sur=s, giv=g, years=[]); order.append(i)
    people[i]['years'].append(y)
print('people', len(people), 'id range', min(people), max(people))
for p in people.values():
    non = [y for y in p['years'] if y != 185]
    p['birth'] = non[0] if non else 185
    p['name'] = p['sur'] + p['giv']
print(' '.join(people[i]['name'] for i in order)[:6000])
# 국가 표
print('== 국가 표 구역')
print(re.sub(r'[\x00-\x1f\ufffd]+', '|', d[8710900:8713200].decode('cp949', 'replace'))[:1800])
print(d[8711284-40:8711284+80].hex())
# 열전: 문장 경계 바이트 분석
print('== 열전 경계')
i = d.find('문흠의 아들로 문앙과 함께'.encode('cp949'))
print(i, d[i-60:i+8].hex())
j = d.find(b'\x22', i + 10)
print(d[i:i+160])
json.dump(dict(order=order, people=[people[i] for i in order], table=[st, en]), open(os.path.join(OUT, 'hsg-people.json'), 'w', encoding='utf-8'), ensure_ascii=False)
