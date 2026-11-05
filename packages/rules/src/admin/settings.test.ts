import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { initialReplayState, type RecordedInput } from '../replay';
import { parsePreset, presetRules } from '../world/preset';
import { effectiveWorldOptions, runtimeOptionsSchema } from '../world/options';
import {
  adminSettingPayloadSchema,
  decideAdminSetting,
  applyAdminSettingRecord,
  creationSettings,
  creationEndYear,
  type AdminSetting,
  type WorldSettings,
} from './settings';

function fixture(withPreset = true) {
  const preset = parsePreset({
    name: '정규',
    turnTermMinutes: 60,
    scenario: '1030',
    map: 'che',
    unitSet: 'basic',
    commands: null,
    npc: { fillRatio: 1, aggression: 1 },
    protection: { foundUntilMonths: 0, peaceMonths: 0, maxGeneralsPerNation: null },
    boost: { smallWorld: null, lateJoin: null },
    features: { advisor: false },
  });
  const initial = commandInitial();
  initial.ruleFeatures = ['personnel', 'policy'];
  if (withPreset) initial.presetRules = presetRules(preset);
  const replay = initialReplayState(initial, { policy: { version: 1, turnTermMinutes: 60 } });
  const world: WorldSettings = {
    name: '생성 이름',
    endYear: 231,
    turnTermMinutes: 60,
    startYear: 191,
    preset: withPreset ? preset : null,
    runtimeOptions: null,
  };
  return { replay, world };
}
const context = { userActive: true, admin: true, sanctioned: false, replayFormat: 3, worldStatus: 'RUNNING', tick: 0 };
const payload = (setting: AdminSetting) => ({ version: 1, reason: '설정 검증', setting });

it.each([false, true])('AC-INT-24 휴전은 프리셋 유무=%s에서 명시적 null과 다른 옵션을 보존한다', (hasPreset) => {
  const { world, replay } = fixture(hasPreset);
  const truce = { utcOffsetMinutes: 540, startMinute: 60, endMinute: 420 };
  if (world.preset) world.preset.truce = truce;
  const original = structuredClone(world);
  expect(effectiveWorldOptions(world.preset).truce).toEqual(hasPreset ? truce : null);
  world.runtimeOptions = {
    entry: { generalCreation: 'closed' },
    ...(hasPreset ? { rules: { npc: { aggression: 2 } } } : {}),
  };
  if (hasPreset) replay.state.presetRules = effectiveWorldOptions(world.preset, world.runtimeOptions).presetRules!;
  const setting: AdminSetting = { kind: 'admin.world.setTruce', truce: hasPreset ? null : truce };
  const changed = decideAdminSetting(replay, world, payload(setting), context);
  expect(changed.status).toBe('APPLIED');
  expect(changed.replay).toEqual(replay);
  expect(changed.settings.preset).toEqual(original.preset);
  expect(changed.settings.runtimeOptions).toEqual({ ...world.runtimeOptions, truce: setting.truce });
  expect(effectiveWorldOptions(changed.settings.preset, changed.settings.runtimeOptions).truce).toEqual(setting.truce);
  const record: RecordedInput = {
    sequence: 1,
    tick: 0,
    generalId: null,
    kind: setting.kind,
    status: changed.status,
    payload: payload(setting),
    result: changed.result,
  };
  expect(applyAdminSettingRecord(replay, record)).toEqual(replay);
  expect(() =>
    applyAdminSettingRecord(replay, {
      ...record,
      result: { version: 1, before: { truce: null }, after: { truce: { ...truce, startMinute: 61 } } },
    }),
  ).toThrow();
  expect(decideAdminSetting(replay, changed.settings, payload(setting), context).result).toMatchObject({
    code: 'UNCHANGED',
  });
  expect(runtimeOptionsSchema.safeParse({ truce: { ...truce, endMinute: 60 } }).success).toBe(false);
});

it('AC-INT-24 설정이 없으면 기존 프리셋 모양·생성 이름·간격·종료 연도를 보존한다', () => {
  const { world } = fixture();
  expect(effectiveWorldOptions(world.preset).presetRules).toEqual(presetRules(world.preset!));
  expect(effectiveWorldOptions(null).presetRules).toBeUndefined();
  expect(creationSettings({ ...world, name: ' 기존 이름 ' }, [])).toEqual({
    name: ' 기존 이름 ',
    endYear: 231,
    turnTermMinutes: 60,
  });
  expect(creationEndYear({ config: { endYear: null }, inputs: [] })).toBeNull();
});

it('AC-INT-24 규칙 옵션은 깊게 합치고 생성 원본·다른 옵션·활동 tick을 바꾸지 않는다', () => {
  let { world, replay } = fixture();
  const originalPreset = structuredClone(world.preset),
    activity = structuredClone(replay.policy);
  for (const [key, value] of [
    ['protection.peaceMonths', 12],
    ['npc.aggression', 0.5],
    ['protection.foundUntilMonths', 3],
  ] as const) {
    const setting: AdminSetting = { kind: 'admin.world.setOption', key, value };
    const outcome = decideAdminSetting(replay, world, payload(setting), context);
    expect(outcome.status).toBe('APPLIED');
    const input: RecordedInput = {
      sequence: 1,
      tick: 0,
      generalId: null,
      kind: setting.kind,
      status: outcome.status,
      payload: payload(setting),
      result: outcome.result,
    };
    expect(applyAdminSettingRecord(replay, input)).toEqual(outcome.replay);
    world = outcome.settings;
    replay = outcome.replay;
  }
  expect(world.preset).toEqual(originalPreset);
  expect(replay.policy).toEqual(activity);
  expect(replay.state.presetRules).toMatchObject({
    protection: { peaceMonths: 12, foundUntilMonths: 3, maxGeneralsPerNation: null },
    npc: { aggression: 0.5 },
  });
  expect(effectiveWorldOptions(world.preset, world.runtimeOptions).presetRules).toEqual(replay.state.presetRules);
});

it('AC-INT-24 JSONB 키 순서가 달라도 유효 규칙·같은 값 판정이 같다', () => {
  const { replay, world } = fixture();
  const rules = replay.state.presetRules!;
  replay.state.presetRules = {
    boost: rules.boost,
    npc: rules.npc,
    protection: { maxGeneralsPerNation: null, peaceMonths: 0, foundUntilMonths: 0 },
  };
  expect(
    decideAdminSetting(
      replay,
      world,
      payload({ kind: 'admin.world.setOption', key: 'npc.aggression', value: 1 }),
      context,
    ),
  ).toMatchObject({ status: 'REJECTED', result: { code: 'UNCHANGED' } });
});

it('AC-INT-24 간격 변경은 정책 간격만 바꾸고 재생의 이전 값 위조를 거부한다', () => {
  const { replay, world } = fixture();
  replay.policy!.lastActiveTicks[1] = 123;
  const setting: AdminSetting = { kind: 'admin.world.setTurnTerm', turnTermMinutes: 10 };
  const outcome = decideAdminSetting(replay, world, payload(setting), context);
  expect(outcome.replay.policy).toMatchObject({ turnTermMinutes: 10, lastActiveTicks: { 1: 123 } });
  expect(replay.policy!.turnTermMinutes).toBe(60);
  const input: RecordedInput = {
    sequence: 1,
    tick: 0,
    generalId: null,
    kind: setting.kind,
    status: 'APPLIED',
    payload: payload(setting),
    result: outcome.result,
  };
  expect(applyAdminSettingRecord(replay, input)).toEqual(outcome.replay);
  expect(() =>
    applyAdminSettingRecord(replay, {
      ...input,
      result: { version: 1, before: { turnTermMinutes: 30 }, after: { turnTermMinutes: 10 } },
    }),
  ).toThrow('변경 전');
});

it('AC-INT-24 설정 연쇄를 역산해 생성 당시 값을 복원하고 현재 값·결과 위조를 거부한다', () => {
  let { replay, world } = fixture();
  const original = creationSettings(world, []),
    records: RecordedInput[] = [];
  const settings: AdminSetting[] = [
    { kind: 'admin.world.rename', name: '바꾼 이름' },
    { kind: 'admin.world.setEndYear', endYear: 240 },
    { kind: 'admin.world.setTurnTerm', turnTermMinutes: 30 },
    { kind: 'admin.world.rename', name: '두번째 이름' },
    { kind: 'admin.world.setEndYear', endYear: 250 },
  ];
  for (const setting of settings) {
    const outcome = decideAdminSetting(replay, world, payload(setting), context);
    expect(outcome.status).toBe('APPLIED');
    records.push({
      sequence: records.length + 1,
      tick: 0,
      generalId: null,
      kind: setting.kind,
      status: outcome.status,
      payload: payload(setting),
      result: outcome.result,
    });
    world = outcome.settings;
    replay = outcome.replay;
  }
  expect(creationSettings(world, records.toReversed())).toEqual(original);
  expect(creationEndYear({ config: { endYear: world.endYear }, inputs: records })).toBe(231);
  expect(() => creationSettings({ ...world, name: '기록 없는 변경' }, records)).toThrow('변경 이력');
  const forged = structuredClone(records);
  forged[1]!.result = { version: 1, before: { endYear: 231 }, after: { endYear: 249 } };
  expect(() => creationSettings(world, forged)).toThrow('적용한 값');
});

it('AC-INT-24 권한·월드·연도·프리셋·불변 옵션의 거절 순서를 지킨다', () => {
  const { replay, world } = fixture(false);
  const setting: AdminSetting = { kind: 'admin.world.setEndYear', endYear: 190 };
  for (const [change, code] of [
    [{ userActive: false }, 'ACTOR_INACTIVE'],
    [{ admin: false }, 'ADMIN_REQUIRED'],
    [{ sanctioned: true }, 'ACTOR_SANCTIONED'],
    [{ replayFormat: 1 }, 'UNSUPPORTED_FORMAT'],
    [{ worldStatus: 'ENDED' }, 'WORLD_STATE_CHANGED'],
  ] as const)
    expect(decideAdminSetting(replay, world, payload(setting), { ...context, ...change }).result).toMatchObject({
      code,
    });
  expect(decideAdminSetting(replay, world, payload(setting), context).result).toMatchObject({
    code: 'END_YEAR_PASSED',
  });
  expect(
    decideAdminSetting(
      replay,
      world,
      payload({ kind: 'admin.world.setOption', key: 'npc.aggression', value: 2 }),
      context,
    ).result,
  ).toMatchObject({ code: 'NO_PRESET' });
  for (const raw of [
    { kind: 'admin.world.setOption', key: 'npc.fillRatio', value: 0.5 },
    { kind: 'admin.world.setOption', key: 'protection.maxGeneralsPerNation', value: 5 },
    { kind: 'admin.world.setOption', key: 'commands', value: null },
    { kind: 'admin.world.setTurnTerm', turnTermMinutes: 0 },
    { kind: 'admin.world.rename', name: ' ' },
    { kind: 'admin.world.rename', name: '\u0000' },
    { kind: 'admin.world.rename', name: '\ud800' },
  ])
    expect(adminSettingPayloadSchema.safeParse({ version: 1, reason: '범위 검증', setting: raw }).success).toBe(false);
  for (const invalid of [
    { rules: {} },
    { rules: { npc: { fillRatio: 1 } } },
    { rules: { protection: { maxGeneralsPerNation: null } } },
  ])
    expect(runtimeOptionsSchema.safeParse(invalid).success).toBe(false);
});

it('AC-INT-24 생성 열기·닫기는 프리셋 없이도 가능하고 규칙 옵션과 서로 보존된다', () => {
  for (const hasPreset of [false, true]) {
    let { world, replay } = fixture(hasPreset);
    const original = structuredClone(replay);
    const closed = decideAdminSetting(
      replay,
      world,
      payload({ kind: 'admin.world.setOption', key: 'entry.generalCreation', value: 'closed' }),
      context,
    );
    expect(closed.status).toBe('APPLIED');
    world = closed.settings;
    expect(effectiveWorldOptions(world.preset, world.runtimeOptions).entry.generalCreation).toBe('closed');
    expect(closed.replay).toEqual(original);
    if (hasPreset) {
      const rules = decideAdminSetting(
        replay,
        world,
        payload({ kind: 'admin.world.setOption', key: 'npc.aggression', value: 0.5 }),
        context,
      );
      world = rules.settings;
      replay = rules.replay;
      expect(world.runtimeOptions!.entry!.generalCreation).toBe('closed');
    }
    const opened = decideAdminSetting(
      replay,
      world,
      payload({ kind: 'admin.world.setOption', key: 'entry.generalCreation', value: 'open' }),
      context,
    );
    expect(opened.status).toBe('APPLIED');
    expect(opened.settings.runtimeOptions!.rules).toEqual(world.runtimeOptions!.rules);
    expect(effectiveWorldOptions(opened.settings.preset, opened.settings.runtimeOptions).entry.generalCreation).toBe(
      'open',
    );
    expect(opened.replay).toEqual(replay);
    const record: RecordedInput = {
      sequence: 1,
      tick: 0,
      generalId: null,
      kind: 'admin.world.setOption',
      status: closed.status,
      payload: payload({ kind: 'admin.world.setOption', key: 'entry.generalCreation', value: 'closed' }),
      result: closed.result,
    };
    expect(applyAdminSettingRecord(original, record)).toEqual(original);
  }
  expect(runtimeOptionsSchema.safeParse({ entry: { npcPlay: 'on' } }).success).toBe(false);
});
