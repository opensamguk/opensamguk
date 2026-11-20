"""Build the 3D map height fields (INT-27, D-089) from AWS Terrain Tiles (terrarium PNG).

Run: python tools/map-data/build-height-field.py [--map operational|san10] [--cache DIR]
Downloads zoom-6 terrarium tiles covering the map bounds once into the cache directory
(default: <system temp>/opensamguk-terrain-tiles), then samples them on the map's terrain grid
(the same cells as the pixel basemap) and writes apps/web/src/map3d/heights/<map>.ts.

Source: Terrain Tiles on AWS (https://registry.opendata.aws/terrain-tiles/). For this region the
tiles are derived from SRTM, GMTED2010 and ETOPO1, which are US Government public domain data.
Attribution is kept in NOTICE.

Encoding: one byte per cell. 0 is sea level or below; land is round(sqrt(metres / 9000) * 255),
clamped to 1..255. The square root keeps detail in low hills while Himalayan peaks still fit.
Sea depth (bathymetry, from the same tiles) is a second byte grid at half resolution:
round(sqrt(depth / 6000) * 255), 0 on land. The 3D map colours water by it (shelf seas pale,
open ocean dark). Deterministic: the same tiles give the same output bytes.
"""
import argparse
import base64
import hashlib
import json
import math
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'apps/web/src'
ZOOM = 6
TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
MAX_METRES = 9000
SUBSAMPLES = 3
MAX_DEPTH = 6000
DEPTH_STEP = 2

MAPS = {
    'operational': {
        'bounds': json.loads((WEB / 'mapEditor/geodata/natural-earth.json').read_text(encoding='utf8'))['bounds'],
        'grid': json.loads((WEB / 'main/pixel-basemap.json').read_text(encoding='utf8'))['grid'],
    },
    'san10': {
        'bounds': json.loads((WEB / 'main/san10-basemap.json').read_text(encoding='utf8'))['bounds'],
        'grid': json.loads((WEB / 'main/san10-pixel-basemap.json').read_text(encoding='utf8'))['grid'],
    },
}


def tile_x(lon: float) -> float:
    return (lon + 180) / 360 * 2**ZOOM


def tile_y(lat: float) -> float:
    rad = math.radians(lat)
    return (1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2 * 2**ZOOM


class Tiles:
    def __init__(self, cache: Path):
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.loaded: dict[tuple[int, int], Image.Image] = {}

    def get(self, x: int, y: int) -> Image.Image:
        key = (x, y)
        if key not in self.loaded:
            path = self.cache / f'{ZOOM}-{x}-{y}.png'
            if not path.exists():
                url = TILE_URL.format(z=ZOOM, x=x, y=y)
                request = urllib.request.Request(url, headers={'User-Agent': 'opensamguk-map-data'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    path.write_bytes(response.read())
            self.loaded[key] = Image.open(path).convert('RGB')
        return self.loaded[key]

    def metres(self, lon: float, lat: float) -> float:
        fx = tile_x(lon)
        fy = tile_y(lat)
        x, y = int(fx), int(fy)
        px = min(int((fx - x) * 256), 255)
        py = min(int((fy - y) * 256), 255)
        r, g, b = self.get(x, y).getpixel((px, py))  # type: ignore[misc]
        return r * 256 + g + b / 256 - 32768


def build(name: str, cache: Path) -> dict:
    spec = MAPS[name]
    west, south, east, north = spec['bounds']
    columns, rows = spec['grid']['width'], spec['grid']['height']
    tiles = Tiles(cache)
    data = bytearray(columns * rows)
    for row in range(rows):
        for column in range(columns):
            total = 0.0
            for sy in range(SUBSAMPLES):
                for sx in range(SUBSAMPLES):
                    lon = west + (column + (sx + 0.5) / SUBSAMPLES) / columns * (east - west)
                    lat = north - (row + (sy + 0.5) / SUBSAMPLES) / rows * (north - south)
                    total += tiles.metres(lon, lat)
            metres = total / SUBSAMPLES**2
            data[row * columns + column] = (
                0 if metres <= 0 else max(1, min(255, round(math.sqrt(metres / MAX_METRES) * 255)))
            )
    depth_columns, depth_rows = math.ceil(columns / DEPTH_STEP), math.ceil(rows / DEPTH_STEP)
    depth = bytearray(depth_columns * depth_rows)
    samples = SUBSAMPLES * DEPTH_STEP
    for row in range(depth_rows):
        for column in range(depth_columns):
            total = 0.0
            for sy in range(samples):
                for sx in range(samples):
                    lon = west + (column * DEPTH_STEP + (sx + 0.5) / SUBSAMPLES) / columns * (east - west)
                    lat = north - (row * DEPTH_STEP + (sy + 0.5) / SUBSAMPLES) / rows * (north - south)
                    total += min(tiles.metres(lon, lat), 0.0)
            metres = -total / samples**2
            depth[row * depth_columns + column] = max(0, min(255, round(math.sqrt(metres / MAX_DEPTH) * 255)))
    encoded = base64.b64encode(bytes(data)).decode('ascii')
    encoded_depth = base64.b64encode(bytes(depth)).decode('ascii')
    digest = hashlib.sha256(bytes(data) + bytes(depth)).hexdigest()
    out = WEB / f'map3d/heights/{name}.ts'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        '// Generated by tools/map-data/build-height-field.py. Do not edit.\n'
        '// Source: AWS Terrain Tiles (terrarium, zoom 6) from SRTM, GMTED2010 and ETOPO1 (US Government public domain).\n'
        f'// Bounds {spec["bounds"]}, grid {columns}x{rows}, one byte per cell: 0 = sea level or below,\n'
        f'// otherwise round(sqrt(metres / {MAX_METRES}) * 255). sha256 of the height then depth bytes: {digest}\n'
        f'// Sea depth grid {depth_columns}x{depth_rows} (every {DEPTH_STEP} cells): '
        f'round(sqrt(depth / {MAX_DEPTH}) * 255), 0 on land.\n'
        f"export const columns = {columns};\nexport const rows = {rows};\nexport const maxMetres = {MAX_METRES};\n"
        f"export const depthColumns = {depth_columns};\nexport const depthRows = {depth_rows};\n"
        f"export const maxDepth = {MAX_DEPTH};\n"
        f"export const sha256 = '{digest}';\nexport const data = '{encoded}';\nexport const depth = '{encoded_depth}';\n",
        encoding='utf8',
        newline='\n',
    )
    return {'map': name, 'file': str(out.relative_to(ROOT)), 'sha256': digest, 'tiles': len(tiles.loaded)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--map', choices=sorted(MAPS), action='append')
    parser.add_argument('--cache', type=Path, default=Path(tempfile.gettempdir()) / 'opensamguk-terrain-tiles')
    args = parser.parse_args()
    for name in args.map or sorted(MAPS):
        print(json.dumps(build(name, args.cache), ensure_ascii=False))


if __name__ == '__main__':
    main()
