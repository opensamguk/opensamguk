import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { rngFor } from '../packages/shared/src/index';
import {
  applySexLedger,
  assertGovernanceFinal,
  assertLineageFinal,
  assertNationLifecycle,
  buildInitialWorld,
  featureProfileSchema,
  initialReplayStateWithRegistry,
  readCampaignState,
  readCityResourcesState,
  readLogisticsState,
  readStratagemCardsState,
  resolverForRuleFeatures,
  ruleRegistry,
  runMonthly,
  settleMonthlyFeatures,
  TICKS_PER_MONTH,
  type WorldState,
} from '../packages/rules/src/index';
import { applyEffects } from '../packages/rules/src/commands/effects';
import { loadSexLedger } from '../apps/engine/src/world/resources';
import { expandedScenarioRow } from './expanded-resources';

const read = (path: string) => JSON.parse(readFileSync(new URL('../resources/' + path, import.meta.url), 'utf8'));
async function fixture() {
  const profile = featureProfileSchema.parse(read('feature-profile/expanded-191-v5.json'));
  const initial = buildInitialWorld({
    seed: 'nation-lifecycle-public-profile',
    map: read('map/san10.json'),
    scenario: (await expandedScenarioRow()).content,
    unitSet: read('unitset/expanded.json'),
    statRules: read('scenario/five-stats.json'),
    portraitMap: read('portraits/191-map.json'),
  });
  initial.ruleFeatures = profile.ruleFeatures;
  initial.scenarioKey = profile.scenarioKey;
  initial.generals = applySexLedger(initial, loadSexLedger());
  const replay = initialReplayStateWithRegistry(initial, ruleRegistry, {
    ...profile.featureData,
    policy: { version: 1, turnTermMinutes: 60 },
  });
  const state = replay.state;
  const ruler = Object.values(state.generals).find(
    (general) =>
      general.officerLevel === 12 &&
      Object.values(state.generals).filter((row) => row.nationId === general.nationId).length >= 3,
  )!;
  const members = Object.values(state.generals).filter((general) => general.nationId === ruler.nationId);
  const ownCity = state.cities[state.nations[ruler.nationId!]!.capitalCityKey]!;
  const destination = ownCity.connections.map((key) => state.cities[key]!).find((city) => city.kind !== 'PASS')!;
  // 공개 원생성 뒤의 제어된 상태 전이 시험이다. HTTP 입력·원생성 재생 증거는 별도로 검증한다.
  state.diplomacies = [];
  ruler.cityKey = ownCity.cityKey;
  ruler.userId = 'ruler';
  state.nations[ruler.nationId!]!.isNpc = false;
  const follower = members.find((general) => general.id !== ruler.id)!;
  follower.userId = 'human-follower';
  replay.residenceAnchors = { [ruler.id]: 0, [follower.id]: 0 };
  replay.policy!.lastActiveTicks = { [ruler.id]: 0, [follower.id]: 0 };
  const lieutenant = members.find((general) => general.id !== ruler.id && general.id !== follower.id)!;
  lieutenant.userId = null;
  lieutenant.cityKey = ruler.cityKey;
  state.campaign!.links.push({ masterId: ruler.id, personId: lieutenant.id, relation: 'LIEUTENANT' });
  state.campaign!.units = [
    { id: 1, ownerId: ruler.id, commanderId: lieutenant.id, troops: 100, crewType: 1, train: 50, atmos: 60 },
    { id: 2, ownerId: follower.id, commanderId: follower.id, troops: 200, crewType: 1, train: 70, atmos: 80 },
  ];
  state.campaign!.nextUnitId = 3;
  // 방랑 이동도 기존 인접·빈 도시 검사를 통과해야 한다.
  destination.nationId = null;
  destination.level = 5;
  for (const member of members) Object.assign(member, { gold: 5000, rice: 6000 });
  return { initial, replay, ruler, follower, lieutenant, destination, ownCity, members };
}
function execute(
  state: WorldState,
  generalId: number,
  key: string,
  args: unknown,
  unitSet: Awaited<ReturnType<typeof fixture>>['initial']['unitSet'],
  tick: number,
) {
  const before = structuredClone(state);
  const result = resolverForRuleFeatures(state)!.run(
    state,
    { generalId, tick, unitSet },
    key,
    args,
    rngFor('lifecycle-test', tick, key),
  );
  expect(state).toEqual(before);
  if ('code' in result) throw Error(result.message);
  return applyEffects(state, result.effects);
}
function assertAll(state: WorldState, tick: number) {
  assertNationLifecycle(state);
  assertGovernanceFinal(state, tick);
  assertLineageFinal(state, tick);
  readCampaignState(state.campaign, state);
  readCityResourcesState(state.cityResources, state);
  readLogisticsState(state.logistics, state);
  readStratagemCardsState(state.stratagemCards, state);
}

it('AC-P2-08·09 새 20기능 판은 기존 v4 자원·설정을 보존하고 빈 방랑 원장으로 시작한다', async () => {
  const previous = read('feature-profile/expanded-191-v4.json');
  expect(read('feature-profile/expanded-191-v5.json')).toEqual({
    ...previous,
    key: 'expanded-191-v5',
    ruleFeatures: [...previous.ruleFeatures, 'nation-lifecycle-v1'].sort(),
  });
  const f = await fixture();
  expect(f.initial.generals).toHaveLength(491);
  expect(f.initial.ruleFeatures).toHaveLength(20);
  expect(f.replay.state.nationLifecycle).toEqual({ version: 1, nations: {} });
  assertAll(f.replay.state, 0);
});

it('AC-P2-08·09 20기능에서 방랑의 수비·함정 정리, 사람·NPC 동행, 재정착, 해산을 함께 검증한다', async () => {
  const f = await fixture();
  const nationId = f.ruler.nationId!,
    tick = 250000;
  const originalNation = structuredClone(f.replay.state.nations[nationId]);
  f.replay.state.cityResources!.cities[f.ownCity.cityKey]!.garrison = [
    { crewType: 1, troops: 100, train: 50, atmos: 50 },
  ];
  f.replay.state.stratagemCards!.nations[nationId]!.traps = [{ cityKey: f.ownCity.cityKey, setTick: 0 }];
  let state = execute(f.replay.state, f.ruler.id, 'wander', {}, f.initial.unitSet, tick);
  assertAll(state, tick);
  expect(state.nations[nationId]).toEqual(originalNation);
  expect(state.cityResources!.cities[f.ownCity.cityKey]!.garrison).toEqual([]);
  expect(state.stratagemCards!.nations[nationId]!.traps).toEqual([]);
  expect(state.campaign!.units).toEqual(f.replay.state.campaign!.units);
  state = execute(state, f.ruler.id, 'move', { cityKey: f.destination.cityKey }, f.initial.unitSet, tick + 1);
  assertAll(state, tick + 1);
  for (const member of f.members) expect(state.generals[member.id]!.cityKey).toBe(f.destination.cityKey);
  state = execute(state, f.ruler.id, 'resettle', {}, f.initial.unitSet, tick + 2);
  assertAll(state, tick + 2);
  expect(state.cities[f.destination.cityKey]!.nationId).toBe(nationId);
  expect(state.nationLifecycle!.nations).toEqual({});
  state = execute(state, f.ruler.id, 'wander', {}, f.initial.unitSet, tick + 3);
  state = execute(state, f.ruler.id, 'disband', {}, f.initial.unitSet, tick + 4);
  assertAll(state, tick + 4);
  expect(state.nations[nationId]).toBeUndefined();
  for (const member of f.members) {
    expect(state.generals[member.id]).toMatchObject({ nationId: null, officerLevel: 0, gold: 1000, rice: 1000 });
    expect(state.generals[member.id]!.userId).toBe(member.userId);
  }
  expect(state.campaign!.links).toEqual(f.replay.state.campaign!.links);
  expect(state.campaign!.units.every((unit) => unit.troops === 0 && unit.train === 0 && unit.atmos === 0)).toBe(true);
  expect(state.stratagemCards!.nations[nationId]).toBeUndefined();
});

it('AC-P2-08·09 24개월 자동 해산은 전체 월간 기능 순서에서 직책·관할·가문·황실과 정합하다', async () => {
  const f = await fixture(),
    sinceTick = 125000;
  let replay = f.replay;
  let settled: ReturnType<typeof settleMonthlyFeatures> | undefined;
  for (let month = 1; month <= 37; month++) {
    const at = month * TICKS_PER_MONTH;
    if (month === 13) replay.state = execute(replay.state, f.ruler.id, 'wander', {}, f.initial.unitSet, sinceTick);
    const monthly = runMonthly(replay.state, at, rngFor(f.initial.seed, 'monthly-test', month));
    settled = settleMonthlyFeatures(
      replay,
      { ...replay, state: monthly.state, monthlyTick: at },
      at,
      ruleRegistry,
      f.initial.seed,
    );
    replay = settled.replay;
    assertAll(replay.state, at);
    if (month >= 13 && month <= 36) expect(replay.state.nations[f.ruler.nationId!]).toBeDefined();
  }
  const tick = 370000; // 시작 12만5천 tick에서 24개월을 넘긴 첫 월간 경계다.
  expect(replay.state.nations[f.ruler.nationId!]).toBeUndefined();
  expect(replay.state.nationLifecycle!.nations).toEqual({});
  expect(replay.state.officeTurns?.[f.ruler.nationId!]).toBeUndefined();
  expect(replay.offices?.[f.ruler.nationId!]).toBeUndefined();
  expect(settled!.effects['nation-lifecycle-v1']).toMatchObject({
    reports: expect.any(Array),
    history: [{ nationId: f.ruler.nationId, text: expect.any(String) }],
  });
  expect(replay.monthlyTick).toBe(tick);
  expect(tick - sinceTick).toBeGreaterThanOrEqual(24 * TICKS_PER_MONTH);
}, 30_000); // 정식491명·20기능의 연속37개월을 한 시험에서 실행한다.
