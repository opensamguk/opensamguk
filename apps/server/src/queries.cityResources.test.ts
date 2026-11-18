import { describe, expect, it } from 'vitest';
import { worldSummary } from './queries';

function fixture() {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    name: '도시 원장 판',
    status: 'PAUSED' as const,
    clockMode: 'REALTIME' as const,
    endYear: null,
    result: null,
    startYear: 191,
    clockTick: 0,
    clockAnchorAt: null,
    turnTermMinutes: 60,

    preset: null,
    runtimeOptions: null,
  };
}
describe('AC-INT-18B 월드 요약의 도시 자원 표시', () => {
  it('구판의 기존 값을 유지하고 휴전이 없음을 표시한다', () => {
    expect(worldSummary(fixture(), 0)).toEqual({
      fogOfWar: false,
      name: '도시 원장 판',
      status: 'PAUSED',
      startYear: 191,
      gameDate: { year: 191, month: 1 },
      clockMode: 'REALTIME',
      endYear: null,
      result: null,
      nowTick: 0,
      msPerTick: 360,
      turnTermMinutes: 60,
      truce: null,
    });
    const existing = fixture();
    expect(Object.hasOwn(worldSummary(existing, 0), 'cityResourcesEnabled')).toBe(false);
  });
  it('AC-INT-28 기능 선택 없이 공개 요약만 반환한다', () => {
    const before = fixture(),
      current = fixture();
    expect(worldSummary(current, 0)).toEqual(worldSummary(before, 0));
    expect(worldSummary(current, 0)).not.toHaveProperty('cityResources');
  });
});
