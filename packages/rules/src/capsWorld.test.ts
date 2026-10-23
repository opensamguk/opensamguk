import { describe, expect, it } from 'vitest';
import { commandInitial } from '../test/commandFixture';
import { parsePreset, presetRules } from './world/preset';
import * as rules from './index';
import { selectWorldCapabilities, projectTreatyRows, type WorldCapsRow, type TreatyStorageRow } from './capsWorld';
import { parseCapsOrigin, type CapsOrigin } from './replayCapabilities';

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

function row(): WorldCapsRow {
  return {
    treatyFormat: null,
    personnelFormat: null,
    policyFromSequence: null,
    actionSequence: 0,
    turnTermMinutes: 30,
    endYear: null,
    outcomeFromSequence: 0,
    replayOrigin: { version: 1 },
  };
}
function origin(): CapsOrigin {
  return {
    version: 6,
    initial: commandInitial(),
    initialStateHash: 'initial',
    resourceHash: 'resource',
    capabilities: { version: 1, treaty: { version: 1 } },
  };
}
function enabled(): WorldCapsRow {
  return { ...row(), treatyFormat: 1, replayOrigin: origin() };
}
function stored(overrides: Partial<TreatyStorageRow> = {}): TreatyStorageRow {
  return {
    id: 1,
    fromNationId: 1,
    toNationId: 2,
    clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }],
    status: 'ACTIVE',
    proposedTick: 500,
    respondByTick: 60500,
    startTick: 1500,
    endTick: 11500,
    costFrom: 17,
    costTo: 9,
    closedSequence: null,
    ...overrides,
  };
}

describe('T4-03 / AC-P2-02 저장된 월드 기능 선택 U1~U11', () => {
  it('U1 origin 1은 정책 off·F=0·F>0을 보존하고 기존 공개와 기본 37개를 유지한다', () => {
    expect(rules.selectWorldCapabilities).toBe(selectWorldCapabilities);
    expect(rules.projectTreatyRows).toBe(projectTreatyRows);
    expect(rules.parseCapsOrigin).toBe(parseCapsOrigin);
    expect(rules.ORIGIN_CAPS).toBe(6);
    expect(rules.ARCHIVE_CAPS).toBe(6);
    expect(rules).not.toHaveProperty('enterCapsPolicyAtMarker');
    for (const name of [
      'canManagePersonnel',
      'canUseNationTurns',
      'canExecuteNationCommand',
      'nationCommandKeys',
      'isAppointableOfficerLevel',
      'officerTitle',
      'validateTreatyState',
      'treatyRespondByTick',
      'validateTreatyRecord',
    ])
      expect(typeof rules[name as keyof typeof rules]).toBe('function');
    expect(rules.APPOINTABLE_OFFICER_LEVELS.length).toBeGreaterThan(0);
    expect(rules.commands).toHaveLength(37);
    const off = rules.createCommandResolver(null);
    expect([...off.list('general'), ...off.list('nation')].map((command) => command.key).sort()).toEqual(
      rules.commands.map((command) => command.key).sort(),
    );
    for (const fromSequence of [null, 0, 20]) {
      const input = {
        ...row(),
        policyFromSequence: fromSequence,
        actionSequence: fromSequence ?? 0,
        preset: { commands: null },
      };
      const before = structuredClone(input);
      expect(selectWorldCapabilities(input)).toEqual({
        kind: 'legacy',
        policy: fromSequence === null ? null : { version: 1, fromSequence, turnTermMinutes: 30 },
      });
      expect(input).toEqual(before);
    }
  });

  it('U2 origin 1의 조약 저장 표시를 승격하지 않고 거부한다', () => {
    expect(() => selectWorldCapabilities({ ...row(), treatyFormat: 1 })).toThrow('조약 저장 형식');
  });

  it('U3 origin 6의 조약·정책 선택을 복제하고 활동 기준이나 상태를 만들지 않는다', () => {
    for (const fromSequence of [null, 0, 20]) {
      const input = { ...enabled(), policyFromSequence: fromSequence, actionSequence: fromSequence ?? 0 };
      const before = structuredClone(input);
      const selected = selectWorldCapabilities(input);
      expect(selected).toEqual({
        kind: 'caps',
        origin: input.replayOrigin,
        selection: {
          treaty: { version: 1 },
          policy: fromSequence === null ? null : { version: 1, fromSequence, turnTermMinutes: 30 },
        },
      });
      expect(selected).not.toHaveProperty('state');
      expect(selected).not.toHaveProperty('baselineActiveTick');
      if (selected.kind !== 'caps') throw new Error('형식 6 선택이 아닙니다.');
      selected.origin.initial.generals[0]!.name = '복제 확인';
      expect(input).toEqual(before);
    }
  });

  it('U4 origin 6 descriptor와 DB 표시가 다르면 거부한다', () => {
    expect(() => selectWorldCapabilities({ ...enabled(), treatyFormat: null })).toThrow('조약 저장 형식');
    const input = { ...enabled(), replayOrigin: { ...origin(), capabilities: { version: 1, ext: {} } } };
    expect(() => selectWorldCapabilities(input)).toThrow('조약 저장 형식');
  });

  it('T4-17 B ext 단독 F=0은 조약·인사 표지 없이 고르고 다른 F와 표지를 거부한다', () => {
    const input = origin();
    const commands = { general: ['fire_attack'], nation: [] };
    const preset = parsePreset({ ...regular, commands });
    input.initial.presetRules = presetRules(preset);
    input.capabilities = { version: 1, ext: { version: 1, commands, preset, resources: {}, sliceKeys: [] } };
    // DB preset 대조는 Ext 앱 인계 뒤에 붙인다. 이 선택자는 저장된 origin만 본다.
    const stored = { ...row(), policyFromSequence: 0, replayOrigin: input, preset: null };
    const before = structuredClone(stored);
    expect(selectWorldCapabilities(stored)).toEqual({
      kind: 'caps',
      origin: input,
      selection: { ext: input.capabilities.ext, policy: { version: 1, fromSequence: 0, turnTermMinutes: 30 } },
    });
    expect(stored).toEqual(before);
    for (const policyFromSequence of [null, 20])
      expect(() => selectWorldCapabilities({ ...stored, policyFromSequence, actionSequence: 20 })).toThrow();
    expect(() => selectWorldCapabilities({ ...stored, treatyFormat: 1 })).toThrow('조약 저장 형식');
    expect(() => selectWorldCapabilities({ ...stored, personnelFormat: 1 })).toThrow('인사 저장 형식');
  });

  it('U5 조약 없는 ext와 인사 descriptor도 운반은 보존하고 실행 선택은 거부한다', () => {
    for (const capabilities of [
      { version: 1, ext: { commands: ['future'], nested: [1] } },
      { version: 1, personnel: { version: 1 } },
      { version: 1, treaty: { version: 1 }, ext: {} },
      { version: 1, treaty: { version: 1 }, personnel: {} },
    ]) {
      const candidate = { ...origin(), capabilities };
      const before = structuredClone(candidate);
      expect(parseCapsOrigin(candidate)).toEqual(candidate);
      expect(() =>
        selectWorldCapabilities({
          ...row(),
          treatyFormat: Object.hasOwn(capabilities, 'treaty') ? 1 : null,
          personnelFormat: Object.hasOwn(capabilities, 'personnel') ? 1 : null,
          replayOrigin: candidate,
        }),
      ).toThrow('기능 조합');
      expect(candidate).toEqual(before);
    }
  });

  it('U6 저장 표시의 범위와 형식을 강제 변환하지 않는다', () => {
    for (const treatyFormat of [2, 0, -1, 1.5, '1', undefined, NaN])
      expect(() => selectWorldCapabilities({ ...row(), treatyFormat } as WorldCapsRow)).toThrow();
    for (const base of [row(), enabled()])
      for (const personnelFormat of [2, 0, -1, 1.5, '1', undefined, NaN, Infinity]) {
        const input = { ...base, personnelFormat } as WorldCapsRow;
        const before = structuredClone(input);
        expect(() => selectWorldCapabilities(input)).toThrow();
        expect(input).toEqual(before);
      }
    for (const actionSequence of [-1, 0.5, 2147483648])
      expect(() => selectWorldCapabilities({ ...row(), actionSequence })).toThrow();
  });

  it.each([null, 0, 20])('B9 O2 인사 표지 대조는 정책 F=%s에서 켜짐을 허용하지 않는다', (fromSequence) => {
    const policy = { policyFromSequence: fromSequence, actionSequence: fromSequence ?? 0 };
    for (const replayOrigin of [null, { version: 1 }]) {
      const input = { ...row(), ...policy, replayOrigin };
      expect(selectWorldCapabilities(input)).toEqual({
        kind: 'legacy',
        policy: fromSequence === null ? null : { version: 1, fromSequence, turnTermMinutes: 30 },
      });
      expect(() => selectWorldCapabilities({ ...input, personnelFormat: 1 })).toThrow('인사 저장 형식');
    }
    const treatyOnly = { ...enabled(), ...policy };
    expect(selectWorldCapabilities(treatyOnly)).toEqual({
      kind: 'caps',
      origin: treatyOnly.replayOrigin,
      selection: {
        treaty: { version: 1 },
        policy: fromSequence === null ? null : { version: 1, fromSequence, turnTermMinutes: 30 },
      },
    });
    expect(() => selectWorldCapabilities({ ...treatyOnly, personnelFormat: 1 })).toThrow('인사 저장 형식');
    for (const capabilities of [
      { version: 1, personnel: { version: 1 } },
      { version: 1, treaty: { version: 1 }, personnel: { version: 1 } },
      { version: 1, treaty: { version: 1 }, personnel: {} },
      { version: 1, treaty: { version: 1 }, personnel: { version: 2 } },
    ]) {
      const input = {
        ...row(),
        ...policy,
        treatyFormat: Object.hasOwn(capabilities, 'treaty') ? 1 : null,
        replayOrigin: { ...origin(), capabilities },
      };
      const before = structuredClone(input);
      expect(() => selectWorldCapabilities(input)).toThrow('인사 저장 형식');
      expect(() => selectWorldCapabilities({ ...input, personnelFormat: 1 })).toThrow('기능 조합');
      expect(input).toEqual(before);
    }
  });

  it('B9 O2 인사 표지가 없는 손 행에 기본값을 채우지 않는다', () => {
    const { personnelFormat: ignored, ...missing } = row();
    void ignored;
    const before = structuredClone(missing);
    expect(() => {
      // @ts-expect-error 저장 행에는 인사 표지가 반드시 있어야 한다.
      selectWorldCapabilities(missing);
    }).toThrow();
    expect(missing).toEqual(before);
  });

  it.each([true, null, [], 0])('B9 O2 일반 객체가 아닌 인사 descriptor는 운반부터 거부한다: %j', (personnel) => {
    const input = {
      ...enabled(),
      personnelFormat: 1,
      replayOrigin: { ...origin(), capabilities: { version: 1, treaty: { version: 1 }, personnel } },
    };
    const before = structuredClone(input);
    expect(() => selectWorldCapabilities(input)).toThrow('형식 6 기능 표시');
    expect(input).toEqual(before);
  });

  it('U7 다른 origin 번호와 파손된 생성 기록을 거부하고 legacy parser를 넓히지 않는다', () => {
    for (const version of [2, 3, 4, 5, '1', '6', undefined])
      expect(() => selectWorldCapabilities({ ...row(), replayOrigin: { ...origin(), version } })).toThrow();
    for (const replayOrigin of [
      [],
      6,
      '6',
      {},
      { ...origin(), extra: true },
      { ...origin(), capabilities: { version: 1, treaty: { version: 2 } } },
    ])
      expect(() => selectWorldCapabilities({ ...enabled(), replayOrigin })).toThrow();
  });

  it('U8 F는 저장된 actionSequence를 넘지 않고 기존 정책 schema를 따른다', () => {
    for (const input of [row(), enabled()]) {
      expect(() => selectWorldCapabilities({ ...input, policyFromSequence: 20, actionSequence: 19 })).toThrow(
        '전환 순서',
      );
      for (const policyFromSequence of [-1, 1.5, 2147483648])
        expect(() => selectWorldCapabilities({ ...input, policyFromSequence })).toThrow();
      expect(() => selectWorldCapabilities({ ...input, policyFromSequence: 0, turnTermMinutes: 0 })).toThrow();
      expect(() => selectWorldCapabilities({ ...input, policyFromSequence: 0, actionSequence: 0 })).not.toThrow();
    }
  });

  it('U9 닫힌 행과 비용·감사 칸은 상태 밖에 두고 열린 행만 깊이 복제한다', () => {
    const pending = stored({ id: 2, status: 'PROPOSED', startTick: null, endTick: null, costFrom: null, costTo: null });
    const closed = ['REJECTED', 'EXPIRED', 'ENDED'].map((status, i) =>
      stored({ id: i + 3, status: status as TreatyStorageRow['status'], closedSequence: 10 + i }),
    );
    const input = [pending, ...closed, stored()];
    const before = structuredClone(input);
    const result = rules.projectTreatyRows(input)!;
    expect(result.map(({ id }) => id)).toEqual([1, 2]);
    expect(Object.keys(result[0]!).sort()).toEqual(
      [
        'id',
        'fromNationId',
        'toNationId',
        'clauses',
        'status',
        'proposedTick',
        'respondByTick',
        'startTick',
        'endTick',
      ].sort(),
    );
    expect(result[0]).toEqual({
      id: 1,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }],
      status: 'ACTIVE',
      proposedTick: 500,
      respondByTick: 60500,
      startTick: 1500,
      endTick: 11500,
    });
    result[0]!.clauses.push({ kind: 'note', text: '복제 확인' });
    expect(input).toEqual(before);
    expect(projectTreatyRows([])).toBeUndefined();
    expect(projectTreatyRows(closed)).toBeUndefined();
    const state = { ...(projectTreatyRows(closed) ? { treaties: projectTreatyRows(closed) } : {}) };
    expect(Object.hasOwn(state, 'treaties')).toBe(false);
    expect(JSON.stringify(state)).toBe('{}');
  });

  it('U10 파손된 저장 행을 정규화하거나 조용히 빼지 않는다', () => {
    const badRows = [
      { ...stored(), status: 'BROKEN' },
      { ...stored(), extra: true },
      { ...stored(), worldId: 'world' },
      stored({ costFrom: null }),
      stored({ costTo: -1 }),
      stored({ costFrom: 1.5 }),
      stored({ costTo: 2147483648 }),
      stored({ closedSequence: 20 }),
      stored({ status: 'PROPOSED', costFrom: 1 }),
      stored({ status: 'ENDED', closedSequence: null }),
      stored({ status: 'ENDED', closedSequence: 0 }),
      stored({ clauses: null }),
      stored({ clauses: [...(stored().clauses as unknown[])].reverse() }),
      stored({ respondByTick: 60501 }),
      stored({ endTick: 11501 }),
      stored({ fromNationId: 2 }),
    ];
    for (const bad of badRows) {
      const before = structuredClone(bad);
      expect(() => projectTreatyRows([bad])).toThrow();
      expect(bad).toEqual(before);
    }
    const { clauses: ignored, ...missing } = stored();
    void ignored;
    expect(() => projectTreatyRows([missing])).toThrow();
    expect(() => projectTreatyRows([stored(), stored()])).toThrow('ID');
    expect(() => projectTreatyRows([stored(), stored({ status: 'ENDED', closedSequence: 10 })])).toThrow('ID');
  });

  it('U11 생성 기록 없는 기존 월드는 legacy로 보존하고 조약 표시만 있는 행은 거부한다', () => {
    for (const fromSequence of [null, 0, 20]) {
      const input = {
        ...row(),
        replayOrigin: null,
        policyFromSequence: fromSequence,
        actionSequence: fromSequence ?? 0,
      };
      expect(selectWorldCapabilities(input)).toEqual({
        kind: 'legacy',
        policy: fromSequence === null ? null : { version: 1, fromSequence, turnTermMinutes: 30 },
      });
      expect(input.replayOrigin).toBeNull();
    }
    expect(() => selectWorldCapabilities({ ...enabled(), replayOrigin: null })).toThrow('조약 저장 형식');
  });
});
