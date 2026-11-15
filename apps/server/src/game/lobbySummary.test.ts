import { expect, it } from 'vitest';
import { effectiveWorldOptions } from '@opensamguk/rules';
import { lobbyEntry, lobbySettings } from './lobbySummary';

it('AC-M2-02 실제로 지원하는 참가 방식과 정원·상태·입장 설정을 일치시킨다', () => {
  const options = effectiveWorldOptions(null, { entry: { npcPlay: 'on' } });
  expect(lobbyEntry({ status: 'RUNNING', replayFormat: 3 }, options, 499, 2)).toEqual(['create', 'possess']);
  expect(lobbyEntry({ status: 'PREOPEN', replayFormat: 3 }, options, 499, 2)).toEqual(['possess']);
  for (const status of ['PAUSED', 'ENDED'] as const)
    expect(lobbyEntry({ status, replayFormat: 3 }, options, 0, 2)).toEqual([]);
  expect(lobbyEntry({ status: 'RUNNING', replayFormat: 3 }, options, 500, 2)).toEqual([]);
  expect(
    lobbyEntry(
      { status: 'RUNNING', replayFormat: 1 },
      effectiveWorldOptions(null, { entry: { generalCreation: 'closed', npcPlay: 'on' } }),
      0,
      2,
    ),
  ).toEqual([]);
});
it('AC-M2-02 설정 요약은 저장된 총합과 실제 옵션을 쓴다', () => {
  const rows = lobbySettings(
    ['five-stats'],
    effectiveWorldOptions(null),
    { count: 5, total: 275, min: 15, max: 90 },
    1,
  );
  expect(rows).toContainEqual({ name: '능력치', value: '5종 · 기본 총합 275' });
  expect(rows).toContainEqual({ name: '시나리오 모드', value: '가상' });
});
