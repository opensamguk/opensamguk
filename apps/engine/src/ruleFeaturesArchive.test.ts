import { describe, expect, it } from 'vitest';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../test/monthlyFixture';
import { readArchive, resourceHashV3, type ReplayArchiveV3 } from './replay';

async function archive(features: string[]): Promise<ReplayArchiveV3> {
  const initial = await monthlyFixture();
  initial.ruleFeatures = features;
  const origin: ReplayArchiveV3['origin'] = {
    version: 3,
    initial,
    initialStateHash: hashState(initial),
    resourceHash: '',
    ...(features.includes('policy') ? { featureData: { policy: { version: 1, turnTermMinutes: 60 } } } : {}),
  };
  origin.resourceHash = resourceHashV3(origin);
  return {
    version: 3,
    origin,
    config: { endYear: null, outcomeFromSequence: 0 },
    inputs: [],
    months: [],
    end: null,
    afterEnd: [],
  };
}

function finish(value: ReplayArchiveV3) {
  value.end = {
    sequence: 10,
    tick: 100,
    reason: 'UNIFIED',
    winnerNationId: 1,
    year: 191,
    month: 1,
    finalStateHash: 'checked-on-replay',
  };
  return value;
}

describe('형식 3 운영 등록표의 입력 보관 검사', () => {
  it('개인 칸 tick은 null이고 직책 칸 tick은 잠근 시계 값이다', async () => {
    const value = finish(await archive(['personnel']));
    value.inputs = [
      {
        sequence: 1,
        tick: 100,
        kind: 'nationTurns.set',
        generalId: 1,
        status: 'APPLIED',
        payload: {
          office: { nationId: 1, officerLevel: 5, tenure: 0 },
          revision: 0,
          turns: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
        },
        result: { revision: 1 },
      },
    ];
    expect(() => readArchive(value)).not.toThrow();
    value.inputs[0]!.tick = null;
    expect(() => readArchive(value)).toThrow('tick');
  });

  it('정책 활동과 조약 결과의 tick이 운반 tick과 다르면 거부한다', async () => {
    const policy = finish(await archive(['policy']));
    policy.inputs = [
      {
        sequence: 1,
        tick: 100,
        kind: 'general.active',
        generalId: 1,
        status: 'APPLIED',
        payload: {},
        result: { activeTick: 99 },
      },
    ];
    expect(() => readArchive(policy)).toThrow('활동 tick');
    const treaty = finish(await archive(['treaty', 'treaty-break']));
    treaty.inputs = [
      {
        sequence: 1,
        tick: 100,
        kind: 'treaty.break',
        generalId: 1,
        status: 'REJECTED',
        payload: { treatyId: '5' },
        result: { tick: 99, code: 'NO_PERMISSION', message: '권한 없음' },
      },
    ];
    expect(() => readArchive(treaty)).toThrow('처리 tick');
  });

  it('종료 뒤 켜진 기능은 WORLD_CLOSED만 허용하고 종료 tick을 검사한다', async () => {
    const value = finish(await archive(['treaty', 'treaty-break']));
    value.afterEnd = [
      {
        sequence: 11,
        tick: 101,
        kind: 'treaty.break',
        generalId: 1,
        status: 'REJECTED',
        payload: { treatyId: '5' },
        result: { tick: 101, code: 'WORLD_CLOSED', message: '종료됨' },
      },
    ];
    expect(() => readArchive(value)).not.toThrow();
    value.afterEnd[0]!.result = { tick: 101, code: 'NO_PERMISSION', message: '권한 없음' };
    expect(() => readArchive(value)).toThrow('종료');
    value.afterEnd[0]!.tick = 99;
    value.afterEnd[0]!.result = { tick: 99, code: 'WORLD_CLOSED', message: '종료됨' };
    expect(() => readArchive(value)).toThrow('종료');
  });

  it('조약만 켠 월드의 파기는 FEATURE_DISABLED 거절만 허용한다', async () => {
    const value = finish(await archive(['treaty']));
    value.inputs = [
      {
        sequence: 1,
        tick: 100,
        kind: 'treaty.break',
        generalId: 1,
        status: 'REJECTED',
        payload: { treatyId: '5' },
        result: { code: 'FEATURE_DISABLED', message: '꺼진 기능' },
      },
    ];
    expect(() => readArchive(value)).not.toThrow();
    value.inputs[0]!.status = 'APPLIED';
    expect(() => readArchive(value)).toThrow('켜지 않은');
    value.inputs[0]!.status = 'REJECTED';
    value.inputs[0]!.result = { tick: 100, code: 'WORLD_CLOSED', message: '종료됨' };
    expect(() => readArchive(value)).toThrow('거절 기록');
  });
});
