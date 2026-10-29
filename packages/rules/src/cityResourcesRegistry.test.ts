import { describe, expect, it } from 'vitest';
import { operationalInput } from '../test/operationalMapFixture';
import { buildInitialWorld } from './world/bootstrap';
import { initialReplayState, applyRecordedInput } from './replay';
import { checkReplayOrigin, checkRuleFeatures, ruleRegistry } from './ruleRegistry';
import { resolverForRuleFeatures } from './ruleCommands';
import { cityResourcesFeature } from './cityResourcesFeature';
import { emptyCityResourcesState } from './cityResources/state';
import { applyCityResourceInput } from './cityResources/input';

const features = [
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
];
const data = { policy: { version: 1, turnTermMinutes: 60 } };
function fixture() {
  const initial = buildInitialWorld(operationalInput());
  initial.ruleFeatures = [...features];
  return initial;
}
describe('AC-INT-18B 운영 등록표의 도시 자원 연결', () => {
  it('의존 관계를 검사하고 원생성에는 자원을 주입하지 않은 채 초기 재생 원장을 만든다', () => {
    const initial = fixture(),
      before = JSON.stringify(initial);
    expect(checkRuleFeatures(features)).toEqual(features);
    const origin = {
      version: 3 as const,
      initial,
      initialStateHash: 'transport-check',
      resourceHash: 'transport-check',
      featureData: data,
    };
    expect(() => checkReplayOrigin(origin)).not.toThrow();
    const replay = initialReplayState(initial, data);
    expect(replay.state.cityResources).toEqual(emptyCityResourcesState(replay.state));
    expect(replay.state.campaign).toBeDefined();
    expect(replay.campaignArmyTypes).toContain(1100);
    expect(JSON.stringify(initial)).toBe(before);
    expect(Object.hasOwn(initial, 'cityResources')).toBe(false);
    expect(() => checkRuleFeatures(features.filter((key) => key !== 'campaign-assignment-v2'))).toThrow('의존');
  });
  it('새 판 resolver만 도시 모집과 도시 훈련·국가 배속·빈 부곡 명령을 낸다', () => {
    const resolver = resolverForRuleFeatures({ ruleFeatures: features })!;
    expect(resolver.get('recruit')!.args.safeParse({ amount: 1, crewType: 1100, unitId: 1 }).success).toBe(false);
    expect(resolver.get('train')!.args.safeParse({ target: 'city', crewType: 1100 }).success).toBe(true);
    expect(resolver.get('nation_city_allocate')!.target).toBe('nation');
    expect(resolver.get('form_unit')!.target).toBe('general');
    const old = resolverForRuleFeatures({ ruleFeatures: features.filter((key) => key !== 'city-resources-v1') })!;
    expect(old.get('nation_city_allocate')).toBeUndefined();
    expect(old.get('form_unit')).toBeUndefined();
    expect(old.get('train')!.args.safeParse({ target: 'city', crewType: 1100 }).success).toBe(false);
  });
  it('등록된 queued 입력이 실제 순수 배속을 재현하고 초기 병종 밖 기록을 거부한다', () => {
    const initial = fixture(),
      replay = initialReplayState(initial, data);
    // 입력 조율의 단위 고정물이며 정식 생성·한 기수 인수를 대신하지 않는다.
    const actor = replay.state.generals[1]!;
    actor.userId = 'city-unit-user';
    actor.officerLevel = 12;
    replay.residenceAnchors![actor.id] = 0;
    replay.state.campaign!.units = [
      { id: 1, ownerId: 1, commanderId: 1, troops: 0, crewType: 1100, train: 0, atmos: 0 },
    ];
    replay.state.campaign!.nextUnitId = 2;
    replay.state.cityResources!.cities[String(actor.cityKey)]!.garrison = [
      { crewType: 1100, troops: 100, train: 40, atmos: 60 },
    ];
    const payload = { cityKey: actor.cityKey, unitId: 1, crewType: 1100, amount: 50 };
    const applied = applyCityResourceInput(replay.state, payload, actor.id, {
      tick: 1,
      userId: actor.userId,
      userActive: true,
      armyTypes: replay.campaignArmyTypes!,
    });
    if (!applied.ok) throw new Error(applied.message);
    const input = {
      kind: 'city.resources',
      sequence: 1,
      tick: 1,
      generalId: actor.id,
      status: 'APPLIED' as const,
      payload,
      result: applied.result,
    };
    const kind = ruleRegistry.inputKinds.find((entry) => entry.kind === 'city.resources')!;
    expect(kind.feature).toBe('city-resources-v1');
    expect(kind.route).toBe('queued');
    expect(applyRecordedInput(replay, input).state).toEqual(applied.state);
    const origin = {
      version: 3 as const,
      initial,
      initialStateHash: 'unit-only',
      resourceHash: 'unit-only',
      featureData: data,
    };
    expect(() => cityResourcesFeature.checkArchive!({ origin, inputs: [input] })).not.toThrow();
    expect(() =>
      cityResourcesFeature.checkArchive!({
        origin,
        inputs: [{ ...input, payload: { ...payload, crewType: 1000 }, result: { ...input.result, crewType: 1000 } }],
      }),
    ).toThrow('없는');
  });
});
