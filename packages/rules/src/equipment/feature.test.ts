import { expect, it } from 'vitest';
import { buildInitialWorld } from '../world/bootstrap';
import { operationalInput } from '../../test/operationalMapFixture';
import { initialReplayStateWithRegistry } from '../replay';
import { checkReplayOrigin, checkRuleFeatures, ruleRegistry } from '../ruleRegistry';
import { resolverForRuleFeatures } from '../ruleCommands';
import { runGeneralTurn } from '../commands/turn';
import { readEquipmentState } from './state';
import { equipmentFeature } from './feature';
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

it('AC-P2-12 전용 등록표만 명시 장비 설정으로 독립된 빈 상태를 만든다', () => {
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
