import { expect, it } from 'vitest';
import { levelName, markerArt, markerBox, markerDetail, markerGates, markerUnits, passAxis } from './siteMarkers';

it('AC-INT-20 규모마다 지도 위 크기가 다르고 경이 가장 크다', () => {
  const units = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => markerUnits('CITY', level));
  expect(units).toEqual([5, 6, 4, 6, 6, 7, 8, 9, 11, 13]);
  expect(markerUnits('CITY', undefined)).toBe(7);
  expect(markerUnits('CITY', 12)).toBe(7);
  expect(markerUnits('PASS')).toBe(6);
  // 진영은 확실히 작게 둔다.
  expect(markerUnits('FIELD')).toBeLessThan(markerUnits('CITY', 1));
  expect(levelName(9)).toBe('경');
  expect(levelName(0)).toBe('무');
  expect(levelName(-1)).toBeUndefined();
});

it('AC-INT-20 화면 크기 16px 미만은 네모, 48px까지 32px 그림, 그 위는 128px 그림이다', () => {
  expect(markerDetail(8, 1.9)).toBe('square');
  expect(markerDetail(8, 2)).toBe('small');
  expect(markerDetail(16, 3)).toBe('small');
  expect(markerDetail(16, 3.01)).toBe('large');
  expect(markerDetail(20, Number.NaN)).toBe('square');
});

it('AC-INT-20 규모·시설·폐허·관문 방향에 맞는 그림을 고른다', () => {
  expect(markerArt('CITY', 0).name).toBe('level-0');
  expect(markerArt('CITY', 1).name).toBe('port');
  expect(markerArt('CITY', 2).name).toBe('field');
  expect(markerArt('CITY', 3, { axis: 'ew' }).name).toBe('pass-wall-ew');
  expect(markerArt('CITY', 4).name).toBe('level-4');
  expect(markerArt('CITY', 9).name).toBe('level-9');
  expect(markerArt('CITY', undefined).name).toBe('level-5');
  expect(markerArt('CITY', 8, { ruined: true }).name).toBe('ruin');
  expect(markerArt('PASS', undefined).name).toBe('pass-wall');
  expect(markerArt('PASS', undefined, { axis: 'ew' }).name).toBe('pass-wall-ew');
  expect(markerArt('PORT').name).toBe('port');
  for (const level of [0, 4, 5, 6, 7, 8, 9]) {
    const chosen = markerArt('CITY', level);
    expect(chosen.small).not.toBe(chosen.large);
  }
});

it('AC-INT-20 관문은 도로가 남북으로 지나면 남북판, 동서로 지나면 동서판이다', () => {
  const at = { x: 100, y: 100 };
  expect(
    passAxis(at, [
      { x: 102, y: 60 },
      { x: 98, y: 150 },
    ]),
  ).toBe('ns');
  expect(
    passAxis(at, [
      { x: 40, y: 104 },
      { x: 160, y: 95 },
    ]),
  ).toBe('ew');
  expect(passAxis(at, [])).toBe('ns');
  expect(passAxis(at, [at])).toBe('ns');
});

it('D-052 관은 길 방향에 따라 가로·세로 긴 성벽이고 길 방향 두 문만 쓴다', () => {
  expect(markerBox('PASS', undefined, 'ns')).toEqual({ width: 12, height: 3 });
  expect(markerBox('PASS', undefined, 'ew')).toEqual({ width: 3, height: 12 });
  expect(markerBox('CITY', 7)).toEqual({ width: 9, height: 9 });
  expect(markerGates('PASS', undefined, 'ns')).toEqual(['N', 'S']);
  expect(markerGates('PASS', undefined, 'ew')).toEqual(['E', 'W']);
});

it('D-052 도시 그림에 실제로 있는 문만 길에 쓴다', () => {
  expect([1, 2, 5].map((level) => markerGates('CITY', level))).toEqual([['S'], ['S'], ['S']]);
  expect(markerGates('CITY', 6)).toEqual(['N', 'S']);
  expect([7, 8, 9].map((level) => markerGates('CITY', level))).toEqual(Array(3).fill(['N', 'E', 'S', 'W']));
  // 담이 없는 무·이는 어느 쪽이든 된다.
  expect([0, 4].map((level) => markerGates('CITY', level))).toEqual([undefined, undefined]);
});
