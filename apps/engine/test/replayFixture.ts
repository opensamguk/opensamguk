import {
  applyRecordedInput,
  applyTreatyInput,
  buildYearbook,
  emptyQueue,
  initialReplayState,
  providedRuleData,
  monthlyDate,
  nextGameAction,
  runReplayAction,
  toGameDate,
  type RecordedInput,
  type WorldInit,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { resourceHashV3, type ReplayArchiveV3, type ReplayEnd } from '../src/replay';
import { monthlyFixture } from './monthlyFixture';

export function recordedArchive(
  initial: WorldInit,
  sequences: number,
  inputs: RecordedInput[] = [],
  reason: ReplayEnd['reason'] | null = null,
): ReplayArchiveV3 {
  const archive: ReplayArchiveV3 = {
    version: 3,
    origin: {
      version: 3,
      initial,
      initialStateHash: hashState(initial),
      resourceHash: '',
      featureData: providedRuleData(initial, 60),
    },
    config: { endYear: reason === 'END_YEAR' ? initial.startYear : null, outcomeFromSequence: 0 },
    inputs: inputs.map((input) => ({ ...input, tick: input.tick ?? (input.kind === 'turns.set' ? null : 0) })),
    months: [],
    end: null,
    afterEnd: [],
  };
  archive.origin.resourceHash = resourceHashV3(archive.origin);
  let replay = initialReplayState(initial, archive.origin.featureData);
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
  let replay = initialReplayState(initial);
  let sequences = 0;
  while (replay.monthlyTick < 120000) {
    replay = runReplayAction(replay, initial.seed, initial.unitSet);
    sequences++;
  }
  return recordedArchive(initial, sequences, [], 'END_YEAR');
}

export async function unifiedArchive(afterMonth = false) {
  const initial = await monthlyFixture();
  // 통일 판정 경계만 검사한다. 전술 전투의 점령 흐름은 war 통합 시험의 몫이다.
  initial.cities.forEach((city) => {
    city.nationId = 1;
  });
  initial.nations = initial.nations.slice(0, 1);
  initial.generals = initial.generals.slice(0, 1);
  initial.diplomacies = [];

  delete initial.nationTurns;
  const turns = emptyQueue();
  turns[0] = { commandKey: 'rest', args: {}, explicit: true };
  const input: RecordedInput = {
    sequence: afterMonth ? 3 : 1,
    generalId: 1,
    kind: 'turns.set',
    status: 'APPLIED',
    payload: { revision: afterMonth ? 1 : 0, turns },
    result: { revision: afterMonth ? 2 : 1, activeTick: afterMonth ? 10000 : 0 },
  };
  const inputs = [input];
  if (afterMonth) {
    inputs.push({ ...rejectedInput(4), tick: 10000 });
  }
  const archive = recordedArchive(initial, afterMonth ? 5 : 2, inputs, 'UNIFIED');
  if (afterMonth) archive.config.outcomeFromSequence = 4;
  return archive;
}

export function rejectedInput(sequence: number): RecordedInput & { tick: number } {
  return {
    sequence,
    tick: 0,
    generalId: null,
    kind: 'general.create',
    status: 'REJECTED',
    payload: {},
    result: { code: 'WORLD_CLOSED', message: 'World closed' },
  };
}

export async function treatyArchive() {
  const initial = await monthlyFixture();
  initial.nations.forEach((nation) => {
    nation.gold = 100000;
    nation.isNpc = false;
  });
  initial.generals[0]!.officerLevel = 12;
  initial.generals[1]!.officerLevel = 12;
  let replay = initialReplayState(initial);
  const inputs: RecordedInput[] = [];
  for (const request of [
    {
      kind: 'treaty.propose' as const,
      generalId: 1,
      payload: { toNationId: 2, clauses: [{ kind: 'peace' as const }, { kind: 'nonAggression' as const, months: 1 }] },
    },
    { kind: 'treaty.respond' as const, generalId: 2, payload: { treatyId: '1', accept: true } },
  ]) {
    const sequence = inputs.length + 1;
    const result = applyTreatyInput(replay.state, request, { tick: sequence - 1, sequence });
    if (!result.ok) throw new Error(`treaty fixture: ${result.result.code}`);
    const input = { ...request, sequence, tick: sequence - 1, status: 'APPLIED' as const, result: result.result };
    replay = applyRecordedInput(replay, input);
    inputs.push(input);
  }
  let sequence = inputs.length;
  while (replay.monthlyTick < 120000) {
    replay = runReplayAction(replay, initial.seed, initial.unitSet);
    sequence++;
  }
  return recordedArchive(initial, sequence, inputs, 'END_YEAR');
}
