import { describe, expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorld, loadPreset } from '../apps/engine/src/world/resources';

describe('T2-02 배포 프리셋 파일', () => {
  it('프리셋 없는 1030 초기 해시가 구현 전 골든과 같다', async () => {
    const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: 't2-02-legacy-baseline' });
    expect(Object.hasOwn(initial, 'presetRules')).toBe(false);
    expect(hashState(initial)).toBe('2952fcf863e11af5879fd8af160d9a729b9032ce443d838eb633d8d901189e16');
  });
  it('네 파일이 승인값으로 파싱되고 명령 opt-in은 모두 비어 있다', async () => {
    const presets = await Promise.all(['regular', 'speed', 'beginner', 'hardcore'].map((key) => loadPreset(key)));
    expect(presets.map((p) => p.name)).toEqual(['정규', '속성', '초보', '하드코어']);
    expect(presets.map((p) => p.turnTermMinutes)).toEqual([60, 10, 30, 60]);
    expect(presets.map((p) => p.npc.aggression)).toEqual([1, 1, 0.5, 1.5]);
    expect(presets.map((p) => p.npc.fillRatio)).toEqual([1, 1, 1, 1]);
    expect(presets.map((p) => p.commands)).toEqual([null, null, null, null]);
    expect(presets.map((p) => p.protection)).toEqual([
      { foundUntilMonths: 0, peaceMonths: 0, maxGeneralsPerNation: null },
      { foundUntilMonths: 0, peaceMonths: 0, maxGeneralsPerNation: null },
      { foundUntilMonths: 12, peaceMonths: 24, maxGeneralsPerNation: null },
      { foundUntilMonths: 0, peaceMonths: 0, maxGeneralsPerNation: null },
    ]);
    expect(presets.map((p) => p.features.advisor)).toEqual([false, false, true, false]);
    expect(presets.map((p) => p.boost.smallWorld)).toEqual([null, null, [{ below: 300, multiplier: 1.2 }], null]);
    expect(presets.map((p) => p.boost.lateJoin)).toEqual([
      null,
      { fromYear: 3, experienceRatio: 0.8, percentile: 0.2, goldPerYear: 0, ricePerYear: 0, maxYears: 0 },
      { fromYear: 3, experienceRatio: 0.8, percentile: 0.2, goldPerYear: 100, ricePerYear: 100, maxYears: 5 },
      null,
    ]);
  });
});
