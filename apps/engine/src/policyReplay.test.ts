import { expect, it } from 'vitest';
import {
  buildYearbook,
  enableReplayPolicy,
  initialReplayState,
  monthlyDate,
  nextGameAction,
  runReplayAction,
  type RecordedInput,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { replayArchive, resourceHash, type ReplayArchiveV5 } from './replay';

async function npcTransitionArchive() {
  const initial = await monthlyFixture();
  let replay = initialReplayState(initial);
  let sequence = 0;
  const months: ReplayArchiveV5['months'] = [];
  const step = () => {
    const action = nextGameAction(replay);
    replay = runReplayAction(replay, initial.seed, initial.unitSet);
    sequence++;
    if (action.kind === 'monthly') {
      const date = monthlyDate(initial.startYear, action.tick);
      months.push({
        tick: action.tick,
        ...date,
        sequence,
        stateHash: hashState(replay),
        data: buildYearbook(replay.state, date.year),
      });
    }
  };
  while (replay.monthlyTick < 60000) step();
  const firstSix = structuredClone(months);
  const fromSequence = ++sequence;
  const marker: RecordedInput = {
    sequence,
    generalId: null,
    kind: 'system.policy.enable',
    status: 'APPLIED',
    payload: { version: 5, emptySlots: [3] },
    result: { fromSequence, emptySlots: [3], clockTick: 60000, turnTermMinutes: 30, baselineActiveTick: 0 },
  };
  // NPC 전용 순수 기록이므로 기존 인간 장수의 미정 기준을 선택하거나 DB에 적용하지 않는다.
  expect(initial.generals.every((general) => general.userId === null)).toBe(true);
  replay = enableReplayPolicy(replay, 30, 0, [3]);
  const rejected: RecordedInput = {
    sequence: ++sequence,
    generalId: 1,
    kind: 'general.setPolicy',
    status: 'REJECTED',
    payload: { policy: 'farm' },
    result: { code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' },
  };
  while (replay.monthlyTick < 120000) step();
  const archive: ReplayArchiveV5 = {
    version: 5,
    origin: { version: 1, initial, initialStateHash: hashState(initial), resourceHash: resourceHash(initial) },
    config: {
      endYear: null,
      outcomeFromSequence: 2_147_483_647,
      policy: { version: 1, fromSequence, turnTermMinutes: 30 },
    },
    inputs: [marker, rejected],
    months,
    end: null,
    afterEnd: [],
  };
  return { archive, firstSix };
}

it('archive5는 NPC의 중간 전환 전 여섯 달 해시와 전환 뒤 여섯 달을 함께 재생한다', async () => {
  const { archive, firstSix } = await npcTransitionArchive();
  const result = replayArchive(archive, 12);
  expect(result).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(result.slice(0, 6)).toEqual(firstSix.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(replayArchive({ ...archive, inputs: [], months: firstSix }, 6)).toEqual(result.slice(0, 6));
});

it('표지 수·정확한 untouched 집합·미지원 거절 kind·추가 config를 엄격히 검사한다', async () => {
  const { archive } = await npcTransitionArchive();
  expect(() => replayArchive({ ...archive, inputs: archive.inputs.slice(1) })).toThrow();
  const forged = structuredClone(archive);
  forged.inputs[0]!.payload = { version: 5, emptySlots: [2] };
  forged.inputs[0]!.result = { ...(forged.inputs[0]!.result as object), emptySlots: [2] };
  expect(() => replayArchive(forged)).toThrow('칸 집합');
  const unknown = structuredClone(archive);
  unknown.inputs[1]!.kind = '모르는 거절 종류';
  expect(() => replayArchive(unknown)).toThrow();
  expect(() => replayArchive({ ...archive, config: { ...archive.config, unexpected: true } })).toThrow();
});
