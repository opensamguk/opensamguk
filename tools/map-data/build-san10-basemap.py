"""Project the attributed adopted Natural Earth geometry into the runtime GIS bundle."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[2]
base = root / 'resources/map-drafts/san10'
layout = json.loads((base / 'adopted-placement.json').read_text(encoding='utf-8'))
raw = (base / 'adopted-basemap.geojson').read_bytes()
if hashlib.sha256(raw).hexdigest() != layout['basemap']['sha256']:
    raise ValueError('Adopted basemap hash mismatch')
units = layout['coordinateSystem']['unitsPerDegree']
west, _, _, north = layout['coordinateSystem']['bounds']
paths = []
for feature in json.loads(raw)['features']:
    for polygon in feature['geometry']['coordinates']:
        paths.append(''.join('M' + 'L'.join(f'{(lon-west)*units:.2f},{(north-lat)*units:.2f}' for lon, lat in ring) + 'Z' for ring in polygon))
result = {'bounds': layout['coordinateSystem']['bounds'], 'land': paths, 'lakes': [], 'rivers': []}
(root / 'apps/web/src/main/san10-basemap.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
