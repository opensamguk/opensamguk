"""Cut the Natural Earth inputs of the SAN10 pixel basemap (INT-20) to the SAN10 canvas.

Run: python3 tools/map-data/build-san10-relief.py
Downloads into the same hash-pinned cache as build-natural-earth.py. Writes the relief crop and the projected
lakes and rivers under resources/map-drafts/san10/ so build-pixel-basemap.py --map san10 runs offline.
"""
import hashlib
import json
import shutil
import zipfile
import zlib
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path.home() / '.cache/opensamguk/natural-earth-v5.1.2'
OUT = ROOT / 'resources/map-drafts/san10'
LAYOUT = json.loads((OUT / 'adopted-placement.json').read_text(encoding='utf-8'))
BOUNDS = LAYOUT['coordinateSystem']['bounds']
UNITS = LAYOUT['coordinateSystem']['unitsPerDegree']
CANVAS = (1400, 1000)
MAJOR_RIVERS = {'Yangtze', 'Yellow', 'Huang'}
RASTER = ('https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC_SR_W_DR.zip',
          '73eb7a00b182c702e69892332cbd380edc7aa00ccaf68ae0111deefb87303a0e')
VECTORS = {
    'ne_10m_rivers_lake_centerlines': 'bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a',
    'ne_10m_lakes': '2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9',
}


def fetch(url, path, sha256):
    CACHE.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with urlopen(Request(url, headers={'User-Agent': 'OpenSamguk-map/1.0'}), timeout=120) as response, \
                path.open('wb') as target:
            while block := response.read(4 * 1024 * 1024):
                target.write(block)
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(4 * 1024 * 1024):
            digest.update(block)
    if digest.hexdigest() != sha256:
        raise ValueError(f'Source hash mismatch: {path.name}')


def crc32(path):
    value = 0
    with path.open('rb') as source:
        while block := source.read(4 * 1024 * 1024):
            value = zlib.crc32(block, value)
    return value


def project(lon, lat):
    return round((lon - BOUNDS[0]) * UNITS, 2), round((BOUNDS[3] - lat) * UNITS, 2)


def inside(lon, lat):
    return BOUNDS[0] <= lon <= BOUNDS[2] and BOUNDS[1] <= lat <= BOUNDS[3]


def lines(geometry):
    parts = geometry['coordinates'] if geometry['type'] == 'MultiLineString' else [geometry['coordinates']]
    for part in parts:
        run = []
        for lon, lat, *_ in part:
            if inside(lon, lat):
                run.append(project(lon, lat))
            elif run:
                yield run
                run = []
        if len(run) > 1:
            yield run


def polygons(geometry):
    return geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]


def main():
    url, raster_hash = RASTER
    archive = CACHE / 'NE2_LR_LC_SR_W_DR.zip'
    fetch(url, archive, raster_hash)
    tif = CACHE / 'NE2_LR_LC_SR_W_DR.tif'
    with zipfile.ZipFile(archive) as z:
        world = [float(v) for v in z.read('NE2_LR_LC_SR_W_DR.tfw').decode().split()]
        # 캐시 TIFF는 해시를 검증한 zip 안의 파일과 크기·CRC가 같을 때만 쓰고, 아니면 다시 푼다.
        member = z.getinfo('NE2_LR_LC_SR_W_DR.tif')
        if not tif.exists() or tif.stat().st_size != member.file_size or crc32(tif) != member.CRC:
            with z.open(member) as src, tif.open('wb') as dst:
                shutil.copyfileobj(src, dst)
        if crc32(tif) != member.CRC:
            raise ValueError('Extracted relief does not match the verified archive')
    Image.MAX_IMAGE_PIXELS = 300_000_000
    pixel, _, _, vertical, center_x, center_y = world
    left, top = center_x - pixel / 2, center_y - vertical / 2
    box = ((BOUNDS[0] - left) / pixel, (BOUNDS[3] - top) / vertical,
           (BOUNDS[2] - left) / pixel, (BOUNDS[1] - top) / vertical)
    size = (CANVAS[0] * 2, CANVAS[1] * 2)  # 2 relief pixels per map unit, as for the 1000x700 relief
    relief = Image.open(tif).convert('RGB').transform(size, Image.Transform.EXTENT, box, Image.Resampling.BICUBIC)
    relief.save(OUT / 'natural-earth-relief.webp', quality=88, method=6)

    sources = [{'url': url, 'sha256': raster_hash}]
    lakes, rivers = [], []
    for name, sha256 in VECTORS.items():
        url = f'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/{name}.geojson'
        path = CACHE / f'{name}.geojson'
        fetch(url, path, sha256)
        sources.append({'url': url, 'sha256': sha256})
        for feature in json.loads(path.read_bytes())['features']:
            geometry = feature['geometry']
            if geometry is None:
                continue
            if name == 'ne_10m_lakes':
                for polygon in polygons(geometry):
                    if not any(inside(lon, lat) for lon, lat, *_ in polygon[0]):
                        continue
                    lakes.append(''.join('M' + 'L'.join('%s,%s' % project(lon, lat) for lon, lat, *_ in ring) + 'Z'
                                         for ring in polygon))
            elif feature['properties'].get('featurecla') in ('River', 'Lake Centerline'):
                rank = feature['properties']['scalerank']
                # 장강·황하는 이름으로 골라 화면과 도트 바탕에서 굵게 그린다.
                major = feature['properties'].get('name_en') in MAJOR_RIVERS
                for run in lines(geometry):
                    path_d = ''.join(f'M{a[0]},{a[1]}L{b[0]},{b[1]}' for a, b in zip(run, run[1:]))
                    rivers.append({'rank': rank, 'major': major, 'path': path_d})
    meta = {
        'note': 'Natural Earth (public domain) inputs of the SAN10 pixel basemap, cut to the SAN10 canvas.',
        'script': 'tools/map-data/build-san10-relief.py',
        'bounds': BOUNDS, 'unitsPerDegree': UNITS, 'canvas': CANVAS,
        'sources': sources, 'worldFile': world,
        'relief': {'file': 'natural-earth-relief.webp',
                   'sha256': hashlib.sha256((OUT / 'natural-earth-relief.webp').read_bytes()).hexdigest()},
        'lakes': lakes, 'rivers': rivers,
    }
    (OUT / 'pixel-sources.json').write_text(json.dumps(meta, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    print('relief', meta['relief'], 'lakes', len(lakes), 'rivers', len(rivers))


if __name__ == '__main__':
    main()
