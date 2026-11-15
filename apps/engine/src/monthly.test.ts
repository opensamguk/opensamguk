import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { hashState } from '@opensamguk/shared/node';
import {
  buildYearbook,
  settleReplayMonth,
  monthlyDate,
  settleDiplomacy,
  settleIncome,
  settlePopulation,
  settleSupply,
  initialReplayState,
  runReplayAction,
  applyRecordedInput,
  emptyTurns,
} from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { replayArchive, resourceHash, type ReplayArchive } from './replay';

describe('AC-M1-12 월간 정산 규칙', () => {
  it('AC-INT-28 모든 규칙의 1개월 정산을 골든과 비교한다', async () => {
    const initial = await monthlyFixture();
    const before = initialReplayState(initial);
    const original = hashState(before);
    const replay = settleReplayMonth(before, initial.seed, 10000).replay;
    expect(hashState(before)).toBe(original);
    expect({ stateHash: hashState(replay), replay }).toEqual(
      JSON.parse(await readFile(new URL('../test/fixtures/monthly-golden.json', import.meta.url), 'utf8')),
    );
  });

  it.each([1, 7, 4, 10, 2, 12])('반기 세입 %i월, 수입은 인구 증가 전에 계산한다', async (month) => {
    const before = initialReplayState(await monthlyFixture()).state;
    const next = settleIncome(before, { year: before.startYear, month });
    expect(next.nations[1]!.gold).toBe([1, 7].includes(month) ? 120 : 100);
    expect(next.nations[1]!.rice).toBe([4, 10].includes(month) ? 240 : 200);
    expect(next.generals[1]!.gold).toBe([1, 7].includes(month) ? 1020 : 1000);
    expect(next.generals[3]!.gold).toBe(1000);
  });

  it('장수가 없는 국가는 세입 전액을 보관하고 봉급 나머지도 보존한다', async () => {
    const before = initialReplayState(await monthlyFixture()).state;
    before.generals = {};
    expect(settleIncome(before, { year: before.startYear, month: 1 }).nations[1]!.gold).toBe(140);
    before.generals = initialReplayState(await monthlyFixture()).state.generals;
    before.generals[3]!.activeFromYear = before.startYear;
    before.cities[1]!.commerce = 105;
    const next = settleIncome(before, { year: before.startYear, month: 1 });
    expect(next.nations[1]!.gold + next.generals[1]!.gold + next.generals[3]!.gold).toBe(2141);
  });

  it('인구·민심 반올림과 상하한, 높은 세율과 낮은 세율', async () => {
    const before = initialReplayState(await monthlyFixture()).state;
    expect(settlePopulation(before, 0.05).cities[1]).toMatchObject({ population: 1020, trust: 82 });
    expect(settlePopulation(before, 0.3).cities[1]!.trust).toBe(79);
    before.cities[1]!.population = 3000;
    before.cities[1]!.trust = 100;
    expect(settlePopulation(before, 0).cities[1]).toMatchObject({ population: 2000, trust: 100 });
  });

  it('수도-A-B 단절·우회·회복과 재야 도시, 수도 상실', async () => {
    const before = initialReplayState(await monthlyFixture()).state;
    expect(settleSupply(before).cities[3]!.supplied).toBe(false);
    before.cities[1]!.connections.push(3);
    before.cities[3]!.connections.push(1);
    expect(settleSupply(before).cities[3]!.supplied).toBe(true);
    before.cities[1]!.nationId = 2;
    expect(settleSupply(before).cities[3]!.supplied).toBe(false);
    before.cities[3]!.nationId = null;
    expect(settleSupply(before).cities[3]!.agriculture).toBe(200);
  });

  it('외교는 경계에서 선포를 교전으로, 불가침을 중립으로 바꾸고 전쟁은 유지한다', async () => {
    const before = initialReplayState(await monthlyFixture()).state;
    expect(settleDiplomacy(before, 9999).diplomacies[0]!.state).toBe('DECLARED');
    expect(settleDiplomacy(before, 10000).diplomacies[0]!.state).toBe('WAR');
    before.diplomacies[0]!.state = 'NON_AGGRESSION';
    expect(settleDiplomacy(before, 10000).diplomacies).toEqual([]);
    before.diplomacies[0]!.state = 'WAR';
    expect(settleDiplomacy(before, 10000).diplomacies).toEqual(before.diplomacies);
  });

  it('정산 연월과 미등장 장수의 턴 offset을 보존한다', async () => {
    expect(monthlyDate(191, 10000)).toEqual({ year: 191, month: 1 });
    expect(monthlyDate(191, 120000)).toEqual({ year: 191, month: 12 });
    expect(monthlyDate(191, 130000)).toEqual({ year: 192, month: 1 });
    for (const tick of [0, -10000, 9999]) expect(() => monthlyDate(191, tick)).toThrow();
  });
});

describe('AC-M1-13 재생 기록 검사', () => {
  it('같은 시드 12개월을 비교하고 변조·누락·순서·revision 오류를 거부한다', async () => {
    const initial = await monthlyFixture();
    let replay = initialReplayState(initial);
    const archive: ReplayArchive = {
      version: 1,
      origin: { version: 1, initial, initialStateHash: hashState(initial), resourceHash: resourceHash(initial) },
      inputs: [],
      months: [],
    };
    let sequence = 0;
    while (replay.monthlyTick < 120000) {
      replay = runReplayAction(replay, initial.seed, initial.unitSet);
      sequence++;
      if (replay.monthlyTick / 10000 > archive.months.length) {
        archive.months.push({
          tick: replay.monthlyTick,
          ...monthlyDate(initial.startYear, replay.monthlyTick),
          sequence,
          stateHash: hashState(replay),
          data: buildYearbook(replay.state, initial.startYear),
        });
      }
    }
    expect(replayArchive(archive)).toHaveLength(12);
    const bad = structuredClone(archive);
    bad.months[4]!.stateHash = 'bad';
    expect(() => replayArchive(bad)).toThrow('해시');
    expect(() => replayArchive(archive, 13)).toThrow('부족');
    const wrongSeed = structuredClone(archive);
    wrongSeed.origin.initial.seed = 'other';
    expect(() => replayArchive(wrongSeed)).toThrow('생성 기록');
    const missing = structuredClone(archive);
    missing.months.splice(1, 1);
    expect(() => replayArchive(missing, 11)).toThrow('경계');
    expect(() =>
      applyRecordedInput(replay, {
        sequence: 100,
        generalId: 1,
        kind: 'turns.set',
        status: 'APPLIED',
        payload: { revision: 0, turns: emptyTurns().map((turn) => ({ ...turn, explicit: false })) },
        result: { revision: 1, activeTick: 0 },
      }),
    ).toThrow('revision');
  });
});
