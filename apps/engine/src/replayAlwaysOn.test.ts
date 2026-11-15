import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { hashState } from '@opensamguk/shared/node';
import { initialReplayState, runSimulationAction, seasonOutcome, nextGameAction } from '@opensamguk/rules';
import { readArchive, replayArchive, type ReplayArchiveV3 } from './replay';
import { simulateGame } from './simulation';
import { monthlyFixture } from '../test/monthlyFixture';

it('AC-INT-28 전체 규칙과 세 입력을 포함한 12개월 아카이브 골든을 재생한다', async () => {
  const archive = JSON.parse(
    await readFile(new URL('../test/fixtures/replay-v3.json', import.meta.url), 'utf8'),
  ) as ReplayArchiveV3;
  expect(readArchive(archive)).toEqual(archive);
  expect(archive.origin.initial).not.toHaveProperty('ruleFeatures');
  expect(archive.inputs.map((input) => input.kind)).toEqual(['general.possess', 'turns.set', 'general.setPolicy']);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  const changed = structuredClone(archive);
  changed.months[11]!.stateHash = '0'.repeat(64);
  expect(() => replayArchive(changed, 12)).toThrow();
});

it('AC-INT-28 시뮬레이터도 전체 규칙의 동일한 실행·월정산 경로를 따른다', async () => {
  const initial = await monthlyFixture();
  initial.scenarioKey = 'simulation-test';
  const maxYear = initial.startYear;
  let replay = initialReplayState(initial);
  for (;;) {
    const action = nextGameAction(replay);
    replay = runSimulationAction(replay, initial.seed, initial.unitSet, false).replay;
    const settled =
      action.kind === 'monthly'
        ? {
            year: initial.startYear + Math.floor((action.tick / 10000 - 1) / 12),
            month: ((action.tick / 10000 - 1) % 12) + 1,
          }
        : undefined;
    if (seasonOutcome(replay.state, { endYear: maxYear, ...(settled ? { settled } : {}) })) break;
  }
  const result = simulateGame(initial, { maxYear, convergence: false });
  expect(result.stateHash).toBe(hashState(replay.state));
  expect(result.finalMonth).toBe(12);
  expect(simulateGame(initial, { maxYear, convergence: false }).stateHash).toBe(result.stateHash);
});
