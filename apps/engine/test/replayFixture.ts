import {
  applyRecordedInput,
  buildYearbook,
  emptyTurns,
  initialReplayState,
  monthlyDate,
  nextGameAction,
  runReplayAction,
  toGameDate,
  type RecordedInput,
  type WorldInit,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { resourceHash, type ReplayArchiveV2, type ReplayEnd } from '../src/replay';
import { monthlyFixture } from './monthlyFixture';
import { warFixture } from './warFixture';

export function recordedArchive(
  initial: WorldInit,
  sequences: number,
  inputs: RecordedInput[] = [],
  reason: ReplayEnd['reason'] | null = null,
): ReplayArchiveV2 {
  const archive: ReplayArchiveV2 = {
    version: 2,
    origin: { version: 1, initial, initialStateHash: hashState(initial), resourceHash: resourceHash(initial) },
    config: { endYear: reason === 'END_YEAR' ? initial.startYear : null, outcomeFromSequence: 0 },
    inputs,
    months: [],
    end: null,
    afterEnd: [],
  };
  let replay = initialReplayState(initial);
  const bySequence = new Map(inputs.map((input) => [input.sequence, input]));
  for (let sequence = 1; sequence <= sequences; sequence++) {
    const input = bySequence.get(sequence);
    if (input) {
      replay = applyRecordedInput(replay, input);
      continue;
    }
    const action = nextGameAction(replay);
    replay = runReplayAction(replay, initial.seed, initial.unitSet);
    const date =
      action.kind === 'monthly'
        ? monthlyDate(initial.startYear, action.tick)
        : toGameDate(initial.startYear, action.tick);
    if (action.kind === 'monthly') {
      archive.months.push({
        tick: action.tick,
        ...date,
        sequence,
        stateHash: hashState(replay),
        data: buildYearbook(replay.state, date.year),
      });
    }
    if (sequence === sequences && reason) {
      if (
        reason === 'UNIFIED' &&
        (Object.keys(replay.state.nations).join(',') !== '1' ||
          Object.values(replay.state.cities).some((city) => city.nationId !== 1))
      ) {
        throw new Error('시험 턴이 마지막 도시를 점령하지 못했습니다.');
      }
      archive.end = {
        sequence,
        tick: action.tick,
        reason,
        winnerNationId: reason === 'UNIFIED' ? 1 : null,
        ...date,
        finalStateHash: hashState(replay),
      };
    }
  }
  return archive;
}

export async function endYearArchive() {
  const initial = await monthlyFixture();
  // 두 장수는 월 경계에 도착한다. 12월 정산 뒤 같은 tick의 턴은 실행하지 않는다.
  initial.generals = initial.generals.slice(0, 2).map((general) => ({ ...general, nextTurnTick: 10000 }));
  return recordedArchive(initial, 34, [], 'END_YEAR');
}

export async function unifiedArchive(afterMonth = false) {
  const initial = await warFixture();
  initial.cities = initial.cities
    .slice(0, 2)
    .map((city) => ({ ...city, connections: [city.cityKey === 1 ? 2 : 1], wall: 0, defence: 0 }));
  initial.generals = initial.generals.slice(0, 1);
  delete initial.nationTurns;
  const turns = emptyTurns();
  turns[0] = { commandKey: 'attack', args: { cityKey: 2 } };
  const input: RecordedInput = {
    sequence: afterMonth ? 3 : 1,
    generalId: 1,
    kind: 'turns.set',
    status: 'APPLIED',
    payload: { revision: afterMonth ? 1 : 0, turns },
    result: { revision: afterMonth ? 2 : 1 },
  };
  const inputs = [input];
  if (afterMonth) {
    inputs.push({
      sequence: 4,
      generalId: 99,
      kind: 'general.create',
      status: 'APPLIED',
      payload: {},
      result: {
        general: {
          ...initial.generals[0]!,
          id: 99,
          name: '재생 시험 장수',
          crew: 0,
          activeFromYear: initial.startYear + 10,
          nextTurnTick: 12000,
        },
      },
    });
  }
  return recordedArchive(initial, afterMonth ? 5 : 2, inputs, 'UNIFIED');
}

export function rejectedInput(sequence: number): RecordedInput {
  return {
    sequence,
    generalId: null,
    kind: 'general.create',
    status: 'REJECTED',
    payload: {},
    result: { reason: 'WORLD_CLOSED' },
  };
}
