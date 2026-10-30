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
    ruleFeatures: [] as string[],
  };
}
describe('AC-INT-18B 월드 요약의 도시 자원 표시', () => {
  it('구판 응답 모양과 값은 그대로다', () => {
    expect(worldSummary(fixture(), 0)).toEqual({
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
    });
    const existing = fixture();
    existing.ruleFeatures = ['campaign-v1'];
    expect(Object.hasOwn(worldSummary(existing, 0), 'cityResourcesEnabled')).toBe(false);
  });
  it('새 판 표시만 조건부로 추가하고 원장이나 자원을 노출하지 않는다', () => {
    const before = fixture(),
      current = fixture();
    current.ruleFeatures = ['city-resources-v1'];
    expect(worldSummary(current, 0)).toEqual({ ...worldSummary(before, 0), cityResourcesEnabled: true });
    expect(current.ruleFeatures).toEqual(['city-resources-v1']);
  });
});
