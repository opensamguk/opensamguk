"""Build both INT-27 height PNGs in the opensamguk-images checkout.

Set OPENSAMGUK_IMAGES_DIRECTORY to its absolute path and run:
    uv run --python 3.11 --script tools/map-data/build-heightmap.py /path/to/ETOPO_2022_v1_60s_N90W180_surface.tif

Download the original GeoTIFF from SOURCE_URL first.
"""
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["numpy==2.2.6", "pillow==11.3.0", "rasterio==1.4.4"]
# ///

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from image_repository import image_repository

SOURCE_URL = (
    'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/'
    '60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif'
)
SOURCE_SHA256 = '9d27d4b8ea8e76977e2988bca667d7c8fa68b927355feffcddd6b4875a7fd08e'
PROFILES = {'integration': 'pixel-basemap', 'san10': 'san10-pixel-basemap'}
SAMPLE_OFFSET_METERS = -32768


def sha256(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def build(source, source_hash, profile, basemap_name, output_dir):
    layout_path = ROOT / f'resources/map/{profile}.json'
    layout = json.loads(layout_path.read_bytes())
    grid = json.loads((ROOT / f'apps/web/src/main/{basemap_name}.json').read_bytes())['grid']
    width, height = grid['width'], grid['height']
    units = grid['viewBoxUnitsPerPixel']
    if (width * units, height * units) != (layout['canvas']['width'], layout['canvas']['height']):
        raise ValueError(f'{profile}: pixel grid and map canvas do not match')

    bounds = layout['basemap']['bounds']
    elevation = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=rasterio.band(source, 1),
        destination=elevation,
        dst_crs=source.crs,
        dst_transform=from_bounds(*bounds, width, height),
        dst_nodata=np.nan,
        resampling=Resampling.average,
    )
    rounded = np.rint(elevation)
    if not np.isfinite(rounded).all() or rounded.min() < -32768 or rounded.max() > 32767:
        raise ValueError(f'{profile}: missing elevations or values outside the signed 16-bit range')
    samples = (rounded - SAMPLE_OFFSET_METERS).astype(np.uint16)
    stem = 'heightmap' if profile == 'integration' else 'san10-heightmap'
    png = output_dir / f'{stem}.png'
    Image.fromarray(samples).save(png, format='PNG')
    with Image.open(png) as decoded:
        if decoded.mode != 'I;16' or not np.array_equal(samples, np.asarray(decoded)):
            raise ValueError(f'{profile}: 16-bit PNG round-trip failed')

    metadata = {
        'note': 'NOAA NCEI ETOPO 2022 v1, 60 arc-second ice surface elevation (CC0-1.0).',
        'script': 'tools/map-data/build-heightmap.py',
        'sources': [
            {'url': SOURCE_URL, 'doi': '10.25921/fd45-gt74', 'sha256': source_hash},
            {'file': layout_path.relative_to(ROOT).as_posix(), 'sha256': sha256(layout_path)},
        ],
        'bounds': bounds,
        'crs': 'EPSG:4326',
        'verticalDatum': 'EGM2008 (EPSG:3855)',
        'grid': grid,
        'resampling': 'average',
        'encoding': {
            'format': 'grayscale PNG, 16-bit unsigned',
            'order': 'north to south, west to east',
            'scaleMeters': 1,
            'offsetMeters': SAMPLE_OFFSET_METERS,
        },
        'output': {'file': f'apps/web/src/main/{png.name}', 'sha256': sha256(png)},
    }
    (output_dir / f'{stem}.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'{profile}: {width}x{height}, {rounded.min():.0f} to {rounded.max():.0f} m, {metadata["output"]["sha256"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('geotiff', type=Path, help=f'NOAA source GeoTIFF: {SOURCE_URL}')
    args = parser.parse_args()
    source_hash = sha256(args.geotiff)
    if source_hash != SOURCE_SHA256:
        parser.error('GeoTIFF SHA-256 does not match the pinned NOAA source')
    output_dir = image_repository() / 'public/main'
    output_dir.mkdir(parents=True, exist_ok=True)
    with rasterio.open(args.geotiff) as source:
        if source.crs.to_epsg() != 9518 or (source.width, source.height) != (21600, 10800) or source.count != 1:
            raise ValueError('Expected the global 60 arc-second ETOPO 2022 surface GeoTIFF')
        for profile, basemap_name in PROFILES.items():
            build(source, source_hash, profile, basemap_name, output_dir)


if __name__ == '__main__':
    main()
