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

async function transitionArchive(baselineActiveTick: number | null = null, human = false) {
  const initial = await monthlyFixture();
  if (human) initial.generals[0]!.userId = 'human';
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
    result: { fromSequence, emptySlots: [3], clockTick: 60000, turnTermMinutes: 30, baselineActiveTick },
  };
  // 이 순수 fixture의 명시 인자는 운영 기준 선택이나 실제 기존 사람 월드 전환이 아니다.
  expect(initial.generals.some((general) => general.userId !== null)).toBe(human);
  replay = enableReplayPolicy(replay, 30, baselineActiveTick, [3]);
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
  const { archive, firstSix } = await transitionArchive();
  const result = replayArchive(archive, 12);
  expect(result).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(result.slice(0, 6)).toEqual(firstSix.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(replayArchive({ ...archive, inputs: [], months: firstSix }, 6)).toEqual(result.slice(0, 6));
});

it('표지 수·정확한 untouched 집합·미지원 거절 kind·추가 config를 엄격히 검사한다', async () => {
  const { archive } = await transitionArchive();
  expect(() => replayArchive({ ...archive, inputs: archive.inputs.slice(1) })).toThrow();
  const forged = structuredClone(archive);
  forged.inputs[0]!.payload = { version: 5, emptySlots: [2] };
  forged.inputs[0]!.result = { ...(forged.inputs[0]!.result as object), emptySlots: [2] };
  expect(() => replayArchive(forged)).toThrow('칸 집합');
  const unknown = structuredClone(archive);
  unknown.inputs[1]!.kind = '모르는 거절 종류';
  expect(() => replayArchive(unknown)).toThrow();
  expect(() => replayArchive({ ...archive, config: { ...archive.config, unexpected: true } })).toThrow();
  for (const baselineActiveTick of [0, 60001]) {
    const forgedBaseline = structuredClone(archive);
    forgedBaseline.inputs[0]!.result = { ...(forgedBaseline.inputs[0]!.result as object), baselineActiveTick };
    expect(() => replayArchive(forgedBaseline)).toThrow();
  }
});

it('사람 장수의 null 활동 기준은 도우미와 F 경계 양쪽에서 거부한다', async () => {
  const initial = await monthlyFixture();
  initial.generals[0]!.userId = 'human';
  expect(() => enableReplayPolicy(initialReplayState(initial), 30, null)).toThrow('활동 기준');
  const { archive } = await transitionArchive();
  // 손상된 archive의 origin 해시도 다시 맞춰야 F의 상태 검사까지 도달한다.
  archive.origin.initial.generals[0]!.userId = 'human';
  archive.origin.initialStateHash = hashState(archive.origin.initial);
  archive.months = [];
  // 월 해시 대조 전에 F에 도달하도록 전환을 첫 입력으로 옮긴다.
  archive.config.policy.fromSequence = 1;
  const marker = archive.inputs[0]!;
  marker.sequence = 1;
  marker.payload = { version: 5, emptySlots: [1, 2, 3] };
  marker.result = {
    fromSequence: 1,
    emptySlots: [1, 2, 3],
    clockTick: 0,
    turnTermMinutes: 30,
    baselineActiveTick: null,
  };
  archive.inputs = [marker];
  archive.months.push({ ...(await transitionArchive()).archive.months[0]!, sequence: 2 });
  expect(() => replayArchive(archive, 1)).toThrow('활동 기준');
});

it('사람 fixture의 두 명시 기준은 옛 여섯 달을 보존하고 기록된 활동값으로만 재생한다', async () => {
  const zero = await transitionArchive(0, true);
  const tick = await transitionArchive(60000, true);
  expect(zero.firstSix).toEqual(tick.firstSix);
  expect(zero.archive.months.slice(6).map((month) => month.stateHash)).not.toEqual(
    tick.archive.months.slice(6).map((month) => month.stateHash),
  );
  for (const { archive } of [zero, tick])
    expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});
