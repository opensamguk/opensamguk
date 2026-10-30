"""Build the adopted 1400x1000 layout without changing operational worlds.

python tools/map-data/build-san10-expanded.py --land-source path/to/ne_10m_land.geojson
Natural Earth v5.1.2 land is downloaded to the local cache when not supplied.
Requires Shapely. Existing GIS coordinates translate by (0, 260); no rescaling.
"""
import argparse
import copy
import csv
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

from shapely.geometry import MultiPolygon, box, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/map-drafts/san10'
WIDTH, HEIGHT, OFFSET_Y = 1400, 1000, 260
UNITS = 700 / 27
LAND_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson'
LAND_SHA = '1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416'


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--land-source', type=Path)
    args = parser.parse_args()
    land_path = args.land_source or Path.home() / '.cache/opensamguk/natural-earth-v5.1.2/ne_10m_land.geojson'
    if not land_path.exists():
        if args.land_source:
            raise FileNotFoundError(land_path)
        land_path.parent.mkdir(parents=True, exist_ok=True)
        land_path.write_bytes(urlopen(Request(LAND_URL, headers={'User-Agent': 'OpenSamguk-map/1.0'}), timeout=60).read())
    raw = land_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != LAND_SHA:
        raise ValueError('Natural Earth land source hash mismatch')
    merged_path = OUT / 'merged-placement.json'
    original = json.loads(merged_path.read_text(encoding='utf-8'))
    adopted = copy.deepcopy(original)
    north = 44 + OFFSET_Y / UNITS
    bounds = [94, north - HEIGHT / UNITS, 94 + WIDTH / UNITS, north]
    land = unary_union([shape(f['geometry']) for f in json.loads(raw)['features']])
    clipped = land.intersection(box(*bounds)).simplify(0.012, preserve_topology=True)
    polygons = list(clipped.geoms) if clipped.geom_type == 'MultiPolygon' else [clipped]
    geometry = MultiPolygon([orient(polygon, sign=-1) for polygon in polygons])
    geojson = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {
        'source': 'Natural Earth v5.1.2', 'license': 'Public domain'}, 'geometry': mapping(geometry)}]}
    geo_path = OUT / 'adopted-basemap.geojson'
    geo_path.write_text(json.dumps(geojson, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8', newline='\n')
    adopted.update(format='opensamguk-adopted-map-layout', status='ADOPTED_LAYOUT_PENDING_RUNTIME',
                   decision='D-044', canvas={'width': WIDTH, 'height': HEIGHT},
                   adoption={'date': '2026-10-29', 'basis': '사용자가 159표식 통합안을 채택하고 일본 열도·만주까지 보이도록 지도 확대를 요청했다.',
                             'scope': '거점 구성·상대 배치·넓힌 지리 범위를 후속 구현 기준으로 채택한다.',
                             'connections': '기존 155관계와 게임용 제안 45관계의 근거 구분을 보존한다.'})
    adopted['sourceCoordinateSystem'] = original['coordinateSystem']
    adopted['coordinateSystem'] = {
        'projection': 'WGS84 plate carree', 'canvas': adopted['canvas'], 'bounds': bounds,
        'unitsPerDegree': UNITS, 'origin': {'longitude': 94, 'latitude': north},
        'formula': {'x': '(longitude - 94) * 700 / 27', 'y': f'({north} - latitude) * 700 / 27'},
        'legacyTransform': {'fromCanvas': {'width': 1000, 'height': 700}, 'dx': 0, 'dy': OFFSET_Y,
                            'scaleX': 1, 'scaleY': 1, 'preservesGeographicPositions': True},
        'legacyCanvasFrame': {'x': 0, 'y': OFFSET_Y, 'width': 1000, 'height': 700},
    }
    for site in adopted['sites']:
        before = site['position']
        site['insideLegacyCanvas'] = 0 <= before['x'] <= 1000 and 0 <= before['y'] <= 700
        site.pop('insideCurrentCanvas', None)
        site['position'] = {'x': before['x'], 'y': before['y'] + OFFSET_Y}
        site['insideCanvas'] = True
    adopted['basemap'] = {'file': geo_path.name, 'source': 'Natural Earth v5.1.2', 'license': 'Public domain',
                          'sourceUrl': LAND_URL, 'sourceSha256': LAND_SHA,
                          'sha256': hashlib.sha256(geo_path.read_bytes()).hexdigest(),
                          'bounds': bounds, 'simplifyToleranceDegrees': 0.012,
                          'ringOrientation': 'clockwise exterior for d3-geo'}
    outside = [s['id'] for s in adopted['sites'] if not (
        0 <= s['position']['x'] <= WIDTH and 0 <= s['position']['y'] <= HEIGHT)]
    if outside:
        raise ValueError(f'Sites outside expanded canvas: {outside}')
    adopted['counts']['outsideCanvas'] = 0
    adopted['counts']['translatedSites'] = len(adopted['sites'])
    adopted['inputHashes']['resources/map-drafts/san10/merged-placement.json'] = hashlib.sha256(merged_path.read_bytes()).hexdigest()
    adopted['limits'] = [
        '사용자가 채택한 지도 배치 정본이며 실행용 v3 지도 자원이나 운영 DB 반영 결과가 아니다.',
        '155개의 기존·판독 관계와 45개의 게임 연결 제안은 구분한다. 제안을 사료 판독 확정으로 바꾸지 않는다.',
        '새 25곳의 레벨·경제·소유권과 정밀한 경로 형상은 후속 구현에서 다룬다.',
        f'기존 1000×700 좌표에 y+{OFFSET_Y}만 적용했다. 지리적 위치·상대 거리·연결 끝점은 보존한다.',
        '기존 월드의 좌표를 변경하지 않았다. 새 판에 맞는 형식·엔진·API·화면 전환은 별도다.',
    ]
    write(OUT / 'adopted-placement.json', adopted)
    with (OUT / 'adopted-sites.csv').open('w', encoding='utf-8-sig', newline='') as target:
        writer = csv.writer(target)
        writer.writerow(['id', 'name', 'role', 'strategic', 'level', 'x', 'y'])
        for site in adopted['sites']:
            writer.writerow([site['id'], site['name'], site['role'], site['strategic'], site.get('level'),
                             site['position']['x'], site['position']['y']])
    print(json.dumps({'canvas': adopted['canvas'], 'bounds': bounds, 'sites': len(adopted['sites']),
                      'outsideCanvas': len(outside), 'legacyTranslation': [0, OFFSET_Y]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
