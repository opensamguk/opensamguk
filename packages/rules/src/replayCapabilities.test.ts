import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandInitial, testUnits } from '../test/commandFixture';
import { createCommandResolver } from './commands/resolve';
import { parsePreset, presetRules } from './world/preset';
import { applyTreatyInput, settleTreaties } from './diplomacy/treaty';
import type { TreatyClause, TreatyInput } from './diplomacy/treatyTypes';
import { cloneWorld } from './model/clone';
import { runMonthly } from './monthly';
import { emptyQueue } from './policy';
import { validatePolicyRecordedInput } from './policy/replay';
import {
  applyRecordedInput,
  initialReplayState,
  runReplayAction,
  type RecordedInput,
  type ReplayState,
} from './replay';
import {
  ARCHIVE_CAPS,
  ORIGIN_CAPS,
  CAPS_INPUT_OWNERS,
  parseCapsOrigin,
  selectSupportedCapabilities,
  capsResourceHashInput,
  startCapsReplay,
  validateCapsRecordedInput,
  applyCapsRecordedInput,
  enterCapsPolicyAtMarker,
  runCapsReplayAction,
  type CapsOrigin,
  type CapabilitySelection,
} from './replayCapabilities';

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

const selection: CapabilitySelection = { treaty: { version: 1 }, policy: null };
const config = { endYear: null, outcomeFromSequence: 0 };
const extPolicy = { version: 1 as const, fromSequence: 0 as const, turnTermMinutes: 30 };
const stratagems = ['fire_attack', 'incite', 'plunder', 'sabotage'];
function extOrigin(general = ['fire_attack']): CapsOrigin {
  const input = origin();
  const commands = { general, nation: [] };
  const preset = parsePreset({ ...regular, commands });
  input.initial.presetRules = presetRules(preset);
  input.capabilities = { version: 1, ext: { version: 1, commands, preset, resources: {}, sliceKeys: [] } };
  return input;
}
const clauses: TreatyClause[] = [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }];
function origin(): CapsOrigin {
  const initial = commandInitial();
  initial.nations.forEach((nation) => {
    nation.isNpc = false;
  });
  return {
    version: ORIGIN_CAPS,
    initial,
    initialStateHash: 'initial-hash',
    resourceHash: 'resource-hash',
    capabilities: { version: 1, treaty: { version: 1 } },
  };
}
const start = () => startCapsReplay(origin(), selection);
function rejection(overrides: Partial<RecordedInput> = {}): RecordedInput {
  return {
    sequence: 1,
    generalId: 1,
    kind: 'treaty.propose',
    status: 'REJECTED',
    payload: { toNationId: 2, clauses },
    result: { tick: 1500, code: 'NO_PERMISSION', message: '권한이 없습니다.' },
    ...overrides,
  };
}
function record(
  replay: ReplayState,
  input: TreatyInput & { generalId: number },
  tick = 1500,
  sequence = 10,
): RecordedInput {
  const result = applyTreatyInput(replay.state, input, { tick, sequence });
  if (!result.ok) throw new Error(`시험 준비 실패: ${result.result.code}`);
  return { sequence, ...input, status: 'APPLIED', result: result.result };
}
const proposal = (replay: ReplayState, tick = 1500, sequence = 10, proposedClauses = clauses) =>
  record(
    replay,
    { kind: 'treaty.propose', generalId: 1, payload: { toNationId: 2, clauses: proposedClauses } },
    tick,
    sequence,
  );
function accepted(replay = start(), chosen = selection) {
  const pending = applyCapsRecordedInput(replay, proposal(replay), { selection: chosen });
  const response = record(
    pending,
    { kind: 'treaty.respond', generalId: 2, payload: { treatyId: '10', accept: true } },
    1501,
    11,
  );
  return applyCapsRecordedInput(pending, response, { selection: chosen });
}
function marker(baselineActiveTick: number | null = null): RecordedInput {
  return {
    sequence: 20,
    generalId: null,
    kind: 'system.policy.enable',
    status: 'APPLIED',
    payload: { version: 5, emptySlots: [1, 2, 3, 4] },
    result: { fromSequence: 20, emptySlots: [1, 2, 3, 4], clockTick: 1700, turnTermMinutes: 30, baselineActiveTick },
  };
}
const futurePolicy: CapabilitySelection = {
  treaty: { version: 1 },
  policy: { version: 1, fromSequence: 20, turnTermMinutes: 30 },
};

// 기존 replay 골든 시험과 같은 정준 JSON이다. Node 전용 import를 쓰지 않는다.
async function hash(value: unknown): Promise<string> {
  function canonical(entry: unknown): string {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number' && Number.isFinite(entry)) return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    if (typeof entry === 'object' && entry !== null) {
      const object = entry as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(',')}}`;
    }
    throw new Error('JSON 값이 필요합니다.');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('T4-17 / AC-P2-03 (나) B 무상태 확장 선택과 재생', () => {
  it.each(Array.from({ length: 15 }, (_, mask) => stratagems.filter((_, bit) => (mask + 1) & (1 << bit))))(
    '정렬된 등록 계략 부분집합 %j를 F=0에서 복제한다',
    (...general) => {
      const input = extOrigin(general);
      const before = structuredClone(input);
      const chosen = selectSupportedCapabilities(input, { ...config, policy: extPolicy });
      expect(chosen).toEqual({ ext: input.capabilities.ext, policy: extPolicy });
      expect(startCapsReplay(input, chosen).state).not.toHaveProperty('ext');
      expect(input).toEqual(before);
      if (!('ext' in chosen)) throw new Error('확장 선택이 아닙니다.');
      chosen.ext.preset.name = '복제 확인';
      expect(input).toEqual(before);
    },
  );

  it.each([
    {},
    { version: 2 },
    { extra: true },
    { commands: { general: [], nation: [] } },
    { commands: { general: ['incite', 'fire_attack'], nation: [] } },
    { commands: { general: ['fire_attack', 'fire_attack'], nation: [] } },
    { commands: { general: ['rest'], nation: [] } },
    { commands: { general: ['future'], nation: [] } },
    { commands: { general: ['fire_attack'], nation: ['nation_rest'] } },
    { commands: { general: ['fire_attack'], nation: [], extra: true } },
    { resources: { extra: 1 } },
    { sliceKeys: ['future'] },
  ])('원시 ext %j는 운반·해시 입력에 남고 지원 판정에서 거부한다', async (patch) => {
    const input = extOrigin();
    input.capabilities.ext = Object.keys(patch).length ? { ...input.capabilities.ext, ...patch } : {};
    const before = structuredClone(input);
    expect(parseCapsOrigin(input)).toEqual(before);
    expect(capsResourceHashInput(input).capabilities).toEqual(before.capabilities);
    expect(await hash(capsResourceHashInput(input))).toBe(await hash(capsResourceHashInput(before)));
    expect(() => selectSupportedCapabilities(input, { ...config, policy: extPolicy })).toThrow();
    expect(input).toEqual(before);
  });

  it('완전 프리셋·명령 목록·초기 규칙과 손 selection의 원본을 대조한다', () => {
    const input = extOrigin();
    const chosen = selectSupportedCapabilities(input, { ...config, policy: extPolicy });
    const other = selectSupportedCapabilities(extOrigin(['incite']), { ...config, policy: extPolicy });
    expect(() => startCapsReplay(input, other)).toThrow('생성 기록과 기능 선택');
    expect(() => startCapsReplay(origin(), chosen)).toThrow('생성 기록과 기능 선택');
    expect(() => startCapsReplay(input, selection)).toThrow('생성 기록과 기능 선택');
    for (const change of [
      (value: CapsOrigin) => {
        delete (value.capabilities.ext!.preset as Record<string, unknown>).commands;
      },
      (value: CapsOrigin) => {
        (value.capabilities.ext!.preset as Record<string, unknown>).name = ' 정규 ';
      },
      (value: CapsOrigin) => {
        (value.capabilities.ext!.preset as Record<string, unknown>).commands = { general: ['incite'], nation: [] };
      },
      (value: CapsOrigin) => {
        value.initial.presetRules!.npc.aggression = 2;
      },
      (value: CapsOrigin) => {
        delete value.initial.presetRules;
      },
    ]) {
      const changed = structuredClone(input);
      change(changed);
      expect(() => selectSupportedCapabilities(changed, { ...config, policy: extPolicy })).toThrow();
      expect(() => startCapsReplay(changed, chosen)).toThrow();
    }
    const reordered = structuredClone(input);
    const ext = reordered.capabilities.ext!;
    ext.preset = Object.fromEntries(Object.entries(ext.preset as object).reverse());
    expect(startCapsReplay(reordered, chosen)).toEqual(startCapsReplay(input, chosen));
  });

  it('ext의 legacy·중간 전환과 조약·인사 혼합을 거부한다', () => {
    const input = extOrigin();
    for (const policy of [undefined, { ...extPolicy, fromSequence: 20 }])
      expect(() => selectSupportedCapabilities(input, { ...config, ...(policy ? { policy } : {}) })).toThrow();
    for (const extra of [{ treaty: { version: 1 } }, { personnel: { version: 1 } }])
      expect(() =>
        selectSupportedCapabilities({ ...input, capabilities: { ...input.capabilities, ...extra } } as CapsOrigin, {
          ...config,
          policy: extPolicy,
        }),
      ).toThrow('기능 조합');
  });

  it('네 진입점은 둘 다 없음·동시 존재·F 오류·미래 자기 키를 모두 거부한다', () => {
    const input = extOrigin();
    const chosen = selectSupportedCapabilities(input, { ...config, policy: extPolicy });
    const replay = startCapsReplay(input, chosen);
    for (const invalid of [
      { policy: extPolicy },
      { ...chosen, treaty: { version: 1 } },
      { ...chosen, treaty: undefined },
      { ...chosen, policy: null },
      { ...chosen, policy: undefined },
      { ...chosen, policy: { ...extPolicy, fromSequence: 20 } },
      { ...chosen, policy: { ...extPolicy, turnTermMinutes: 0 } },
      { ...chosen, personnel: undefined },
      { ...chosen, future: undefined },
      { ...chosen, ext: { ...input.capabilities.ext, resources: { future: 1 } } },
    ]) {
      const invalidSelection = invalid as unknown as CapabilitySelection;
      expect(() => startCapsReplay(input, invalidSelection)).toThrow();
      expect(() => validateCapsRecordedInput(rejection(), { selection: invalidSelection, monthlyTick: 0 })).toThrow();
      expect(() => applyCapsRecordedInput(replay, rejection(), { selection: invalidSelection })).toThrow();
      expect(() => runCapsReplayAction(replay, input.initial.seed, testUnits, invalidSelection)).toThrow();
    }
  });

  it('APPLIED 예턴만 resolver 허용 목록으로 검사하고 조약 입력은 두 상태 모두 거부한다', () => {
    const input = extOrigin();
    const chosen = selectSupportedCapabilities(input, { ...config, policy: extPolicy });
    const replay = startCapsReplay(input, chosen);
    const record = (commandKey: string): RecordedInput => ({
      sequence: 1,
      generalId: 1,
      kind: 'turns.set',
      status: 'APPLIED',
      payload: { turns: [{ commandKey, args: { cityKey: 2 }, explicit: true }, ...emptyQueue().slice(1)], revision: 0 },
      result: { revision: 1, activeTick: 0 },
    });
    for (const key of ['fire_attack', 'rest', 'farm'])
      expect(() => validateCapsRecordedInput(record(key), { selection: chosen, monthlyTick: 0 })).not.toThrow();
    for (const key of ['incite', 'future', 'nation_rest']) {
      expect(() => applyCapsRecordedInput(replay, record(key), { selection: chosen })).toThrow('예턴 명령');
      const rejected = {
        ...record(key),
        status: 'REJECTED',
        payload: null,
        result: { code: 'BAD_INPUT', message: '입력을 확인하세요.' },
      };
      expect(applyCapsRecordedInput(replay, rejected, { selection: chosen })).toBe(replay);
    }
    // 조약 단독의 기존 base 기록은 확장 허용 목록으로 다시 검사하지 않는다.
    expect(() =>
      validateCapsRecordedInput(record('future'), { selection: { ...selection, policy: extPolicy }, monthlyTick: 0 }),
    ).not.toThrow();
    for (const kind of ['treaty.propose', 'treaty.respond'])
      for (const status of ['APPLIED', 'REJECTED'] as const)
        expect(() => applyCapsRecordedInput(replay, rejection({ kind, status }), { selection: chosen })).toThrow(
          '조약을 끈 월드',
        );
  });

  it('실제 확장 resolver로 비용을 적용하고 12개월 상태·해시가 직접 재생과 같다', async () => {
    const input = extOrigin();
    input.initial.generals.forEach((general) => {
      general.userId = `human-${general.id}`;
    });
    const chosen = selectSupportedCapabilities(input, { ...config, policy: extPolicy });
    let replay = startCapsReplay(input, chosen);
    const saved: RecordedInput = {
      sequence: 1,
      generalId: 1,
      kind: 'turns.set',
      status: 'APPLIED',
      payload: {
        turns: [{ commandKey: 'fire_attack', args: { cityKey: 2 }, explicit: true }, ...emptyQueue().slice(1)],
        revision: 0,
      },
      result: { revision: 1, activeTick: 0 },
    };
    replay = applyCapsRecordedInput(replay, saved, { selection: chosen });
    let direct = structuredClone(replay);
    const resolver = createCommandResolver({ general: ['fire_attack'], nation: [] });
    const gold = replay.state.generals[1]!.gold;
    const rice = replay.state.generals[1]!.rice;
    replay = runCapsReplayAction(replay, input.initial.seed, testUnits, chosen);
    direct = runReplayAction(direct, input.initial.seed, testUnits, resolver);
    expect(replay.state.generals[1]).toMatchObject({ gold: gold - 100, rice: rice - 100 });
    expect(replay).toEqual(direct);
    const monthHashes: string[] = [];
    while (replay.monthlyTick < 120000) {
      const tick = replay.monthlyTick;
      replay = runCapsReplayAction(replay, input.initial.seed, testUnits, chosen);
      direct = runReplayAction(direct, input.initial.seed, testUnits, resolver);
      expect(replay).toEqual(direct);
      expect(replay.state).not.toHaveProperty('ext');
      expect(replay.state).not.toHaveProperty('treaties');
      if (tick !== replay.monthlyTick) {
        const actual = await hash(replay);
        expect(actual).toBe(await hash(direct));
        monthHashes.push(actual);
      }
    }
    expect(monthHashes).toHaveLength(12);
  });

  it('월간 조약 정산은 조약 갈래에서만 실행한다', () => {
    const active = accepted();
    active.state.generals = {};
    active.monthlyTick = 10000;
    const input = extOrigin();
    const chosen = selectSupportedCapabilities(input, { ...config, policy: extPolicy });
    const ext = startCapsReplay(input, chosen);
    ext.state.generals = {};
    ext.state.treaties = structuredClone(active.state.treaties!);
    ext.monthlyTick = 10000;
    expect(runCapsReplayAction(active, 'month', undefined, selection).state).not.toHaveProperty('treaties');
    expect(runCapsReplayAction(ext, 'month', undefined, chosen).state.treaties).toEqual(ext.state.treaties);
  });
});

describe('T4-03 / AC-P2-02 형식 6 운반과 실행 선택', () => {
  it('C1 정상 origin을 깊이 복제하고 실행 선택을 상태 밖에 둔다', () => {
    const input = origin();
    const parsed = parseCapsOrigin(input);
    expect(ARCHIVE_CAPS).toBe(6);
    expect(parsed).toEqual(input);
    parsed.initial.generals[0]!.name = '바뀐 이름';
    expect(input.initial.generals[0]!.name).toBe('장수1');
    expect(selectSupportedCapabilities(input, config)).toEqual(selection);
    expect(startCapsReplay(input, selection)).not.toHaveProperty('capabilities');
  });
  it.each([
    {},
    { version: 1 },
    { version: '1', treaty: { version: 1 } },
    { version: 2, treaty: { version: 1 } },
    { version: 1, treaty: { version: 2 } },
    { version: 1, treaty: { version: 1, extra: true } },
    { version: 1, treaty: { version: 1 }, extra: true },
    { version: 1, ext: null },
    { version: 1, personnel: [] },
    { version: 1, treaty: undefined },
    { version: 1, ext: undefined },
  ])('C2 잘못된 descriptor를 변환하지 않는다: %j', (capabilities) => {
    expect(() => parseCapsOrigin({ ...origin(), capabilities })).toThrow();
  });
  it.each([1, '6'])('C2 origin 판별값 %s를 거부한다', (version) => {
    expect(() => parseCapsOrigin({ ...origin(), version })).toThrow();
  });
  it('C2 origin 남는 키를 거부한다', () => {
    expect(() => parseCapsOrigin({ ...origin(), extra: true })).toThrow();
  });
  it.each([{ treaties: [] }, { treaties: [{ id: 1 }] }])(
    'C3 initial에 조약 키가 있으면 거부한다: %j',
    ({ treaties }) => {
      const input = origin();
      Object.assign(input.initial, { treaties });
      expect(() => parseCapsOrigin(input)).toThrow();
      expect(() => startCapsReplay(input, selection)).toThrow();
    },
  );
  it.each([
    { version: 1 as const, treaty: { version: 1 as const }, ext: { commands: ['future'], nested: { untouched: [1] } } },
    { version: 1 as const, personnel: { version: 1, future: [2] } },
    { version: 1 as const, ext: { commands: ['future'] } },
    { version: 1 as const, treaty: { version: 1 as const }, personnel: { version: 1 } },
    { version: 1 as const, treaty: { version: 1 as const }, personnel: {} },
    { version: 1 as const, personnel: { version: 2 } },
    { version: 1 as const, ext: {}, personnel: { version: 1 } },
    { version: 1 as const, treaty: { version: 1 as const }, ext: {}, personnel: { version: 1 } },
  ])('C4 운반과 자원 해시는 원본 descriptor를 보존하고 실행은 먼저 거부한다: %j', (capabilities) => {
    const input = { ...origin(), capabilities };
    const parsed = parseCapsOrigin(input);
    expect(parsed).toEqual(input);
    expect(capsResourceHashInput(parsed)).toEqual({
      scenarioKey: input.initial.scenarioKey,
      mapKey: input.initial.mapKey,
      unitSetKey: input.initial.unitSetKey,
      statRules: input.initial.statRules,
      unitSet: input.initial.unitSet,
      capabilities,
    });
    expect(() => selectSupportedCapabilities(parsed, config)).toThrow('기능 조합');
    // projection까지 가면 없는 generals에서 다른 오류가 난다.
    const poisoned = { ...input, initial: {} as CapsOrigin['initial'] };
    expect(() => startCapsReplay(poisoned, selection)).toThrow('기능 조합');
  });
  it.each([
    { ...selection, extra: true },
    { ...selection, treaty: { version: 2 } },
    { ...selection, policy: { version: 1, fromSequence: -1, turnTermMinutes: 30 } },
    { ...selection, personnel: { version: 1 } },
    { ...selection, ext: {} },
    { ...selection, future: 1 },
  ])('C4 손으로 만든 잘못된 선택도 projection 전에 거부한다: %j', (chosen) => {
    expect(() => startCapsReplay(origin(), chosen as CapabilitySelection)).toThrow();
    expect(() =>
      validateCapsRecordedInput(rejection(), { selection: chosen as CapabilitySelection, monthlyTick: 0 }),
    ).toThrow();
    expect(() => applyCapsRecordedInput(start(), rejection(), { selection: chosen as CapabilitySelection })).toThrow();
    expect(() => runCapsReplayAction(start(), 'seed', testUnits, chosen as CapabilitySelection)).toThrow();
  });
  it.each([
    { ...config, extra: true },
    { ...config, policy: null },
    { ...config, policy: { version: 2 } },
  ])('C5 config를 검사한다: %j', (value) => {
    expect(() => selectSupportedCapabilities(origin(), value)).toThrow();
  });
});

describe('T4-03 / AC-P2-02 형식 6 입력 소유와 strict 기록', () => {
  it('kind 소유는 공통 2·정책 3·실제 조약 2개다', () => {
    expect(Object.keys(CAPS_INPUT_OWNERS).sort()).toEqual([
      'general.active',
      'general.create',
      'general.setPolicy',
      'system.policy.enable',
      'treaty.propose',
      'treaty.respond',
      'turns.set',
    ]);
  });
  it.each(['treaty.break', 'treaty.future', 'alliance.x', 'personnel.appoint', 'toString', '__proto__'])(
    'K1 모르는 %s는 두 status 모두 거부한다',
    (kind) => {
      for (const status of ['APPLIED', 'REJECTED'] as const)
        expect(() => validateCapsRecordedInput(rejection({ kind, status }), { selection, monthlyTick: 0 })).toThrow(
          '입력 종류',
        );
    },
  );
  it('K2 정책 입력은 F와 표지 순서를 지킨다', () => {
    for (const kind of ['general.setPolicy', 'general.active']) {
      const input = rejection({
        kind,
        sequence: 19,
        payload: null,
        result: { code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' },
      });
      expect(() => validateCapsRecordedInput(input, { selection: futurePolicy, monthlyTick: 0 })).toThrow('전환 전');
      expect(() => validateCapsRecordedInput({ ...input, sequence: 21 }, { selection, monthlyTick: 0 })).toThrow(
        '전환 전',
      );
    }
    for (const input of [
      { ...marker(), sequence: 21 },
      { ...marker(), status: 'REJECTED' },
      { ...marker(), sequence: 1 },
    ])
      expect(() => validateCapsRecordedInput(input, { selection: futurePolicy, monthlyTick: 0 })).toThrow();
    expect(() =>
      validateCapsRecordedInput(marker(), {
        selection: { ...futurePolicy, policy: { ...futurePolicy.policy!, fromSequence: 0 } },
        monthlyTick: 0,
      }),
    ).toThrow();
  });
  it('K3 F 전 조약은 정책 enum에 넘기지 않고 적용하거나 건너뛴다', () => {
    const replay = startCapsReplay(origin(), futurePolicy);
    expect(applyCapsRecordedInput(replay, proposal(replay), { selection: futurePolicy }).state.treaties).toHaveLength(
      1,
    );
    expect(applyCapsRecordedInput(replay, rejection(), { selection: futurePolicy })).toBe(replay);
  });
  it('공통 입력과 정책 입력을 기존 처리기에 위임하고 전환 뒤 활동 기준을 보존한다', () => {
    const input = origin();
    input.initial.generals[0]!.userId = 'human';
    const replay = startCapsReplay(input, futurePolicy);
    const slots = structuredClone(replay.turns[1]!);
    const saved = applyCapsRecordedInput(
      replay,
      {
        sequence: 1,
        generalId: 1,
        kind: 'turns.set',
        status: 'APPLIED',
        payload: { turns: slots, revision: 0 },
        result: { revision: 1 },
      },
      { selection: futurePolicy },
    );
    expect(saved.revisions[1]).toBe(1);
    const switched = applyCapsRecordedInput(
      saved,
      {
        ...marker(1700),
        payload: { version: 5, emptySlots: [2, 3, 4] },
        result: { ...(marker(1700).result as object), emptySlots: [2, 3, 4] },
      },
      { selection: futurePolicy },
    );
    expect(switched.turns[1]![0]!.explicit).toBe(true);
    expect(switched.turns[2]![0]!.explicit).toBe(false);
    const changed = applyCapsRecordedInput(
      switched,
      {
        sequence: 21,
        generalId: 1,
        kind: 'general.setPolicy',
        status: 'APPLIED',
        payload: { policy: 'farm' },
        result: { policy: 'farm', activeTick: 1800 },
      },
      { selection: futurePolicy },
    );
    const active = applyCapsRecordedInput(
      changed,
      {
        sequence: 22,
        generalId: 1,
        kind: 'general.active',
        status: 'APPLIED',
        payload: {},
        result: { activeTick: 1701 },
      },
      { selection: futurePolicy },
    );
    expect(active.policy!.policies[1]).toBe('farm');
    expect(active.policy!.lastActiveTicks[1]).toBe(1800);
    const queue = applyCapsRecordedInput(
      active,
      {
        sequence: 23,
        generalId: 1,
        kind: 'turns.set',
        status: 'APPLIED',
        payload: { turns: emptyQueue(), revision: 1 },
        result: { revision: 2, activeTick: 1900 },
      },
      { selection: futurePolicy },
    );
    expect(queue.revisions[1]).toBe(2);
    expect(queue.policy!.lastActiveTicks[1]).toBe(1900);
    expect(
      applyCapsRecordedInput(
        queue,
        rejection({
          kind: 'general.active',
          sequence: 24,
          payload: null,
          result: { code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' },
        }),
        { selection: futurePolicy },
      ),
    ).toBe(queue);
  });
  it.each([
    { payload: null },
    { generalId: null },
    { extra: true },
    { payload: { toNationId: 2, clauses: [...clauses].reverse() } },
    { result: { tick: 1500, code: 'NOT_PARTY', message: '권한이 없습니다.' } },
    { result: { tick: 1500, code: 'BAD_INPUT', message: '' } },
  ])('S1 거절도 payload·envelope·종류별 코드를 검사한다: %j', (overrides) => {
    expect(() => validateCapsRecordedInput({ ...rejection(), ...overrides }, { selection, monthlyTick: 0 })).toThrow();
  });
  it.each([1500.5, -1, '1500', 2147483648, Number.MAX_SAFE_INTEGER + 1])(
    'S2 두 status 모두 잘못된 tick %s를 거부한다',
    (tick) => {
      const applied = proposal(start());
      for (const input of [applied, rejection()])
        expect(() =>
          validateCapsRecordedInput(
            { ...input, result: { ...(input.result as object), tick } },
            { selection, monthlyTick: 0 },
          ),
        ).toThrow();
    },
  );
  it('S2 월간 정산보다 앞선 기록은 거부한다', () => {
    expect(() => validateCapsRecordedInput(rejection(), { selection, monthlyTick: 1501 })).toThrow('이미 정산');
  });
  it.each([
    ['BAD_INPUT', []],
    ['CLAUSE_NOT_CONNECTED', [{ kind: 'passage', cityKeys: [1] }]],
    ['NO_PERMISSION', clauses],
    ['WORLD_CLOSED', clauses],
    ['ACTOR_INACTIVE', clauses],
  ])('R1 구조가 맞는 %s는 도메인을 다시 적용하지 않는다', (code, proposedClauses) => {
    const replay = start();
    const before = structuredClone(replay);
    const input = rejection({
      payload: { toNationId: 2, clauses: proposedClauses },
      result: { tick: 1500, code, message: '거절한 기록입니다.' },
    });
    expect(applyCapsRecordedInput(replay, input, { selection })).toBe(replay);
    expect(replay).toEqual(before);
  });
  it('E1 afterEnd 검사는 거절 건너뛰기보다 먼저 돈다', () => {
    const replay = start();
    const ctx = { selection, endTick: 2000 };
    const closed = rejection({ result: { tick: 2000, code: 'WORLD_CLOSED', message: '종료한 월드입니다.' } });
    expect(applyCapsRecordedInput(replay, closed, ctx)).toBe(replay);
    for (const input of [
      { ...closed, result: { tick: 1999, code: 'WORLD_CLOSED', message: '종료한 월드입니다.' } },
      { ...closed, result: { tick: 2000, code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' } },
      { ...closed, payload: null },
      proposal(replay),
    ])
      expect(() => applyCapsRecordedInput(replay, input, ctx)).toThrow();
  });
});

describe('T4-03 / AC-P2-02 형식 6 재생과 해시 보존', () => {
  it('A1 사람 제안·수락·거절과 NPC 수락·거절의 구체 결과를 재현한다', () => {
    const replay = start();
    const pending = applyCapsRecordedInput(replay, proposal(replay), { selection });
    expect(pending.state.treaties![0]).toMatchObject({
      id: 10,
      status: 'PROPOSED',
      proposedTick: 1500,
      respondByTick: 61500,
    });
    const active = accepted(replay);
    expect(active.state.treaties![0]).toMatchObject({ status: 'ACTIVE', startTick: 1501, endTick: 11501 });
    expect(active.state.nations[1]!.gold).toBe(99983);
    expect(active.state.nations[2]!.gold).toBe(99991);
    const declinedRecord = record(
      pending,
      { kind: 'treaty.respond', generalId: 2, payload: { treatyId: '10', accept: false } },
      1501,
      11,
    );
    expect(applyCapsRecordedInput(pending, declinedRecord, { selection }).state).not.toHaveProperty('treaties');
    for (const gold of [100000, 0]) {
      const npc = start();
      npc.state.nations[2]!.isNpc = true;
      npc.state.nations[2]!.gold = gold;
      const input = proposal(npc);
      expect(input.result).toMatchObject({
        outcome: gold ? 'ACCEPTED' : 'DECLINED',
        by: 'NPC',
        tick: 1500,
        treatyId: '10',
      });
      const next = applyCapsRecordedInput(npc, input, { selection });
      if (gold) expect(next.state.treaties![0]!.endTick).toBe(11500);
      else expect(next.state).toEqual(npc.state);
    }
    expect(replay.state).not.toHaveProperty('treaties');
  });
  it('A2 재계산과 다른 cost·기한·ID·주체와 저장 가능한 엔진 범위 밖 tick을 거부한다', () => {
    const replay = start();
    replay.state.nations[2]!.isNpc = true;
    const input = proposal(replay);
    for (const result of [
      { ...(input.result as object), cost: { from: 999, to: 9 } },
      { ...(input.result as object), endTick: 11501 },
      { ...(input.result as object), treatyId: '11' },
      { ...(input.result as object), by: 'HUMAN' },
    ])
      expect(() => applyCapsRecordedInput(replay, { ...input, result }, { selection })).toThrow();
    const human = start();
    const pending = proposal(human);
    expect(() =>
      applyCapsRecordedInput(
        human,
        { ...pending, result: { ...(pending.result as object), respondByTick: 61501 } },
        { selection },
      ),
    ).toThrow();
    const tooLate = {
      ...input,
      payload: { toNationId: 2, clauses: [{ kind: 'note', text: '기록' }] },
      result: {
        outcome: 'ACCEPTED',
        by: 'NPC',
        tick: 2147483647,
        treatyId: '10',
        cost: { from: 0, to: 0 },
        endTick: null,
      },
    };
    expect(() => validateCapsRecordedInput(tooLate, { selection, monthlyTick: 0 })).not.toThrow();
    expect(() => applyCapsRecordedInput(replay, tooLate, { selection })).toThrow();
  });
  it('H1 strict parse의 결과 키 순서와 -0 비교는 정준 해시와 같다', async () => {
    const replay = start();
    replay.state.nations[2]!.isNpc = true;
    const input = proposal(replay, 0, 10, [{ kind: 'peace' }]);
    const shuffled = {
      ...input,
      result: { endTick: null, cost: { to: -0, from: 0 }, treatyId: '10', tick: -0, by: 'NPC', outcome: 'ACCEPTED' },
    };
    const parsed = validateCapsRecordedInput(shuffled, { selection, monthlyTick: 0 });
    expect(JSON.stringify(parsed.result)).toBe(JSON.stringify(input.result));
    expect(await hash(parsed.result)).toBe(await hash(input.result));
    expect(await hash(applyCapsRecordedInput(replay, shuffled, { selection }))).toBe(
      await hash(applyCapsRecordedInput(replay, input, { selection })),
    );
  });
  it('P0 F=0 정책·장수 턴·월간은 조약을 깊이 보존한다', () => {
    const chosen: CapabilitySelection = { ...selection, policy: { version: 1, fromSequence: 0, turnTermMinutes: 30 } };
    const input = origin();
    input.initial.generals[0]!.userId = 'human';
    const replay = startCapsReplay(input, chosen);
    expect(replay.policy!.lastActiveTicks).toEqual({ 1: 0 });
    expect(replay.state).not.toHaveProperty('treaties');
    const active = accepted(replay, chosen);
    const turns = runCapsReplayAction(active, 'caps-turn', testUnits, chosen);
    expect(turns.state.treaties).toEqual(active.state.treaties);
    turns.state.treaties![0]!.clauses.push({ kind: 'note', text: '복제 확인' });
    expect(active.state.treaties![0]!.clauses).toHaveLength(2);
    const cloned = cloneWorld(active.state);
    cloned.treaties![0]!.clauses[0] = { kind: 'note', text: '복제 확인' };
    expect(active.state.treaties![0]!.clauses[0]).toEqual({ kind: 'peace' });
    for (const general of Object.values(active.state.generals)) general.nextTurnTick = 10000;
    const monthly = runCapsReplayAction(active, 'caps-month-policy', testUnits, chosen);
    expect(monthly.monthlyTick).toBe(10000);
    expect(monthly.state.treaties).toEqual(active.state.treaties);
    expect(monthly.state.treaties).not.toBe(active.state.treaties);
    expect(monthly.policy).toEqual(active.policy);
  });
  it('P1 F>0 표지는 기존 ACTIVE 조약과 사람 T·NPC null을 보존한다', () => {
    const replay = accepted();
    const npc = applyCapsRecordedInput(replay, marker(), { selection: futurePolicy });
    expect(npc.state.treaties).toEqual(replay.state.treaties);
    expect(npc.policy!.lastActiveTicks).toEqual({});
    expect(() => enterCapsPolicyAtMarker(replay, marker(1700), futurePolicy)).toThrow('활동 기준');
    replay.state.generals[1]!.userId = 'human';
    expect(() => enterCapsPolicyAtMarker(replay, marker(), futurePolicy)).toThrow('활동 기준');
    const human = enterCapsPolicyAtMarker(replay, marker(1700), futurePolicy);
    expect(human.policy!.lastActiveTicks).toEqual({ 1: 1700 });
    expect(human.state.treaties).toEqual(replay.state.treaties);
    expect(() => enterCapsPolicyAtMarker(human, marker(1700), futurePolicy)).toThrow('전환');
    for (const result of [
      { ...(marker(1700).result as object), fromSequence: 21 },
      { ...(marker(1700).result as object), turnTermMinutes: 31 },
      { ...(marker(1700).result as object), emptySlots: [1] },
    ])
      expect(() => enterCapsPolicyAtMarker(replay, { ...marker(1700), result }, futurePolicy)).toThrow();
  });
  it('M1 실제 월간에서 11501 만료는 20000, 61500 응답 기한은 70000에 닫힌다', async () => {
    let active = accepted();
    active.state.generals = {};
    const before = structuredClone(active);
    active = runCapsReplayAction(active, 'caps-month', undefined, selection);
    expect(active.monthlyTick).toBe(10000);
    expect(active.state.treaties).toHaveLength(1);
    expect(before.monthlyTick).toBe(0);
    active = runCapsReplayAction(active, 'caps-month', undefined, selection);
    expect(active.monthlyTick).toBe(20000);
    expect(active.state).not.toHaveProperty('treaties');
    let pending = applyCapsRecordedInput(start(), proposal(start()), { selection });
    pending.state.generals = {};
    while (pending.monthlyTick < 60000) pending = runCapsReplayAction(pending, 'caps-month', undefined, selection);
    expect(pending.state.treaties).toHaveLength(1);
    pending = runCapsReplayAction(pending, 'caps-month', undefined, selection);
    expect(pending.state).not.toHaveProperty('treaties');
    expect(await hash(pending)).toBe(await hash(JSON.parse(JSON.stringify(pending))));
  });
  it('M2 월간 뒤 조약 정산과 먼저 정산한 월간은 같고 같은 tick 정산은 멱등이다', () => {
    const replay = accepted();
    const after = settleTreaties(runMonthly(replay.state, 20000, rngFor('caps-month')).state, 20000);
    const before = runMonthly(settleTreaties(replay.state, 20000), 20000, rngFor('caps-month')).state;
    expect(after).toEqual(before);
    expect(settleTreaties(after, 20000)).toEqual(after);
  });
  it('G1 조약 없는 12개월은 옛 상태 해시와 같고 legacy 거절 경계를 보존한다', async () => {
    const input = origin();
    input.initial.generals = [];
    let caps = startCapsReplay(input, selection);
    let legacy = initialReplayState(input.initial);
    while (caps.monthlyTick < 120000) {
      caps = runCapsReplayAction(caps, 'caps-golden', undefined, selection);
      legacy = runReplayAction(legacy, 'caps-golden');
      expect(caps.state).not.toHaveProperty('treaties');
      expect(await hash(caps)).toBe(await hash(legacy));
    }
    const unknown = rejection({ kind: 'future', payload: null, result: null });
    expect(applyRecordedInput(legacy, unknown)).toBe(legacy);
    expect(() => validatePolicyRecordedInput(unknown, true)).toThrow();
    expect(() => validatePolicyRecordedInput(rejection(), true)).toThrow();
    expect(() =>
      validatePolicyRecordedInput(
        rejection({
          kind: 'general.active',
          payload: null,
          result: { code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' },
        }),
        true,
      ),
    ).not.toThrow();
  });
});
