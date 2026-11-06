import { describe, expect, it } from 'vitest';
import { TEST_UNIT_SET } from './testUnitSet';
import { worldUnits } from './unitChoices';

// T4-86: 월드 병종표에서 화면 값을 꺼낸다. 모집 조건이 있는 병종도 선택지에서 빼지 않는다.
describe('worldUnits', () => {
  it('장수 병종·기본 병종·이름·성벽 유무를 낸다', () => {
    const units = worldUnits(TEST_UNIT_SET);
    expect(units.all.map((unit) => unit.id)).toEqual([1000, 1100, 1200, 1300]);
    // 1300은 tech 조건이 있지만 선택지에 남는다.
    expect(units.generals.map((unit) => unit.id)).toEqual([1100, 1200, 1300]);
    expect(units.defaultId).toBe(1100);
    expect(units.name(1300)).toBe('시험 기병');
    expect(units.name(4242)).toBeUndefined();
    expect(units.hasWall).toBe(true);
  });

  it('기본 병종이 장수 병종이 아니면 첫 장수 병종이고 1000이 없으면 성벽 없음이다', () => {
    const noWall = { ...TEST_UNIT_SET, crewTypes: TEST_UNIT_SET.crewTypes.filter((unit) => unit.id !== 1000) };
    expect(worldUnits({ ...noWall, defaultCrewTypeId: 1200 }).defaultId).toBe(1200);
    expect(worldUnits(noWall).hasWall).toBe(false);
    expect(worldUnits({ ...TEST_UNIT_SET, defaultCrewTypeId: 1000 }).defaultId).toBe(1100);
  });

  it('병종표가 없으면(불러오는 중·오류) 빈 목록이다', () => {
    const units = worldUnits(undefined);
    expect([units.all, units.generals, units.defaultId, units.hasWall]).toEqual([[], [], undefined, false]);
  });
});
