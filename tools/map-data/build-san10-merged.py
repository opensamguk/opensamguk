"""Build the review-only union of SAN10, current-map extras and East Asia.

Run from any directory: python tools/map-data/build-san10-merged.py
This writes draft files only; it does not change the operational map or database.
"""
import copy
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/map-drafts/san10'

# Representative game placement points, not surveyed ancient-town coordinates.
# Existing operational positions and the earlier East Asia draft take precedence.
REGIONAL_POINTS = {
    '주천': (98.51, 39.74, '주취안권'),
    '남안': (104.89, 34.73, '남안군·웨이수이 상류권'),
    '진창': (107.38, 34.35, '바오지 동부권'),
    '오장원': (107.63, 34.28, '치산 남부권'),
    '화산': (110.08, 34.48, '화산 산지권'),
    '서성': (109.02, 32.68, '안캉권'),
    '방릉': (110.74, 32.06, '팡현권'),
    '한가': (102.93, 30.15, '루산권'),
    '강양': (105.38, 28.88, '루저우권'),
    '임강': (108.04, 30.30, '중현권'),
    '월수': (102.30, 27.88, '시창권'),
    '주제': (103.72, 27.34, '자오퉁권'),
    '노수': (102.95, 26.91, '진사강 도하 권역'),
    '애뢰': (99.18, 24.65, '바오산 남부의 대표 권역'),
    '사룡': (100.31, 25.23, '웨이산권'),
    '흥고': (104.25, 23.37, '원산권'),
    '합포': (109.20, 21.67, '허푸권'),
    '구원': (109.82, 40.65, '바오터우권'),
    '항산': (113.75, 39.00, '항산 산지의 대표 권역'),
    '거록': (115.03, 37.22, '쥐루권'),
    '임치': (118.31, 36.82, '린쯔권'),
    '태산': (117.10, 36.25, '태산 산지권'),
    '낭야': (118.35, 35.10, '린이권'),
    '하동': (110.99, 35.02, '윈청권'),
    '백마': (114.54, 35.57, '화현 백마진 권역'),
    '팽성': (117.18, 34.28, '쉬저우권'),
    '숭산': (112.96, 34.48, '숭산·덩펑권'),
    '진': (114.90, 33.73, '화이양권'),
    '노양': (112.90, 33.74, '루산현권'),
    '의양': (114.07, 32.13, '신양권'),
    '번성': (112.13, 32.08, '양양 북쪽 한수 건너편'),
    '석정': (116.93, 30.92, '퉁청권'),
    '유수구': (118.06, 31.31, '차오후 남동쪽 도하 권역'),
    '화용': (112.73, 30.32, '첸장 남서부·룽완권'),
    '서새산': (115.17, 30.20, '황스 서새산 권역'),
    '공안': (112.23, 30.06, '궁안권'),
    '심양': (116.00, 29.83, '주장 맞은편 장강 북안권'),
    '남창': (115.88, 28.68, '난창권'),
    '회음': (119.02, 33.60, '화이안·화이인권'),
    '경구': (119.43, 32.18, '전장권'),
    '부춘': (119.95, 30.06, '저장 푸양권'),
    '임해': (121.15, 28.85, '린하이권'),
    '형산': (112.67, 27.25, '헝산 산지권'),
    '임하': (111.55, 24.41, '허저우권'),
    '곡강': (113.58, 24.80, '사오관권'),
    '창오': (111.32, 23.48, '우저우권'),
}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def project(lon, lat):
    return {'x': round((lon - 94) * 700 / 27), 'y': round((44 - lat) * 700 / 27)}


def main():
    source = read(OUT / 'placement.json')
    coordinates = read(OUT / 'coordinate-placement.json')
    operational = read(ROOT / 'resources/map/integration.json')
    existing = {s['id']: s for s in operational['sites']}
    extra_coordinates = {s['id']: s for s in coordinates['sites']}
    sites, aliases = [], {}
    for original in source['sites']:
        site = copy.deepcopy(original)
        site['surveyPosition'] = site.pop('position')
        match = site.get('currentMapMatch')
        site['region'] = '중국·요동'
        if match:
            site['position'] = existing[match['id']]['position']
            site['positionBasis'] = 'INHERITED_OPERATIONAL_POSITION'
            aliases[match['id']] = site['id']
        elif site['id'] in extra_coordinates:
            coordinate = extra_coordinates[site['id']]
            for key in ['position', 'geographicReference', 'region', 'modernArea']:
                site[key] = coordinate[key]
            site['positionBasis'] = 'INHERITED_COORDINATE_DRAFT'
        else:
            lon, lat, area = REGIONAL_POINTS[site['name']]
            site['position'] = project(lon, lat)
            site['geographicReference'] = {'longitude': lon, 'latitude': lat}
            site['modernArea'] = area
            site['positionBasis'] = 'PROPOSED_REGIONAL_GAME_POSITION'
        sites.append(site)
    present = {s['id'] for s in sites}
    for coordinate in coordinates['sites']:
        if coordinate['id'] not in present:
            sites.append({**coordinate, 'strategic': True, 'positionBasis': 'INHERITED_COORDINATE_DRAFT'})
    for original in operational['sites']:
        if original['id'] in aliases:
            continue
        site = copy.deepcopy(original)
        site.update(role=site['kind'], region='중국·요동', strategic=site['kind'] == 'CITY',
                    positionBasis='INHERITED_OPERATIONAL_POSITION', retainedOperationalOnly=True)
        if site.get('parentCityId'):
            site['parentSiteId'] = aliases[site['parentCityId']]
        aliases[site['id']] = site['id']
        sites.append(site)
    by_name = {s['name']: s['id'] for s in sites}
    edges = copy.deepcopy(source['connections'])
    for edge in edges:
        edge['enabled'] = True
    legacy_hongnong = [r for r in operational['routes'] if 'city:42' in [r['from'], r['to']]]
    for route in legacy_hongnong:
        edges.append({'id': route['id'], 'from': aliases[route['from']], 'to': aliases[route['to']],
                      'mode': route['mode'], 'status': 'INHERITED_OPERATIONAL', 'enabled': True,
                      'direction': 'UNDIRECTED', 'note': '현재 지도 홍농의 두 인접 관계 보존'})
    proposals = copy.deepcopy(source['proposedConnections'])
    for edge in proposals:
        edge['enabled'] = False
    east_asia_pairs = [
        ('양평', '서안평'), ('서안평', '낙랑'), ('서안평', '졸본'), ('졸본', '국내성'),
        ('국내성', '부여'), ('국내성', '부조'), ('부여', '읍루'), ('읍루', '북옥저'),
        ('북옥저', '부조'), ('부조', '화려'), ('화려', '불이'), ('낙랑', '불이'),
        ('낙랑', '백제국'), ('백제국', '목지국'), ('목지국', '건마국'), ('목지국', '사로국'),
        ('건마국', '구야국'), ('사로국', '구야국'), ('불이', '사로국'),
        ('구야국', '대마국'), ('대마국', '일지국'), ('일지국', '말로국'),
        ('말로국', '이도국'), ('이도국', '노국'), ('노국', '불미국'),
        ('불미국', '이즈모'), ('불미국', '기비'), ('이즈모', '기비'),
        ('기비', '야마타이국'), ('기비', '사누키'), ('사누키', '이요'),
    ]
    water = {('구야국', '대마국'), ('대마국', '일지국'), ('일지국', '말로국'),
             ('불미국', '이즈모'), ('불미국', '기비'), ('기비', '사누키')}
    for i, pair in enumerate(east_asia_pairs, 1):
        proposals.append({'id': f'EA{i:02}', 'from': by_name[pair[0]], 'to': by_name[pair[1]],
                          'mode': 'WATER' if pair in water else 'LAND', 'direction': 'UNDIRECTED',
                          'status': 'PROPOSED', 'enabled': False,
                          'note': '권역을 잇는 게임 연결 제안. 연속된 고대 도로나 항로의 판독 결과가 아님.'})
    attachments = []
    for site in sites:
        if site.get('parentSiteId'):
            attachments.append({'id': f"attach:{site['id']}", 'from': site['parentSiteId'],
                                'to': site['id'], 'mode': 'FACILITY', 'strategic': False})
    for name in ['시상', '여강']:
        attachments.append({'id': f'context:poyang:{by_name[name]}', 'from': by_name[name],
                            'to': 'field:92', 'mode': 'RIVER_CONTEXT', 'strategic': False,
                            'note': '기존 시상–여강 수로의 파양 경유 표식. 독립 이동 명령의 끝점이 아님.'})
    strategic = {s['id'] for s in sites if s['strategic']}
    adjacency = {sid: set() for sid in strategic}
    for edge in edges + proposals:
        assert edge['from'] != edge['to']
        adjacency[edge['from']].add(edge['to'])
        adjacency[edge['to']].add(edge['from'])
    visited, todo = set(), [next(iter(strategic))]
    while todo:
        sid = todo.pop()
        if sid not in visited:
            visited.add(sid)
            todo.extend(adjacency[sid] - visited)
    pairs = [tuple(sorted([e['from'], e['to']])) for e in edges + proposals]
    assert len(pairs) == len(set(pairs))
    assert len(sites) == len({s['id'] for s in sites}) == len(by_name) == 159
    assert len(visited) == len(strategic) == 152
    assert all(tuple(sorted([e['from'], e['to']])) not in pairs for e in source['excludedDirectConnections'])
    counts = {'sites': len(sites), 'strategicSites': len(strategic), 'facilities': 7,
              'sourceSites': 119, 'regionalSites': 7, 'additionalEastAsiaSites': 25,
              'retainedOperationalOnlySites': 8, 'matchedOperationalSites': 72,
              'inheritedOperationalPositions': 80, 'newChinaRegionalPositions': len(REGIONAL_POINTS),
              'sourceConnections': 153, 'inheritedHongnongConnections': 2,
              'connections': len(edges), 'proposedConnections': len(proposals),
              'eastAsiaProposals': len(east_asia_pairs), 'facilityRelations': len(attachments),
              'roles': dict(Counter(s['role'] for s in sites)),
              'levelsNotAssigned': sum(s['strategic'] and s.get('level') is None for s in sites)}
    result = {'format': 'opensamguk-merged-map-draft', 'version': 1, 'status': 'DRAFT_NOT_RUNTIME_RESOURCE',
              'date': '2026-10-29', 'relatedAcceptanceCriteria': ['AC-INT-03', 'AC-INT-10'],
              'coordinateSystem': coordinates['coordinateSystem'], 'basemap': coordinates['basemap'],
              'counts': counts, 'sites': sites, 'connections': edges, 'proposedConnections': proposals,
              'facilityRelations': attachments, 'excludedDirectConnections': source['excludedDirectConnections'],
              'operationalSiteAliases': aliases, 'legacyRouteReference': operational['routes'],
              'limits': ['기존 실행 지도와 DB는 바꾸지 않은 통합 배치 초안이다.',
                         '확인한 153관계와 기존 홍농 2관계를 보존했다. 제안 45관계는 실행 연결로 확정하지 않는다.',
                         '기존 도시 직통로를 전부 중복 활성화하면 새 공터를 우회하므로 원문 참고 자료로 보존한다.',
                         '추가 25곳의 레벨·경제·소유권은 미정이다.',
                         '중국 공터 46곳은 대표 권역에 제안한 게임 좌표이며 정확한 고대 유적 측량값이 아니다.',
                         '선은 연결 관계다. GIS 지형을 따른 실제 경로·해안·고갯길의 형상은 별도 작업이다.'],
              'regionalPointReferences': {
                  '사룡': 'https://www.baoshan.gov.cn/virtual_attach_file.vsb?afc=KnRvODUm-aolWfMx7VfLzWVLm7PMlWJ7LRLsUmUsUz-PLlU0gihFp2hmCIa0n1h7oSh7okyPU4vsU4rfMR7PLzWRUlCYM4nfMRf2MRA7MzQFU4CZL4NbolnFnN78UNlbgjfNQmOeo4x1vsMYp5XtpIAs_m-aLm-0qIbtpYyYoz7bM1yPLRLPLR7YMkbw6208c',
                  '남안': 'https://www.tianshui.gov.cn/dsb/info/1883/18872.htm',
                  '화용': 'https://www.hbqj.gov.cn/zjqj/qjgk/lsyg/',
                  '한가': 'https://www.sc.gov.cn/10462/c108551/2022/2/15/2e9dd7f9fb0c40d590d1e1c407cc59c9/files/ca99c291f664426590309452e32e0c12.pdf'},
              'inputHashes': {str(p.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in [OUT / 'placement.json', OUT / 'coordinate-placement.json', ROOT / 'resources/map/integration.json']}}
    write(OUT / 'merged-placement.json', result)
    with (OUT / 'merged-sites.csv').open('w', encoding='utf-8-sig', newline='') as target:
        writer = csv.writer(target)
        writer.writerow(['id', 'name', 'role', 'strategic', 'level', 'x', 'y', 'positionBasis'])
        for s in sites:
            writer.writerow([s['id'], s['name'], s['role'], s['strategic'], s.get('level'),
                             s['position']['x'], s['position']['y'], s['positionBasis']])
    with (OUT / 'merged-connections.csv').open('w', encoding='utf-8-sig', newline='') as target:
        writer = csv.writer(target)
        writer.writerow(['id', 'from', 'to', 'mode', 'status', 'enabled'])
        for e in edges + proposals:
            writer.writerow([e['id'], e['from'], e['to'], e['mode'], e['status'], e['enabled']])
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == '__main__':
    main()
