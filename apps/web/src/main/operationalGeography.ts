// SHA-256 of the shipped Natural Earth vector bundle, verified by INT-03 data tests.
import { bounds, land, lakes, rivers } from '../mapEditor/geodata/natural-earth.json';
import san10 from './san10-basemap.json';
import { SAN10_GIS_SHA256 } from './san10-gis-hash';
import type { PublicGeography } from '@opensamguk/shared';

// 출처 URL은 NOTICE에 두고 화면에는 묶인 좌표만 보낸다.
export const operationalBasemap = { bounds, land, lakes, rivers };

export const OPERATIONAL_GIS_SHA256 = '7aebb196cd19b2edf936cc5d6ef401d5582e0cb5662f5521b9016930d84da11e';

export function basemapForOperationalMap(map: PublicGeography) {
  if (map.basemap.sha256 === OPERATIONAL_GIS_SHA256 && map.canvas.width === 1000 && map.canvas.height === 700)
    return { ...operationalBasemap, relief: true };
  if (map.basemap.sha256 === SAN10_GIS_SHA256 && map.canvas.width === 1400 && map.canvas.height === 1000)
    return { ...san10, rivers: [] as typeof rivers, relief: false };
  return null;
}
