"""Build the local editor basemap from pinned Natural Earth v5.1.2 GIS vectors.

Run: python3 tools/map-data/build-natural-earth.py
Global downloads stay in ~/.cache/opensamguk. Only the regional derivative is shipped.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path.home() / '.cache/opensamguk/natural-earth-v5.1.2'
OUT = ROOT / 'apps/web/src/mapEditor/geodata'
BOUNDS = [94, 17, 94 + 1000 * 27 / 700, 44]
SOURCES = {
    'ne_10m_land': '1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416',
    'ne_10m_rivers_lake_centerlines': 'bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a',
    'ne_10m_lakes': '2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9',
    'ne_10m_populated_places': '9b8e3de09048ef00dfc70357dbb9fa324493f214b5e0ae4daf1aa79a8d10116b',
}


def load(name):
    path = CACHE / (name + '.geojson')
    url = f'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/{name}.geojson'
    if not path.exists():
        path.write_bytes(urlopen(Request(url, headers={'User-Agent': 'OpenSamguk-map/1.0'}), timeout=120).read())
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCES[name]:
        raise ValueError('Source hash mismatch: ' + name)
    return json.loads(raw), {'url': url, 'sha256': SOURCES[name]}


def project(p):
    x = (p[0] - BOUNDS[0]) * 700 / 27
    y = (BOUNDS[3] - p[1]) * 700 / 27
    return [round(x, 3), round(y, 3)]


def clip_ring(points):
    points = points[:-1] if points[0] == points[-1] else points
    for axis, bound, sign in [(0, BOUNDS[0], 1), (0, BOUNDS[2], -1), (1, BOUNDS[1], 1), (1, BOUNDS[3], -1)]:
        result = []
        if not points:
            return []
        a = points[-1]
        for b in points:
            inside_a, inside_b = (a[axis] - bound) * sign >= 0, (b[axis] - bound) * sign >= 0
            if inside_a != inside_b:
                t = (bound - a[axis]) / (b[axis] - a[axis])
                result.append([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
            if inside_b:
                result.append(b)
            a = b
        points = result
    return points


def polygon_path(rings):
    result = ''
    for ring in rings:
        clipped = clip_ring(ring)
        if len(clipped) >= 3:
            result += 'M' + 'L'.join(','.join(map(str, project(p))) for p in clipped) + 'Z'
    return result


def line_path(points):
    result = ''
    for a, b in zip(points, points[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        lo, hi = 0., 1.
        for p, q in [(-dx, a[0]-BOUNDS[0]), (dx, BOUNDS[2]-a[0]), (-dy, a[1]-BOUNDS[1]), (dy, BOUNDS[3]-a[1])]:
            if p == 0:
                if q < 0:
                    hi = -1
                    break
            elif p < 0:
                lo = max(lo, q/p)
            else:
                hi = min(hi, q/p)
        if lo <= hi:
            p, q = project([a[0]+lo*dx, a[1]+lo*dy]), project([a[0]+hi*dx, a[1]+hi*dy])
            result += f'M{p[0]},{p[1]}L{q[0]},{q[1]}'
    return result


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    output = {'source': 'Natural Earth v5.1.2', 'license': 'Public domain', 'projection': 'WGS84 plate carree', 'bounds': BOUNDS, 'sources': [], 'land': [], 'lakes': [], 'rivers': [], 'places': []}
    for name in SOURCES:
        data, source = load(name)
        output['sources'].append(source)
        for f in data['features']:
            g, props = f['geometry'], f['properties']
            if not g:
                continue
            if name == 'ne_10m_populated_places':
                x, y = g['coordinates'][:2]
                if BOUNDS[0] <= x <= BOUNDS[2] and BOUNDS[1] <= y <= BOUNDS[3]:
                    output['places'].append({'name': props['NAME'], 'country': props['ADM0NAME'], 'longitude': x, 'latitude': y, 'xy': project([x, y])})
                continue
            if g['type'] in ['Polygon', 'MultiPolygon']:
                if props.get('featurecla') == 'Reservoir':
                    continue
                polygons = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
                for rings in polygons:
                    p = polygon_path(rings)
                    if p:
                        output['land' if name == 'ne_10m_land' else 'lakes'].append(p)
            elif g['type'] in ['LineString', 'MultiLineString']:
                if props.get('featurecla') in ['Canal', 'Aqueduct']:
                    continue
                lines = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
                for line in lines:
                    p = line_path(line)
                    if p:
                        output['rivers'].append({'name': props.get('name') or '', 'path': p, 'rank': props.get('scalerank', 8)})
    if '--with-relief' in sys.argv:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 300_000_000
        archive = CACHE / 'NE2_LR_LC_SR_W_DR.zip'
        raster_url = 'https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC_SR_W_DR.zip'
        raster_hash = '73eb7a00b182c702e69892332cbd380edc7aa00ccaf68ae0111deefb87303a0e'
        if not archive.exists():
            with urlopen(Request(raster_url, headers={'User-Agent': 'OpenSamguk-map/1.0'}), timeout=120) as response, archive.open('wb') as target:
                while block := response.read(4*1024*1024):
                    target.write(block)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != raster_hash:
            raise ValueError('Raster source hash mismatch')
        with zipfile.ZipFile(archive) as z:
            world = [float(v) for v in z.read('NE2_LR_LC_SR_W_DR.tfw').decode().split()]
            version = z.read('NE2_LR_LC_SR_W_DR.VERSION.txt').decode().strip()
            tif = CACHE / 'NE2_LR_LC_SR_W_DR.tif'
            if not tif.exists():
                import shutil
                with z.open('NE2_LR_LC_SR_W_DR.tif') as src, tif.open('wb') as dst:
                    shutil.copyfileobj(src,dst)
        pixel, _, _, vertical, center_x, center_y = world
        left, top = center_x-pixel/2, center_y-vertical/2
        box = ((BOUNDS[0]-left)/pixel,(BOUNDS[3]-top)/vertical,(BOUNDS[2]-left)/pixel,(BOUNDS[1]-top)/vertical)
        image = Image.open(tif)
        region = image.transform((2000,1400),Image.Transform.EXTENT,box,Image.Resampling.BICUBIC)
        region.save(OUT/'natural-earth-relief.webp',quality=88,method=6)
        output['relief']={'url':raster_url,'sha256':raster_hash,'archiveVersion':version,'worldFile':world,'output':'natural-earth-relief.webp'}
    target = OUT / 'natural-earth.json'
    target.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n')
    print('Built', target.relative_to(ROOT), target.stat().st_size, 'bytes', {k: len(output[k]) for k in ['land', 'lakes', 'rivers', 'places']})


if __name__ == '__main__':
    main()
