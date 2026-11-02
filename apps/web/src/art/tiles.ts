import { publicImageUrl } from '@opensamguk/shared/public-images';
// 확대 타일 그림 (INT-20). tools/pixel-assets/build-tiles.py가 만든 파일을 이름으로 묶는다.
// import.meta.glob은 파일 경로를 번들에 남겨 공개 자산 검사에 걸리므로 하나씩 가져온다.
const deepSea = publicImageUrl('apps/web/src/art/terrain/deepSea.png');
const sea = publicImageUrl('apps/web/src/art/terrain/sea.png');
const shallow = publicImageUrl('apps/web/src/art/terrain/shallow.png');
const river = publicImageUrl('apps/web/src/art/terrain/river.png');
const plains = publicImageUrl('apps/web/src/art/terrain/plains.png');
const farmland = publicImageUrl('apps/web/src/art/terrain/farmland.png');
const grassland = publicImageUrl('apps/web/src/art/terrain/grassland.png');
const forest = publicImageUrl('apps/web/src/art/terrain/forest.png');
const loess = publicImageUrl('apps/web/src/art/terrain/loess.png');
const desert = publicImageUrl('apps/web/src/art/terrain/desert.png');
const hills = publicImageUrl('apps/web/src/art/terrain/hills.png');
const mountains = publicImageUrl('apps/web/src/art/terrain/mountains.png');
const highMountains = publicImageUrl('apps/web/src/art/terrain/highMountains.png');
const snow = publicImageUrl('apps/web/src/art/terrain/snow.png');
const coastSand = publicImageUrl('apps/web/src/art/terrain/coastSand.png');
const bank1 = publicImageUrl('apps/web/src/art/water/bank-1.png');
const bank2 = publicImageUrl('apps/web/src/art/water/bank-2.png');
const bank3 = publicImageUrl('apps/web/src/art/water/bank-3.png');
const bank4 = publicImageUrl('apps/web/src/art/water/bank-4.png');
const bank5 = publicImageUrl('apps/web/src/art/water/bank-5.png');
const bank6 = publicImageUrl('apps/web/src/art/water/bank-6.png');
const bank7 = publicImageUrl('apps/web/src/art/water/bank-7.png');
const bank8 = publicImageUrl('apps/web/src/art/water/bank-8.png');
const bank9 = publicImageUrl('apps/web/src/art/water/bank-9.png');
const bank10 = publicImageUrl('apps/web/src/art/water/bank-10.png');
const bank11 = publicImageUrl('apps/web/src/art/water/bank-11.png');
const bank12 = publicImageUrl('apps/web/src/art/water/bank-12.png');
const bank13 = publicImageUrl('apps/web/src/art/water/bank-13.png');
const bank14 = publicImageUrl('apps/web/src/art/water/bank-14.png');
const bank15 = publicImageUrl('apps/web/src/art/water/bank-15.png');
const bridge5 = publicImageUrl('apps/web/src/art/road/bridge-5.png');
const bridge10 = publicImageUrl('apps/web/src/art/road/bridge-10.png');
const road0 = publicImageUrl('apps/web/src/art/road/road-0.png');
const road1 = publicImageUrl('apps/web/src/art/road/road-1.png');
const road2 = publicImageUrl('apps/web/src/art/road/road-2.png');
const road3 = publicImageUrl('apps/web/src/art/road/road-3.png');
const road4 = publicImageUrl('apps/web/src/art/road/road-4.png');
const road5 = publicImageUrl('apps/web/src/art/road/road-5.png');
const road6 = publicImageUrl('apps/web/src/art/road/road-6.png');
const road7 = publicImageUrl('apps/web/src/art/road/road-7.png');
const road8 = publicImageUrl('apps/web/src/art/road/road-8.png');
const road9 = publicImageUrl('apps/web/src/art/road/road-9.png');
const road10 = publicImageUrl('apps/web/src/art/road/road-10.png');
const road11 = publicImageUrl('apps/web/src/art/road/road-11.png');
const road12 = publicImageUrl('apps/web/src/art/road/road-12.png');
const road13 = publicImageUrl('apps/web/src/art/road/road-13.png');
const road14 = publicImageUrl('apps/web/src/art/road/road-14.png');
const road15 = publicImageUrl('apps/web/src/art/road/road-15.png');

// 확대하면 호수는 강 타일을 함께 쓴다.
export const TERRAIN_TILES: Record<string, string> = {
  lake: river,
  deepSea,
  sea,
  shallow,
  river,
  plains,
  farmland,
  grassland,
  forest,
  loess,
  desert,
  hills,
  mountains,
  highMountains,
  snow,
  coastSand,
};
export const ROAD_TILES = [
  road0,
  road1,
  road2,
  road3,
  road4,
  road5,
  road6,
  road7,
  road8,
  road9,
  road10,
  road11,
  road12,
  road13,
  road14,
  road15,
] as const;
// 물 칸을 지나는 곧은 길(남북 5, 동서 10)의 나무다리.
export const BRIDGE_TILES: Partial<Record<number, string>> = { 5: bridge5, 10: bridge10 };
// 큰 산 그림은 2×2칸에 한 장이다.
export const TERRAIN_TILE_CELLS: Partial<Record<string, number>> = { hills: 2, mountains: 2, highMountains: 2 };
// 강·호수 칸의 땅 쪽 강둑. 번호는 땅이 있는 쪽 비트(북 1, 동 2, 남 4, 서 8)다.
export const BANK_TILES = [
  undefined,
  bank1,
  bank2,
  bank3,
  bank4,
  bank5,
  bank6,
  bank7,
  bank8,
  bank9,
  bank10,
  bank11,
  bank12,
  bank13,
  bank14,
  bank15,
] as const;
