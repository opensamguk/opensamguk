# 모드의 판별 상태를 꺼낸다: 도시 소유, 확장 인물, 동맹·적대 수치, 세력색.
# 읽는 파일: N24001~30.S6, hsg_event_state/*.dat, SAM6.EXE, MIDLEMAP.S6, N244MID.S6, PALETTE.S6. 모드 폴더는 읽기만 한다.
# 쓰는 파일: mod-ext.json, mod-ally.json, mod-rel.json, mod-palette.json, mod-colors.json
import collections
import json
import os
import re
import struct

G = os.environ['HSG_DIR']  # 후삼국지 삼국지편 폴더
OUT = os.environ['SAN10_V2_OUT']  # resources/map-drafts/san10-v2/data

FAC0, NF, FSZ = 520038, 27, 192  # N24 세력 표: 192바이트 27칸. +12 군주, +22 적대 수치 27칸, +76 동맹 27칸
CITY0, NC0, CSZ = FAC0 + NF * FSZ, 51, 104  # N24 도시 표: 104바이트 51칸. +2 이름, +16 세력, +18 태수
OFF0, OSZ = 97540, 650  # N24 인물 줄: 번호 i의 이름이 OFF0 + i*650
WAR = 70  # 적대 수치가 한쪽이라도 이 값 이상이면 전쟁으로 본다


def text(bs):
    return bs.split(b'\0')[0].decode('cp949', 'replace').strip()


def officer(r):
    f = struct.unpack('<40H', r[24:104])
    return dict(name=text(r[0:6]) + text(r[6:12]), rank=f[4], state=f[5], debut=f[6], birth=f[7], fac=f[10], city=f[26], stats=list(f[12:17]))


def row(pid, o):
    return [o['name'], o['rank'], o['state'], o['debut'], o['birth'], o['fac'], o['city'], o['stats'], pid]


def load_n24(n):
    b = open(os.path.join(G, f'N240{n:02d}.S6'), 'rb').read()
    offs = {}
    for i in range(2, 650):
        o = OFF0 + i * OSZ
        if o + OSZ > FAC0 - 20:
            break
        r = officer(b[o:o + OSZ])
        if r['name']:
            offs[i] = r
    cities = []
    for i in range(NC0):
        r = b[CITY0 + i * CSZ:CITY0 + (i + 1) * CSZ]
        cities.append(dict(i=i, name=text(r[2:16]), fac=struct.unpack_from('<h', r, 16)[0], gov=struct.unpack_from('<h', r, 18)[0]))
    facs = {}
    for i in range(NF):
        r = b[FAC0 + i * FSZ:FAC0 + (i + 1) * FSZ]
        if struct.unpack_from('<H', r, 12)[0] != 65535:
            facs[i] = dict(rel=struct.unpack_from('<27H', r, 22), ally=struct.unpack_from('<27H', r, 76))
    return dict(n=n, offs=offs, cities=cities, facs=facs)


def load_dat(fn):
    d = open(os.path.join(G, 'hsg_event_state', fn), 'rb').read()
    o = re.search(rb'CX44[\x01\x02]\x00', d).start()  # 확장 도시: 머리 64, 108바이트 줄(+0 도시 번호, +4 이름, +18 세력, +20 태수)
    hs = struct.unpack_from('<H', d, o + 6)[0]
    cnt, rs = struct.unpack_from('<HH', d, o + 12)
    cities = []
    for i in range(cnt):
        r = d[o + hs + i * rs:o + hs + (i + 1) * rs]
        cities.append(dict(i=struct.unpack_from('<H', r, 0)[0], name=text(r[4:18]), fac=struct.unpack_from('<h', r, 18)[0], gov=struct.unpack_from('<h', r, 20)[0]))
    o = re.search(rb'OFX1[\x01\x02]\x00', d).start()  # 확장 인물: 머리 24, 줄 = u32 번호 + 650바이트
    cnt = struct.unpack_from('<H', d, o + 6)[0]
    offs = {}
    for i in range(cnt):
        p = o + 24 + i * 654
        r = officer(d[p + 4:p + 654])
        if r['name']:
            offs[struct.unpack_from('<I', d, p)[0]] = r
    return dict(fn=fn, cities=cities, offs=offs)


def score(d, n):
    ok = tot = 0
    for src, other in ((d['cities'], n['offs']), (n['cities'], d['offs'])):
        for c in src:
            g = c['gov']
            if (0 <= g < 650) if src is d['cities'] else g >= 700:
                tot += 1
                o = other.get(g)
                if o and o['city'] == c['i'] and o['fac'] == c['fac']:
                    ok += 1
    return ok, tot


ns = {n: load_n24(n) for n in range(1, 31)}
ds = [load_dat(fn) for fn in sorted(os.listdir(os.path.join(G, 'hsg_event_state'))) if fn.endswith('.dat')]
sc = {(i, n): score(d, ns[n]) for i, d in enumerate(ds) for n in ns}
# 확장 파일 이름은 해시라, 태수 번호와 인물의 도시·세력이 맞는 판과 짝짓는다
assign = {}
changed = True
while changed:
    changed = False
    for i in range(len(ds)):
        if i in assign:
            continue
        c = [n for n in ns if sc[(i, n)][0] == sc[(i, n)][1] and n not in assign.values()]
        if len(c) == 1:
            assign[i] = c[0]
            changed = True
left = sorted(set(ns) - set(assign.values()))
for i in range(len(ds)):
    if i not in assign:
        n = max(left, key=lambda k: sc[(i, k)][0] / max(sc[(i, k)][1], 1))
        assign[i] = n
        left.remove(n)
        print('짝을 점수로 정함', ds[i]['fn'][:8], n, sc[(i, n)])
dat_of = {n: ds[i] for i, n in assign.items()}

ext, ally, rel = {}, {}, {}
for n in range(1, 31):
    N, d = ns[n], dat_of[n]
    cities = N['cities'] + d['cities']
    assert [c['i'] for c in cities] == list(range(250)), n
    ext[n] = dict(own=[c['fac'] for c in cities], names=[c['name'] for c in cities], rows=[row(p, o) for p, o in sorted(d['offs'].items())], n24=[row(p, o) for p, o in sorted(N['offs'].items())], dat=d['fn'])
    rulers = {o['fac'] for o in list(N['offs'].values()) + list(d['offs'].values()) if o['rank'] == 0 and o['state'] == 0 and o['fac'] != 65535}
    pairs, wars, vals = set(), [], []
    for i, f in N['facs'].items():
        for j in range(NF):
            if j == i or i not in rulers or j not in rulers:
                continue
            if f['ally'][j]:
                pairs.add((min(i, j), max(i, j)))
            if i < j:
                a, b = f['rel'][j], N['facs'][j]['rel'][i] if j in N['facs'] else 0
                vals.append([i, j, a, b])
                if max(a, b) >= WAR:
                    wars.append([i, j])
    ally[n] = sorted(pairs)
    rel[n] = dict(rel=vals, war=[w for w in wars if tuple(w) not in pairs])

# 세력색. 색은 작은 지도의 도시 상자 그림(24×24, 8비트)에 있다.
pal = open(os.path.join(G, 'PALETTE.S6'), 'rb').read()
PAL = ['#%02X%02X%02X' % tuple(pal[4 + i * 4:4 + i * 4 + 3]) for i in range(256)]


def boxes(fn, first, count):
    b = open(os.path.join(G, fn), 'rb').read()
    n = struct.unpack_from('<I', b, 0)[0]
    ents = [(0,) + struct.unpack_from('<III', b, 8)] + [struct.unpack_from('<IIII', b, 20 + i * 16) for i in range(n - 1)]
    hdr = 20 + (n - 1) * 16
    out = []
    for k in range(count):
        o, sz, _, _ = ents[first + k]
        out.append(PAL[collections.Counter(b[hdr + o:hdr + o + sz]).most_common(1)[0][0]])
    return out


orig = {i + 1: c for i, c in enumerate(boxes('MIDLEMAP.S6', 31, 22))}  # 색 번호 1~22
slot = {f: c for f, c in zip(range(22, 128), boxes('N244MID.S6', 1, 106))}  # 세력 칸 22~127

exe = open(os.path.join(G, 'SAM6.EXE'), 'rb').read()
pe = struct.unpack_from('<I', exe, 0x3C)[0]
base = struct.unpack_from('<I', exe, pe + 24 + 28)[0]
sec = pe + 24 + struct.unpack_from('<H', exe, pe + 20)[0]
table = None
for i in range(struct.unpack_from('<H', exe, pe + 6)[0]):
    vs, va, rs, ro = struct.unpack_from('<IIII', exe, sec + i * 40 + 8)
    if va <= 0x75A528 - base < va + max(vs, rs):
        table = ro + 0x75A528 - base - va  # 판별 색 번호 표: 줄 = 판 번호-1, 27칸 i16
assert table is not None

slots, names = {}, []
for n in range(1, 31):
    line = struct.unpack_from('<27h', exe, table + (n - 1) * 54) if n <= 23 else None
    sl = {}
    for x in ext[n]['n24'] + ext[n]['rows']:
        if x[1] != 0 or x[2] != 0 or x[5] == 65535:
            continue
        fid = x[5]
        hexc = slot.get(fid) if fid >= 22 else (orig.get(line[fid]) if line is not None and n != 15 and fid <= 20 else None)
        if hexc:
            sl[fid] = hexc
            names.append(dict(file=n, slot=fid, name=x[0], birth=x[4], pid=x[8], hex=hexc))
    slots[n] = sl


def dump(name, value):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))


dump('mod-ext.json', ext)
dump('mod-ally.json', ally)
dump('mod-rel.json', rel)
dump('mod-palette.json', dict(orig=orig, ext=slot))
dump('mod-colors.json', dict(slots=slots, names=names))
print('판', len(ext), '동맹', sum(len(v) for v in ally.values()), '전쟁', sum(len(v['war']) for v in rel.values()), '색 있는 군주', len(names))
