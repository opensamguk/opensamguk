import { expect, it } from 'vitest';
import { mapTapTargets, tapCandidates } from './mapTapTargets';

const whole = { x: 0, y: 0, width: 1000, height: 700 };
const sites = [
  { key: 1, x: 0, y: 0 },
  { key: 2, x: 1000, y: 700 },
  { key: 3, x: 500, y: 300 },
  { key: 4, x: 520, y: 310 },
];

it.each([343, 358, 500])('AC-M3-08 화면폭%d에서 영역은46px 이상이고 가장자리에서도 지도 안에 남는다', (width) => {
  const before = structuredClone(sites);
  const frame = { width, height: width * 0.7 };
  const targets = mapTapTargets(sites, whole, frame);
  expect(targets).toHaveLength(4);
  for (const target of targets) {
    expect((target.width * width) / whole.width).toBeGreaterThanOrEqual(46 - 1e-9);
    expect((target.height * frame.height) / whole.height).toBeGreaterThanOrEqual(46 - 1e-9);
    expect(target.x).toBeGreaterThanOrEqual(0);
    expect(target.y).toBeGreaterThanOrEqual(0);
    expect(target.x + target.width).toBeLessThanOrEqual(1000);
    expect(target.y + target.height).toBeLessThanOrEqual(700);
  }
  expect(sites).toEqual(before);
});

it('AC-M3-08 확대·이동 뒤 화면 밖 거점을 가장자리 안으로 끌어오지 않는다', () => {
  const view = { x: 400, y: 200, width: 200, height: 140 };
  const targets = mapTapTargets(sites, view, { width: 343, height: 240.1 });
  expect(targets.map((target) => target.key)).toEqual([3, 4]);
  expect(tapCandidates(targets, { x: 500, y: 300 })).toContain(3);
  expect(tapCandidates(targets, { x: 0, y: 0 })).toEqual([]);
});

it('AC-M3-08 중첩 영역은 실제 클릭점의 모든 후보를 원래 거점에 가까운 순서로 반환한다', () => {
  const targets = mapTapTargets(sites, whole, { width: 343, height: 240.1 });
  expect(tapCandidates(targets, { x: 519, y: 310 })).toEqual([4, 3]);
  expect(tapCandidates(targets, { x: 900, y: 50 })).toEqual([]);
});

it('AC-M3-08 아직 측정하지 못했거나 잘못된 화면 크기로 선택 영역을 만들지 않는다', () => {
  expect(mapTapTargets(sites, whole, { width: 0, height: 0 })).toEqual([]);
  expect(mapTapTargets(sites, whole, { width: NaN, height: 240 })).toEqual([]);
  expect(mapTapTargets(sites, { ...whole, width: 0 }, { width: 343, height: 240 })).toEqual([]);
});
