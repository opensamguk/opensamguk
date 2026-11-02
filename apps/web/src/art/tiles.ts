// 확대 타일 그림 (INT-20). tools/pixel-assets/build-tiles.py가 만든 파일을 이름으로 묶는다.
// import.meta.glob은 파일 경로를 번들에 남겨 공개 자산 검사에 걸리므로 하나씩 가져온다.
import deepSea from './terrain/deepSea.png';
import sea from './terrain/sea.png';
import shallow from './terrain/shallow.png';
import river from './terrain/river.png';
import plains from './terrain/plains.png';
import farmland from './terrain/farmland.png';
import grassland from './terrain/grassland.png';
import forest from './terrain/forest.png';
import loess from './terrain/loess.png';
import desert from './terrain/desert.png';
import hills from './terrain/hills.png';
import mountains from './terrain/mountains.png';
import highMountains from './terrain/highMountains.png';
import snow from './terrain/snow.png';
import coastSand from './terrain/coastSand.png';
import bank1 from './water/bank-1.png';
import bank2 from './water/bank-2.png';
import bank3 from './water/bank-3.png';
import bank4 from './water/bank-4.png';
import bank5 from './water/bank-5.png';
import bank6 from './water/bank-6.png';
import bank7 from './water/bank-7.png';
import bank8 from './water/bank-8.png';
import bank9 from './water/bank-9.png';
import bank10 from './water/bank-10.png';
import bank11 from './water/bank-11.png';
import bank12 from './water/bank-12.png';
import bank13 from './water/bank-13.png';
import bank14 from './water/bank-14.png';
import bank15 from './water/bank-15.png';
import bridge5 from './road/bridge-5.png';
import bridge10 from './road/bridge-10.png';
import road0 from './road/road-0.png';
import road1 from './road/road-1.png';
import road2 from './road/road-2.png';
import road3 from './road/road-3.png';
import road4 from './road/road-4.png';
import road5 from './road/road-5.png';
import road6 from './road/road-6.png';
import road7 from './road/road-7.png';
import road8 from './road/road-8.png';
import road9 from './road/road-9.png';
import road10 from './road/road-10.png';
import road11 from './road/road-11.png';
import road12 from './road/road-12.png';
import road13 from './road/road-13.png';
import road14 from './road/road-14.png';
import road15 from './road/road-15.png';

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
