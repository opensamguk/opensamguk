// SHA-256 of the shipped Natural Earth vector bundle, verified by INT-03 data tests.
import { bounds } from '../mapEditor/geodata/natural-earth.json';
import { bounds as san10Bounds } from './san10-basemap.json';
import { SAN10_GIS_SHA256 } from './san10-gis-hash';
import type { PublicGeography } from '@opensamguk/shared';
import pixelBasemap from './pixel-basemap.png';
import { palette } from './pixel-basemap.json';
import { palette as san10Palette } from './san10-pixel-basemap.json';
import san10PixelBasemap from './san10-pixel-basemap.png';

export const OPERATIONAL_GIS_SHA256 = '7aebb196cd19b2edf936cc5d6ef401d5582e0cb5662f5521b9016930d84da11e';

// 지도 판마다 같은 Natural Earth 원본에서 만든 도트 바탕을 쓴다 (INT-20, tools/map-data/build-pixel-basemap.py).
export function basemapForOperationalMap(map: PublicGeography) {
  if (map.basemap.sha256 === OPERATIONAL_GIS_SHA256 && map.canvas.width === 1000 && map.canvas.height === 700)
    return { bounds, pixels: pixelBasemap, palette };
  if (map.basemap.sha256 === SAN10_GIS_SHA256 && map.canvas.width === 1400 && map.canvas.height === 1000)
    return { bounds: san10Bounds, pixels: san10PixelBasemap, palette: san10Palette };
  return null;
}
