import { expect, it } from 'vitest';
import { commandInitial, commandWorld } from '../../test/commandFixture';
import { initialReplayState, applyRecordedInput, type RecordedInput } from '../replay';
import { applyPossessionInput, availableNpc, decidePossession, validatePossessionRecord } from './possess';
import { classifyRole, recommendNations } from './roles';

const userId = '10000000-0000-4000-8000-000000000001';
const context = {
  tick: 10,
  status: 'PREOPEN' as const,
  npcPlay: true,
  userActive: true,
  sanctioned: false,
  replayFormat: 3,
};
function record(generalId = 1, policy = false, personnel = false) {
  const initial = commandInitial();
  if (policy || personnel) initial.ruleFeatures = [...(personnel ? ['personnel'] : []), ...(policy ? ['policy'] : [])];
  const replay = initialReplayState(initial, policy ? { policy: { version: 1, turnTermMinutes: 60 } } : undefined);
  const payload = { generalId, userId };
  const outcome = decidePossession(replay, payload, context);
  if (outcome.status !== 'APPLIED') throw Error('맡기 fixture가 필요합니다.');
  const input: RecordedInput = {
    sequence: 1,
    tick: context.tick,
    generalId,
    kind: 'general.possess',
    status: 'APPLIED',
    payload,
    result: outcome.result,
  };
  return { replay, input };
}

it.each([false, true])(
  'AC-M3-14 군주 맡기는 제어와 revision·활동만 바꾸고 기존 수치·30칸을 보존한다: policy=%s',
  (policy) => {
    const { replay, input } = record(1, policy);
    const before = structuredClone(replay);
    const next = applyPossessionInput(replay, input);
    expect(next.state.generals[1]).toEqual({ ...before.state.generals[1], userId });
    expect(next.state.nations[1]).toEqual({ ...before.state.nations[1], isNpc: false });
    expect(next.turns).toEqual(before.turns);
    expect(next.revisions).toEqual({ ...before.revisions, 1: 1 });
    expect(replay).toEqual(before);
    if (policy) {
      expect(next.policy!.policies).toEqual(before.policy!.policies);
      expect(next.policy!.lastActiveTicks).toEqual({ 1: context.tick });
    } else expect(next.policy).toBeUndefined();
  },
);

it('AC-M3-14 공용 재생 경로가 맡기 앵커를 만들고 거절의 조기 반환도 검증한다', () => {
  const { replay, input } = record(1, true, true);
  const next = applyRecordedInput(replay, input);
  expect(next.residenceAnchors).toEqual({ 1: context.tick });
  expect(next.policy!.lastActiveTicks).toEqual({ 1: context.tick });
  expect(() =>
    applyRecordedInput(replay, {
      ...input,
      status: 'REJECTED',
      generalId: null,
      result: { code: 'UNKNOWN', message: '위조' },
    }),
  ).toThrow();
});

it('AC-M3-14 부하와 재야 맡기는 국가 제어를 바꾸지 않으며 두 번째 장수와 재맡기는 거절한다', () => {
  for (const generalId of [3, 4]) {
    const { replay, input } = record(generalId);
    const next = applyPossessionInput(replay, input);
    expect(next.state.nations).toEqual(replay.state.nations);
    expect(decidePossession(next, { generalId: 1, userId }, context)).toMatchObject({
      status: 'REJECTED',
      result: { code: 'ALREADY_HAS_GENERAL' },
    });
    expect(() => applyPossessionInput(next, input)).toThrow();
  }
});

it('AC-INT-24 꺼짐·월드 상태·현재 계정·제재·저장 범위를 검사한다', () => {
  const { replay } = record();
  for (const [patch, code] of [
    [{ npcPlay: false }, 'ENTRY_CLOSED'],
    [{ status: 'PAUSED' as const }, 'NOT_ELIGIBLE'],
    [{ replayFormat: 1 }, 'NOT_ELIGIBLE'],
    [{ userActive: false }, 'ACTOR_INACTIVE'],
    [{ sanctioned: true }, 'ACTOR_SANCTIONED'],
  ] as const)
    expect(decidePossession(replay, { generalId: 1, userId }, { ...context, ...patch })).toMatchObject({
      status: 'REJECTED',
      result: { code },
    });
  replay.revisions[1] = 2_147_483_647;
  expect(decidePossession(replay, { generalId: 1, userId }, context)).toMatchObject({
    result: { code: 'NOT_ELIGIBLE' },
  });
  replay.state.generals[1]!.activeFromYear = 192;
  expect(availableNpc(replay.state, 1, context.tick)).toBe(false);
  expect(availableNpc(replay.state, 99, context.tick)).toBe(false);
});

it('AC-M3-14 적용·거절 기록의 위조와 정책 활동 필드 누락을 모두 거부한다', () => {
  const { replay, input } = record(1, true);
  for (const result of [
    { ...(input.result as object), revision: 2 },
    { ...(input.result as object), rulerNationId: 2 },
    { ...(input.result as object), activeTick: 11 },
    { generalId: 1, userId, revision: 1, rulerNationId: 1 },
  ])
    expect(() => applyPossessionInput(replay, { ...input, result })).toThrow();
  const rejected = {
    ...input,
    generalId: null,
    status: 'REJECTED' as const,
    result: { code: 'TAKEN', message: '이미 다른 사람이 맡은 장수입니다.' },
  };
  expect(applyPossessionInput(replay, rejected)).toBe(replay);
  expect(() => validatePossessionRecord({ ...rejected, result: { code: 'TAKEN', message: '다른 문구' } })).toThrow();
  expect(() => validatePossessionRecord({ ...rejected, generalId: 1 })).toThrow();
  expect(() => validatePossessionRecord({ ...input, extra: true } as RecordedInput)).toThrow();
});

it('AC-M3-14 역할은 재야·군주·직책·세 능력치 경계로 분류한다', () => {
  const general = commandInitial().generals[2]!;
  expect(classifyRole({ ...general, nationId: null, officerLevel: 12 })).toBe('free');
  expect(classifyRole({ ...general, officerLevel: 12 })).toBe('ruler');
  expect(classifyRole({ ...general, leadership: 64, strength: 64, intel: 64 })).toBe('retainer');
  expect(classifyRole({ ...general, leadership: 65, strength: 64, intel: 64 })).toBe('core');
  expect(classifyRole({ ...general, officerLevel: 2, leadership: 10, strength: 10, intel: 10 })).toBe('core');
});

it('AC-M3-14 추천은 상성의 원형 거리·도시 수·ID 순이며 상성 없음은 도시 수를 쓴다', () => {
  const world = commandWorld();
  world.generals[4]!.affinity = 149;
  world.generals[1]!.affinity = 1;
  world.generals[2]!.affinity = 100;
  expect(recommendNations(world, 4, 0).map((nation) => nation.id)).toEqual([1, 2]);
  world.generals[1]!.affinity = 100;
  expect(recommendNations(world, 4, 0).map((nation) => nation.id)).toEqual([1, 2]);
  world.generals[2]!.affinity = 999;
  expect(recommendNations(world, 4, 0).map((nation) => nation.id)).toEqual([1, 2]);
  expect(recommendNations(world, 99, 0)).toEqual([]);
});
