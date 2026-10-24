import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import {
  initialReplayState,
  nextGameAction,
  runGeneralTurn,
  runReplayAction,
  toWorldState,
  type WorldInit,
} from '@opensamguk/rules';
import { loadInitialWorldFromDb } from './world/resources';
import { DEFAULT_SIMULATION_MAX_YEAR, simulateGame, unifiedNation } from './simulation';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
afterAll(() => db.$disconnect());

async function smallWorld(): Promise<WorldInit> {
  const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'memory-replay' });
  initial.generals = initial.generals
    .slice(0, 5)
    .map((general, i) => ({ ...general, activeFromYear: i === 4 ? initial.startYear + 1 : initial.startYear }));
  return initial;
}

describe('AC-M1-17 메모리 실행기', () => {
  it('실제 명령·월간 정산의 행동별 재생과 같은 상태·턴 수를 얻는다', async () => {
    const initial = await smallWorld();
    const before = structuredClone(initial);
    const result = simulateGame(initial, { maxYear: initial.startYear });
    let replay = initialReplayState(initial);
    let turns = 0;
    const nationCommandCounts: Record<string, number> = {};
    while (replay.monthlyTick < 120000) {
      const action = nextGameAction(replay);
      if (action.kind === 'turn') {
        turns++;
        const turn = runGeneralTurn(
          replay.state,
          { generalId: action.generalId, tick: action.tick, unitSet: initial.unitSet },
          { commandKey: 'rest', args: {} },
          initial.seed,
        );
        if (turn.nation)
          nationCommandCounts[turn.nation.commandKey] = (nationCommandCounts[turn.nation.commandKey] ?? 0) + 1;
      }
      replay = runReplayAction(replay, initial.seed, initial.unitSet);
    }
    expect(result.stateHash).toBe(hashState(replay.state));
    expect(result.turns).toBe(turns);
    expect(result).toMatchObject({ outcome: '종료연도', finalYear: initial.startYear, finalMonth: 12, winner: null });
    expect(Object.keys(result.commandCounts)).not.toEqual(['rest']);
    expect(result.nationCommandCounts).toEqual(nationCommandCounts);
    expect(simulateGame(initial, { maxYear: initial.startYear }).stateHash).toBe(result.stateHash);
    expect(initial).toEqual(before);
  });
  it('자기 도시가 아닌 중립 도시가 남으면 통일로 세지 않는다', async () => {
    const state = toWorldState(await smallWorld());
    state.nations = { 1: state.nations[1]! };
    for (const city of Object.values(state.cities)) city.nationId = 1;
    expect(unifiedNation(state)).toBe(1);
    Object.values(state.cities)[0]!.nationId = null;
    expect(unifiedNation(state)).toBeNull();
  });
  it('기본 종료연도는 300이며 사람 장수·잘못된 연도는 거부한다', async () => {
    expect(DEFAULT_SIMULATION_MAX_YEAR).toBe(300);
    const initial = await smallWorld();
    expect(() => simulateGame(initial, { maxYear: initial.startYear - 1 })).toThrow('종료 연도');
    expect(() => simulateGame(initial, { maxYear: NaN })).toThrow('종료 연도');
    initial.generals[0]!.userId = 'human';
    expect(() => simulateGame(initial)).toThrow('NPC 전용');
  });
});
