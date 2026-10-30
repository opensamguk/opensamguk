import type { Prisma } from '@opensamguk/db';
import {
  applyTreatyInput,
  settleTreaties,
  toWorldState,
  treatyClosures,
  parsePreset,
  presetRules,
  type TreatyWorldState,
} from '@opensamguk/rules';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFixture } from '../../test/readFixture';
import { checkTreatyRow, requireTreatyWorld, toTreatyDetail } from './treatyQueries';

const regular = {
  name: '정규',
  turnTermMinutes: 60,
  scenario: '1030',
  map: 'che',
  unitSet: 'basic',
  commands: null,
  npc: {
    fillRatio: 1,
    aggression: 1,
  },
  protection: {
    foundUntilMonths: 0,
    peaceMonths: 0,
    maxGeneralsPerNation: null,
  },
  boost: {
    smallWorld: null,
    lateJoin: null,
  },
  features: {
    advisor: false,
  },
};

type World = Prisma.WorldGetPayload<Record<string, never>>;
type Treaty = Prisma.TreatyGetPayload<Record<string, never>>;
let initial: Awaited<ReturnType<typeof readFixture>>;
beforeAll(async () => {
  initial = await readFixture();
  initial.generals[0]!.nationId = 1;
  initial.generals[0]!.officerLevel = 12;
  initial.generals[1]!.nationId = 2;
  initial.generals[1]!.officerLevel = 12;
  initial.cities[2]!.nationId = 1;
  initial.diplomacies = [{ nationA: 1, nationB: 2, state: 'WAR', untilTick: 0 }];
});

// 저장 행 검사에만 쓰는 legacy row다. opt-in factory의 증거가 아니다.
function world(patch: Partial<World> = {}): World {
  return {
    id: 'world',
    name: '저장 행 단위',
    operationalMap: null,
    campaignState: null,
    cityResourcesState: null,
    presetKey: null,
    preset: null,
    scenarioKey: 'command-test',
    mapKey: 'test',
    unitSetKey: 'basic',
    seed: 'war-contract',
    startYear: 191,
    endYear: null,
    clockMode: 'REALTIME',
    outcomeFromSequence: 0,
    turnTermMinutes: 30,
    status: 'RUNNING',
    clockTick: 1500,
    clockAnchorAt: null,
    clockRevision: 0,
    startedAt: null,
    endedAt: null,
    initialStateHash: 'unused-for-storage-check',
    statRules: {},
    unitSet: {},
    createdAt: new Date(0),
    monthlyTick: 0,
    actionSequence: 30,
    policyFromSequence: null,
    treatyFormat: null,
    replayFormat: 1,
    ruleFeatures: [],
    personnelFormat: null,
    replayOrigin: null,
    commandMeta: null,
    ...patch,
  };
}

function stored(status: Treaty['status'] = 'PROPOSED'): Treaty {
  const state: TreatyWorldState = toWorldState(initial);
  state.nations[1]!.isNpc = false;
  state.nations[2]!.isNpc = false;
  const proposed = applyTreatyInput(
    state,
    {
      generalId: 1,
      kind: 'treaty.propose',
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }] },
    },
    { tick: 1500, sequence: 10 },
  );
  if (!proposed.ok) throw new Error('제안 fixture 실패');
  const row: Treaty = {
    ...proposed.state.treaties![0]!,
    worldId: 'world',
    clauses: proposed.state.treaties![0]!.clauses as Prisma.JsonValue,
    costFrom: null,
    costTo: null,
    closedSequence: null,
  };
  if (status === 'PROPOSED') return row;
  if (status === 'EXPIRED') {
    const next = settleTreaties(proposed.state, 70000);
    const closure = treatyClosures(proposed.state, next)[0]!;
    return { ...row, status: closure.status, closedSequence: 20 };
  }
  const result = applyTreatyInput(
    proposed.state,
    {
      generalId: 2,
      kind: 'treaty.respond',
      payload: { treatyId: '10', accept: status !== 'REJECTED' },
    },
    { tick: 1501, sequence: 11 },
  );
  if (!result.ok) throw new Error('응답 fixture 실패');
  if (result.result.outcome === 'DECLINED') return { ...row, status: 'REJECTED', closedSequence: 11 };
  if (result.result.outcome !== 'ACCEPTED') throw new Error('수락 fixture 실패');
  const active: Treaty = {
    ...row,
    ...result.state.treaties![0]!,
    clauses: result.state.treaties![0]!.clauses as Prisma.JsonValue,
    costFrom: result.result.cost.from,
    costTo: result.result.cost.to,
  };
  if (status === 'ACTIVE') return active;
  const next = settleTreaties(result.state, 20000);
  return { ...active, status: treatyClosures(result.state, next)[0]!.status, closedSequence: 20 };
}

describe('T2-07 / AC-M2-06 조약 저장 행과 상세 투영 단위', () => {
  it.each(['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED'] as const)(
    '원래 status와 12칸을 검사한다 (%s)',
    (status) => {
      const row = stored(status);
      const checked = checkTreatyRow(world(), row);
      expect(checked.status).toBe(status);
      expect(checked).not.toHaveProperty('worldId');
      expect(checked.clauses).not.toBe(row.clauses);
      expect(row).toHaveProperty('worldId', 'world');
    },
  );

  it.each([null, 3])('현재 비당사국에는 상세를 주지 않는다 (%s)', (viewer) => {
    expect(toTreatyDetail(checkTreatyRow(world(), stored('ENDED')), viewer)).toBeNull();
  });

  it.each(['PROPOSED', 'ACTIVE', 'REJECTED', 'EXPIRED', 'ENDED'] as const)(
    '표시 허용 칸만 새 객체로 고른다 (%s)',
    (status) => {
      const checked = checkTreatyRow(world(), stored(status));
      const enriched = { ...checked, hidden: '비공개 표지' };
      const detail = toTreatyDetail(enriched, 2);
      expect(detail).toMatchObject({ id: '10', fromNationId: 1, toNationId: 2, incoming: true, status });
      expect(detail?.respondByTick).toBe(status === 'PROPOSED' ? 61500 : null);
      expect(detail?.cost).toEqual(status === 'ACTIVE' || status === 'ENDED' ? { from: 17, to: 9 } : null);
      expect(Object.keys(detail!).sort()).toEqual(
        [
          'id',
          'fromNationId',
          'toNationId',
          'incoming',
          'clauses',
          'status',
          'proposedTick',
          'respondByTick',
          'startTick',
          'endTick',
          'cost',
        ].sort(),
      );
      expect(detail?.clauses).not.toBe(checked.clauses);
      expect(toTreatyDetail(checked, 1)?.incoming).toBe(false);
    },
  );

  it.each([
    { worldId: 'other' },
    { id: 31 },
    { closedSequence: 31 },
    { costFrom: null },
    { costTo: -1 },
    { respondByTick: 61501 },
    { startTick: 1499 },
    { endTick: 11502 },
  ])('저장 파손은 고정 내부 오류로 감춘다 (%j)', (patch) => {
    expect(() => checkTreatyRow(world(), { ...stored('ENDED'), ...patch })).toThrow(
      '저장된 조약을 확인하지 못했습니다.',
    );
    try {
      checkTreatyRow(world(), { ...stored('ENDED'), ...patch });
    } catch (error) {
      expect(error).toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
    }
  });

  it('worldId 외의 저장 칸을 조용히 버리지 않는다', () => {
    const row = { ...stored(), hidden: '비공개 표지' };
    expect(() => checkTreatyRow(world(), row)).toThrow('저장된 조약을 확인하지 못했습니다.');
  });

  it('다른 마감 검사에 가리지 않고 월드보다 앞선 저장 id를 거부한다', () => {
    const row = stored('PROPOSED');
    expect(() => checkTreatyRow(world({ actionSequence: row.id - 1 }), row)).toThrow(
      '저장된 조약을 확인하지 못했습니다.',
    );
  });

  it.each([-1, NaN, 2147483648])('파손된 월드 sequence로 행을 통과시키지 않는다 (%s)', (actionSequence) => {
    expect(() => checkTreatyRow(world({ actionSequence }), stored())).toThrow();
  });

  it('legacy를 opt-in으로 만들지 않고 저장 표시 불일치를 내부 오류로 낸다', () => {
    expect(() => requireTreatyWorld(world())).toThrow('조약 기능을 쓰지 않는 월드입니다.');
    expect(() => requireTreatyWorld(world({ treatyFormat: 1 }))).toThrow('저장된 조약을 확인하지 못했습니다.');
  });

  it('T4-17 B ext 단독은 조약 단독과 달리 같은 PRECONDITION_FAILED로 거부한다', () => {
    const commands = { general: ['fire_attack'], nation: [] };
    const preset = parsePreset({ ...regular, commands });
    const common = {
      version: 6,
      initial: { ...initial, presetRules: presetRules(preset) },
      initialStateHash: 'unit',
      resourceHash: 'unit',
    };
    expect(() =>
      requireTreatyWorld(
        world({
          treatyFormat: 1,
          replayOrigin: {
            ...common,
            capabilities: { version: 1, treaty: { version: 1 } },
          } as unknown as Prisma.JsonObject,
        }),
      ),
    ).not.toThrow();
    const stored = world({
      policyFromSequence: 0,
      replayOrigin: {
        ...common,
        capabilities: { version: 1, ext: { version: 1, commands, preset, resources: {}, sliceKeys: [] } },
      } as unknown as Prisma.JsonObject,
    });
    expect(() => requireTreatyWorld(stored)).toThrow(
      expect.objectContaining({
        code: 'PRECONDITION_FAILED',
        message: '조약 기능을 쓰지 않는 월드입니다.',
      }),
    );
  });
});
