import { expect, it } from 'vitest';
import { buildInitialWorld } from '../world/bootstrap';
import { operationalInput } from '../../test/operationalMapFixture';
import { initialReplayStateWithRegistry } from '../replay';
import { checkReplayOrigin, checkRuleFeatures, ruleRegistry } from '../ruleRegistry';
import { resolverForRuleFeatures } from '../ruleCommands';
import { runGeneralTurn } from '../commands/turn';
import { readEquipmentState } from './state';
import { equipmentFeature } from './feature';
import { useBattleTool } from './morale';
import { TEST_EQUIPMENT_CONFIG, TEST_EQUIPMENT_LOGISTICS_CONFIG } from './testFixture';

const registry = ruleRegistry;
const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'equipment-v1',
  'five-stats',
  'logistics-v1',
  'operational-map',
  'personnel',
  'policy',
];
function origin() {
  const initial = buildInitialWorld(operationalInput());
  initial.ruleFeatures = [...features];
  for (const general of initial.generals) general.crew = 0;
  return {
    version: 3 as const,
    initial,
    // 기존 규칙 단위 계약처럼 해시 자체는 운반 계층에서 검사한다.
    initialStateHash: 'adapter-checks-hash',
    resourceHash: 'adapter-checks-hash',
    featureData: {
      policy: { version: 1, turnTermMinutes: 60 },
      'equipment-v1': structuredClone(TEST_EQUIPMENT_CONFIG),
      'logistics-v1': structuredClone(TEST_EQUIPMENT_LOGISTICS_CONFIG),
    },
  };
}

it('AC-P2-12 운영 등록표가 명시 장비 설정으로 독립된 빈 상태를 만든다', () => {
  const value = origin(),
    before = structuredClone(value);
  expect(() => checkReplayOrigin(value, registry)).not.toThrow();
  const first = initialReplayStateWithRegistry(value.initial, registry, value.featureData),
    second = initialReplayStateWithRegistry(value.initial, registry, value.featureData);
  expect(first.state.equipment).toEqual({ version: 1, config: TEST_EQUIPMENT_CONFIG, generals: {} });
  expect(first.state.equipment).not.toBe(second.state.equipment);
  first.state.equipment!.config.items[0]!.cost++;
  expect(value).toEqual(before);
  expect(second.state.equipment!.config).toEqual(TEST_EQUIPMENT_CONFIG);
  expect(ruleRegistry.features.filter((feature) => feature.key === 'equipment-v1')).toHaveLength(1);
  expect(() => checkRuleFeatures(features)).not.toThrow();
});

it.each(['five-stats', 'campaign-v1', 'logistics-v1'])('AC-P2-12 %s 의존을 빼면 장비 기능을 켤 수 없다', (missing) => {
  expect(() =>
    checkRuleFeatures(
      features.filter((key) => key !== missing),
      registry,
    ),
  ).toThrow('의존');
});

it.each(['missing', 'invalid', 'injected'] as const)('AC-P2-12 %s 원생성을 거부한다', (kind) => {
  const value = origin();
  if (kind === 'missing') delete (value.featureData as Partial<typeof value.featureData>)['equipment-v1'];
  else if (kind === 'invalid') value.featureData['equipment-v1'].items[0]!.cost = -1;
  else Object.assign(value.initial, { equipment: { version: 1, generals: {} } });
  expect(() => checkReplayOrigin(value, registry)).toThrow();
});

it('AC-P2-12 장비 초기화를 두 번 적용하지 않는다', () => {
  const value = origin(),
    replay = initialReplayStateWithRegistry(value.initial, registry, value.featureData);
  expect(() =>
    equipmentFeature.initReplayState!(replay, { initial: value.initial, data: value.featureData['equipment-v1'] }),
  ).toThrow('중복');
});

it.each([true, false])('AC-P2-12 기능표 resolver의 실제 개인 차례는 장비매매를 판정한다: 금 충분=%s', (enough) => {
  const value = origin(),
    replay = initialReplayStateWithRegistry(value.initial, registry, value.featureData),
    resolver = resolverForRuleFeatures(replay.state, registry)!;
  replay.state.generals[1]!.userId = 'equipment-test-user';
  replay.state.generals[1]!.gold = enough ? 100 : 0;
  Object.assign(replay.state.logistics!.cities['1']!, { iron: 20, wood: 20, horses: 20 });
  expect(resolver.get('equipment_trade')?.target).toBe('general');
  const before = structuredClone(replay.state),
    turn = runGeneralTurn(
      replay.state,
      { generalId: 1, tick: 0, unitSet: value.initial.unitSet },
      { commandKey: 'equipment_trade', args: { slot: 'horse', itemKey: 'horse_01' }, explicit: true },
      value.initial.seed,
      {},
      resolver,
      { offices: replay.offices! },
    );
  expect(turn.commandKey).toBe('equipment_trade');
  if (enough) {
    expect('code' in turn.result).toBe(false);
    expect(turn.state.generals[1]!.gold).toBe(89);
    expect(turn.state.logistics!.cities['1']!.horses).toBe(18);
    expect(readEquipmentState(turn.state.equipment, turn.state).generals['1']).toEqual({ horse: 'horse_01' });
  } else {
    expect(turn.result).toMatchObject({ code: 'NO_GOLD' });
    expect(turn.state).toEqual(before);
  }
  expect(replay.state).toEqual(before);
});

it('INT-26 환약은 턴 전에 부상을 회복하고 세 번째 사용 후 장비에서 사라진다', () => {
  const value = origin();
  const featureData = { ...value.featureData, 'equipment-v1': { ...TEST_EQUIPMENT_CONFIG, treatmentTool: true } };
  const replay = initialReplayStateWithRegistry(value.initial, registry, featureData);
  const resolver = resolverForRuleFeatures(replay.state, registry)!;
  const actor = { generalId: 1, tick: 1, unitSet: value.initial.unitSet };
  const general = replay.state.generals[1]!;
  general.userId = 'equipment-test-user';
  general.gold = 200;
  general.injury = 9;
  const buy = { commandKey: 'equipment_trade', args: { slot: 'tool', itemKey: 'tool_01' }, explicit: true };
  const turn = (state: typeof replay.state, command: Parameters<typeof runGeneralTurn>[2]) =>
    runGeneralTurn(state, actor, command, value.initial.seed, {}, resolver, { offices: replay.offices! });
  const purchased = turn(replay.state, buy);
  expect(purchased.result).not.toHaveProperty('code');
  expect(purchased.state.equipment!.generals['1']!.tool?.charges).toBe(3);
  expect(purchased.state.generals[1]!.gold).toBe(0);
  expect(purchased.treatment).toBeUndefined();
  const unavailable = { commandKey: 'unknown-command', args: {}, explicit: true } as const;
  let state = purchased.state;
  for (const charges of [2, 1, 0]) {
    state.generals[1]!.injury = 10;
    const treated = turn(state, unavailable);
    expect(treated.result).toMatchObject({ code: 'UNKNOWN_COMMAND' });
    expect(treated.treatment).toBe(true);
    expect(treated.state.generals[1]!.injury).toBe(0);
    expect(treated.state.equipment!.generals['1']?.tool?.charges ?? 0).toBe(charges);
    expect(state.generals[1]!.injury).toBe(10);
    state = treated.state;
  }
  expect(state.equipment!.generals['1']).toBeUndefined();
});

it('INT-26 훈련 청주는 전투에서 한 번 사용되고 훈련을 100까지 올린다', () => {
  const value = origin();
  const featureData = {
    ...value.featureData,
    'equipment-v1': {
      ...TEST_EQUIPMENT_CONFIG,
      treatmentTool: true,
      moraleTool: true,
      rareEquipment: true,
      fullRareEquipment: true,
    },
  };
  const { state } = initialReplayStateWithRegistry(value.initial, registry, featureData);
  state.equipment!.generals['1'] = { tool: { key: 'tool_03', charges: 1 } };
  const force = { train: 75, atmos: 60 };
  useBattleTool(state, 1, force);
  expect(force).toEqual({ train: 100, atmos: 60 });
  expect(state.equipment!.generals['1']).toBeUndefined();
  force.train = 60;
  useBattleTool(state, 1, force);
  expect(force.train).toBe(60);
});
