"""INT-27 길 재편: 시나리오 기획판 지도의 길을 게임 기획·밸런스 기준으로 끊고 잇는다.

python -I route-plan.py <map.json> <plan.json> [preview.png <painted.jpg>]

사용자 2026-11-14: "길을 재구성하란 이야기는 길을 끊는것도 하란 이야기야. 게임기획과 밸런스의 의미로." /
"새로 만들거나 끊거나 하란이야기지." / "길 재편 목록을 다 승인하고." / "함곡관 자체는 그냥 두자."

입력 map.json은 운영 지도 형식(sites·routes)이다. 같은 파일에 결과를 덮어쓰고, 바꾼 내용은 plan.json에 남긴다.
규칙(순서대로):
  0. 보강: 영지가 맞닿았는데 길로 멀리 돌아가는 쌍을 잇는다(san10-expanded-route-additions 판단, ADDITIONS).
  1. 관문 지키기: 관문 이웃 가운데 관문 양쪽에 있는 두 거점을 바로 잇는 길을 끊는다(관문을 거치지 않는 우회로).
  2. 지름길 정리: 세 거점이 서로 다 이어진 삼각형에서, 가장 긴 변이 나머지 두 변을 돌아가는 길의 1.15배 이상
     짧지 않으면 끊는다. 삼국지10 원작 길은 남긴다. 끊어서 떨어져 나가는 거점이 생기면 끊지 않는다.
  3. 연결 수 상한: 큰 거점(소 이상·이민족·관문)은 길 6개까지. 넘으면 원작이 아닌 긴 길부터 끊는다.
  4. 새로 잇기: 길이 하나뿐인 큰 거점은 가장 가까운 큰 거점과 잇는다(바다 건너면 해로).
  5. 수로·해로: 장강·한수·회수 수로를 잇고, 해로를 바로잡는다(이주는 후관과 해로, 건안과는 끊는다).
     음평은 사서대로 샛길(음평 샛길→강유→면죽관)과 본길(음평→검각)로 고친다(새 거점: site-additions).
  6. 검증: 모든 거점이 하나로 이어져 있어야 한다.
"""
import json
import math
import sys
from collections import defaultdict, deque
from pathlib import Path

MAP, PLAN = sys.argv[1], sys.argv[2]
m = json.load(open(MAP, encoding='utf-8'))
# 사서 길을 위해 새로 넣는 거점(resources/map/san10-expanded-site-additions.json). 이미 있으면 넣지 않는다.
ADDED_SITES = Path(__file__).resolve().parents[2] / 'resources' / 'map' / 'san10-expanded-site-additions.json'
if ADDED_SITES.exists():
    have = {s['id'] for s in m['sites']}
    m['sites'] += [s for s in json.load(open(ADDED_SITES, encoding='utf-8'))['sites'] if s['id'] not in have]
# 거점 손질(resources/map/san10-expanded-site-edits.json): 단계는 길 재편 앞에(큰 거점 판정에 쓰인다), 이름·설명은 맨 뒤에.
EDITS_PATH = Path(__file__).resolve().parents[2] / 'resources' / 'map' / 'san10-expanded-site-edits.json'
EDITS = json.load(open(EDITS_PATH, encoding='utf-8')) if EDITS_PATH.exists() else {}
for s in m['sites']:
    if s['name'] in EDITS.get('levels', {}):
        s['level'] = EDITS['levels'][s['name']]
sites = {s['id']: s for s in m['sites']}
by_name = {s['name']: s['id'] for s in m['sites']}
name = lambda i: sites[i]['name']
pos = lambda i: (sites[i]['position']['x'], sites[i]['position']['y'])
dist = lambda a, b: math.dist(pos(a), pos(b))
plan: dict = {'cut': [], 'add': [], 'mode': [], 'level': []}

ORIGINAL = set()  # 삼국지10 원작 길(아티팩트 출처 SAN10). route id가 route:san10-* 이다.
key = lambda a, b, water=False: tuple(sorted((a, b))) + (('WATER',) if water else ())
routes = {}
for r in m['routes']:
    routes[key(r['from'], r['to'], r['mode'] in ('RIVER', 'SEA'))] = r
    if r['id'].startswith('route:san10'):
        ORIGINAL.add(key(r['from'], r['to']))


def adj(land_only=False):
    g = defaultdict(set)
    for a, b, *water in routes:
        if land_only and water:
            continue
        g[a].add(b)
        g[b].add(a)
    return g


def connected_without(a, b):
    """a–b 육로를 빼도 a에서 b로 갈 수 있는가(같은 두 거점 사이 물길이 있으면 그 길은 남는다)."""
    g = adj()
    if key(a, b, True) not in routes:
        g[a].discard(b)
        g[b].discard(a)
    seen, q = {a}, deque([a])
    while q:
        u = q.popleft()
        if u == b:
            return True
        for v in g[u]:
            if v not in seen:
                seen.add(v)
                q.append(v)
    return False


# 판단으로 남기는 길: 규칙에 걸려도 끊지 않는다(이유와 함께).
KEEP = {
    ('업', '하내'): '태항산 동쪽 기슭을 따라 하내에서 업으로 가는 큰길. 호관(태항산 위 상당 쪽 관문)을 우회하는 길이 아니다.',
}


def cut(a, b, reason):
    k = key(a, b)
    if k not in routes:
        return False
    if tuple(sorted((name(a), name(b)))) in {tuple(sorted(pair)) for pair in KEEP}:
        return False
    if not connected_without(a, b):
        return False
    r = routes.pop(k)
    plan['cut'].append({'id': r['id'], 'from': name(a), 'to': name(b), 'reason': reason})
    return True


def add(a, b, mode, reason, convert=False):
    """길을 더한다. 물길(RIVER·SEA)은 같은 두 거점 사이 육로와 따로 둔다. convert면 그 육로를 물길로 바꾼다(원래 해로)."""
    water = mode != 'LAND'
    if convert and key(a, b) in routes:
        r = routes.pop(key(a, b))
        r['mode'] = mode
        routes[key(a, b, True)] = r
        plan['mode'].append({'id': r['id'], 'from': name(a), 'to': name(b), 'mode': mode, 'reason': reason})
        return
    k = key(a, b, water)
    if k in routes:
        return
    r = {'id': f'route:plan-{mode.lower()}-{a.split(":")[1]}-{b.split(":")[1]}', 'from': a, 'to': b, 'mode': mode, 'direction': 'BOTH', 'enabled': True}
    routes[k] = r
    plan['add'].append({'id': r['id'], 'from': name(a), 'to': name(b), 'mode': mode, 'reason': reason})


def big(i):
    s = sites[i]
    return s['kind'] == 'PASS' or (s['kind'] == 'CITY' and (s.get('level') or 5) >= 4)


# 5a. 이주: 건안(산골)과 끊고 후관(동야, 회계 남쪽 바닷길 출발지)과 해로로 잇는다. 끊기 전에 새 길부터 잇는다.
add(by_name['이주'], by_name['후관'], 'SEA', '이주는 회계 바다 밖 섬. 동야(후관)가 회계 남쪽 바닷길 출발지(『後漢書』 郡國志 주 "皆從東冶汎海而至")')
cut(by_name['이주'], by_name['건안'], '건안은 민강 상류 산골이라 바닷길 출발지가 아니다')

# 5c. 음평(사용자 2026-11-14 "사서대로 고치기"). 새 길부터 잇고 끊는다.
# 샛길: 등애가 「自陰平道行無人之地七百餘里，鑿山通道，造作橋閣」 「先登至江由，蜀守將馬邈降」 뒤 부·면죽으로 나왔다
# (『三國志』 鄧艾傳). 「自陰平由景谷道旁入」(蜀書 姜維傳), 「自景谷有步道，徑江油」(『華陽國志』 漢中志). 검각을 비켜 간다.
# 본길: 강유가 「還，至陰平……欲赴關城。未到，聞其已破，退趣白水，與蜀將張翼、廖化等合守劍閣」(鄧艾傳). 음평에서 백수를 거쳐 검각으로 간다.
add(by_name['음평 샛길'], by_name['강유'], 'LAND', '음평 샛길(경곡 걸어서 가는 길)은 강유로 나온다(鄧艾傳 「先登至江由」)')
add(by_name['강유'], by_name['면죽관'], 'LAND', '등애는 강유에서 부·면죽으로 나아갔다(鄧艾傳)')
add(by_name['음평'], by_name['검각'], 'LAND', '음평 본길은 백수를 거쳐 검각으로 간다(鄧艾傳 「退趣白水……合守劍閣」)')
cut(by_name['음평 샛길'], by_name['검각'], '음평 샛길은 검각을 비켜 강유로 가는 길이다(蜀書 姜維傳 「自陰平由景谷道旁入」)')
cut(by_name['음평'], by_name['성도'], '사서에 없는 직통 길. 음평에서 성도로는 검각 본길이나 강유 샛길로만 간다')
cut(by_name['저'], by_name['성도'], '저족 땅(음평 북쪽)에서 성도로 곧장 가는 길은 음평·검각을 건너뛰는 우회로다. 음평을 거친다')

def near_line(p, a, b):
    """p에서 a–b 선분까지 거리. 관문 곁을 지나는 직통 길만 우회로로 본다(먼 산기슭 길은 둔다)."""
    (px, py), (ax, ay), (bx, by) = pos(p), pos(a), pos(b)
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(px - ax - dx * t, py - ay - dy * t)


# 1. 관문 지키기
UNIT = {'a': (2, -1), 'b': (2, 1), 'h': (0, 1), 'v': (1, 0)}
g = adj()
for p in [i for i in sites if sites[i]['kind'] == 'PASS']:
    nb = sorted(g[p])
    dirs = [(pos(n)[0] - pos(p)[0], pos(n)[1] - pos(p)[1]) for n in nb]
    best, score = 'a', -1
    for o, (ux, uy) in UNIT.items():
        length = math.hypot(ux, uy)
        s = sum(abs(dx * ux + dy * uy) / (length * (math.hypot(dx, dy) or 1)) for dx, dy in dirs)
        if s > score:
            best, score = o, s
    ux, uy = UNIT[best]
    side = {n: (pos(n)[0] - pos(p)[0]) * ux + (pos(n)[1] - pos(p)[1]) * uy for n in nb}
    for i, x in enumerate(nb):
        for y in nb[i + 1:]:
            if side[x] * side[y] < 0 and key(x, y) in routes and near_line(p, x, y) <= 12:
                cut(x, y, f'{name(p)}을(를) 거치지 않고 관문 곁을 지나 양쪽을 바로 잇는 우회로')

# 2. 지름길 정리
changed = True
while changed:
    changed = False
    g = adj()
    tris = []
    for a in list(g):
        for b in g[a]:
            for c in g[b]:
                if a < b < c and c in g[a]:
                    tris.append((a, b, c))
    for a, b, c in tris:
        edges = sorted([(dist(a, b), a, b), (dist(b, c), b, c), (dist(a, c), a, c)])
        (l1, *_), (l2, *_), (l3, x, y) = edges
        if key(x, y) not in routes or key(x, y) in ORIGINAL or key(x, y, True) in routes:
            continue
        if l1 + l2 <= l3 * 1.15:
            if cut(x, y, f'삼각형 지름길(돌아가는 길이 {round((l1 + l2) / l3, 2)}배)'):
                changed = True
                break

# 3. 연결 수 상한
g = adj()
for i in sorted(sites, key=lambda i: -len(g[i])):
    if not big(i):
        continue
    # 육로만 센다(수로·해로는 상한에 넣지 않는다).
    while len(adj(True)[i]) > 6:
        land = adj(True)
        cands = sorted((n for n in land[i] if key(i, n) not in ORIGINAL and len(land[n]) > 2), key=lambda n: -dist(i, n))
        if not cands or not cut(i, cands[0], f'{name(i)} 연결 수 6개 상한'):
            break

# 4. 새로 잇기: 길이 하나뿐인 큰 거점
g = adj()
for i in sites:
    if big(i) and len(g[i]) <= 1 and sites[i]['kind'] != 'FIELD':
        cands = sorted((n for n in sites if n != i and big(n) and n not in g[i] and sites[n]['kind'] != 'FIELD'), key=lambda n: dist(i, n))
        if cands and dist(i, cands[0]) <= 110:
            add(i, cands[0], 'LAND', f'{name(i)}은(는) 길이 하나뿐인 막다른 큰 거점')

# 5. 수로·해로
CHAINS = {
    '장강': ['강양', '강주', '임강', '영안', '자귀', '이릉', '강릉', '파구', '적벽', '강하', '주현', '기춘', '심양', '시상', '환현', '유수구', '역양', '건업', '경구'],
    '한수': ['한중', '서성', '양양', '강하'],
    '회수': ['수춘', '종리', '우이', '회음'],
}
for river, chain in CHAINS.items():
    ids = [by_name[n] for n in chain if n in by_name]
    for a, b in zip(ids, ids[1:]):
        add(a, b, 'RIVER', f'{river} 수로')
for a, b in [('답씨', '동래'), ('모로비리', '주호')]:
    add(by_name[a], by_name[b], 'SEA', '아티팩트 출처 해로(가져오기에서 육로로 바뀌었던 것)', convert=True)

# 5b. 황하(사용자 2026-11-14 승인): 중류는 삼문협(지주) "三十六難"으로 배가 다니기 어려워(『後漢書』 董卓傳) 수로를 두지 않고,
# 황하를 건너는 육로를 나루(FORD)로 둔다. 하류는 수로, 조조가 판 백구는 업으로 가는 보급 수로다(『三國志』 武帝紀 "遏淇水入白溝以通糧道").
FORDS = {
    ('낙양', '하내'): '맹진(孟津)',
    ('형양', '하내'): '소평진(小平津)',
    ('백마', '급현'): '백마진(白馬津)',
    ('백마', '업'): '백마진(白馬津)·여양',
    ('오소', '급현'): '연진(延津)',
    ('위현', '창정'): '창정진(倉亭津)',
    ('평원', '태산'): '황하 하류 나루',
    ('감릉', '제남'): '황하 하류 나루',
    ('감릉', '동평'): '황하 하류 나루',
    ('포판', '임진'): '포판진(蒲阪津)',
    ('홍농', '포판'): '황하 남쪽 굽이 나루',
    ('평양', '조음'): '진·섬 사이 황하 나루',
}
for (x, y), ferry in FORDS.items():
    k = key(by_name[x], by_name[y])
    if k in routes and routes[k]['mode'] == 'LAND':
        routes[k]['mode'] = 'FORD'
        plan['mode'].append({'id': routes[k]['id'], 'from': x, 'to': y, 'mode': 'FORD', 'reason': f'황하를 건너는 길: {ferry}'})
for chain, reason in [
    # 후한 황하(왕경이 고친 물길, 後漢書 循吏列傳 「自滎陽東至千乘海口」)는 복양에서 동쪽으로 흘러 제남 곁을 지나 바다에
    # 든다. 그림 지도의 황하도 같다. 처음 넣은 복양→평원→염차는 전한 때 북류 물길이라 고쳤다(2026-11-14).
    (['형양', '백마', '복양', '제남', '염차'], '황하 하류 수로'),
    (['백마', '업'], '백구 수로(조조가 판 군량 길, 204년)'),
]:
    ids = [by_name[n] for n in chain]
    for x, y in zip(ids, ids[1:]):
        add(x, y, 'RIVER', reason)

# 게양: 항구 근거가 약해 현(2)으로
gy = sites[by_name['게양']]
if gy.get('level') == 1:
    gy['level'] = 2
    plan['level'].append({'name': '게양', 'level': 2, 'reason': '『後漢書』 郡國志 남해군 揭陽縣. 항구로 쓴 기록 없음(번우가 남해 바닷길 중심)'})

# 6. 검증
g = adj()
start = next(iter(sites))
seen, q = {start}, deque([start])
while q:
    u = q.popleft()
    for v in g[u]:
        if v not in seen:
            seen.add(v)
            q.append(v)
lonely = [name(i) for i in sites if i not in seen]
plan['check'] = {'routes': len(routes), 'unreachable': lonely}

m['routes'] = list(routes.values())
# 거점 손질: 설명 고치기 → 이름 바꾸기(191년 이름). plan.json의 길 기록은 바꾸기 전 이름이다.
plan['rename'] = []
for s in m['sites']:
    old = s['name']
    if old in EDITS.get('descriptions', {}):
        s['description'] = EDITS['descriptions'][old]
    for r in EDITS.get('renames', []):
        if r['from'] == old:
            s['name'] = r['to']
            if r.get('note') and r['to'] not in (s.get('description') or ''):
                s['description'] = ((s.get('description') or '') + ' ' + r['note']).strip()
            plan['rename'].append({'id': s['id'], 'from': old, 'to': r['to']})
plan['level'] += [{'name': n, 'level': v, 'reason': '군·주 치소(사용자 2026-11-15 추천대로)'} for n, v in EDITS.get('levels', {}).items()]
names_now = [s['name'] for s in m['sites']]
dup = sorted({n for n in names_now if names_now.count(n) > 1})
assert not dup, f'겹치는 이름: {dup}'
json.dump(m, open(MAP, 'w', encoding='utf-8'), ensure_ascii=False)
json.dump(plan, open(PLAN, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('cut', len(plan['cut']), 'add', len(plan['add']), 'mode', len(plan['mode']), 'routes', len(routes), 'unreachable', lonely)

# 전후 그림
if len(sys.argv) >= 5:
    from PIL import Image, ImageDraw

    Image.MAX_IMAGE_PIXELS = None
    W, H = m['canvas']['width'], m['canvas']['height']
    k = 2
    img = Image.open(sys.argv[4]).convert('RGB').resize((W * k, H * k))
    img = Image.blend(img, Image.new('RGB', img.size, (40, 40, 40)), 0.45)
    dr = ImageDraw.Draw(img)
    P = lambda i: (pos(i)[0] * k, pos(i)[1] * k)
    for r in routes.values():
        color = {'LAND': (230, 220, 190), 'FORD': (255, 170, 60), 'BRIDGE': (255, 170, 60), 'RIVER': (90, 200, 255), 'SEA': (255, 255, 255)}[r['mode']]
        dr.line([P(r['from']), P(r['to'])], fill=color, width=2)
    for c in plan['cut']:
        dr.line([P(by_name[c['from']]), P(by_name[c['to']])], fill=(255, 60, 60), width=3)
    for a in plan['add']:
        if a['mode'] == 'LAND':
            dr.line([P(by_name[a['from']]), P(by_name[a['to']])], fill=(90, 255, 120), width=3)
    for i in sites:
        x, y = P(i)
        rr = 4 if big(i) else 2
        dr.ellipse((x - rr, y - rr, x + rr, y + rr), fill=(255, 200, 80) if sites[i]['kind'] == 'PASS' else (250, 250, 250))
    img.save(sys.argv[3])
