import { expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandInitial, commandWorld, testUnits } from '../../test/commandFixture';
import { BALANCE } from '../balance';
import { DOMESTIC_SPECS } from '../commands/domestic/investment';
import { applyEffects } from '../commands/effects';
import { runCommand } from '../commands/registry';
import type { WorldState } from '../model/world';
import { initialReplayState, runReplayAction, settleReplayMonth, type RecordedInput } from '../replay';
import { reputationTurnEvents, reputationInputEvents } from './events';
import { reputationFeature } from './feature';
import { campaignAttack } from '../campaign/attack';
import { emptyCampaignState } from '../campaign/state';

function execute(before: WorldState, commandKey: string, generalId = 1, args: unknown = {}, unitSet = testUnits) {
  const rng = rngFor('reputation-event', commandKey);
  const result = runCommand(before, { generalId, tick: 7, unitSet }, commandKey, args, rng);
  const after = applyEffects(before, 'code' in result ? [] : result.effects);
  return { before, after, result, commandKey, generalId, tick: 7, rng };
}

it.each(DOMESTIC_SPECS)('T3-07 AC-M3-15 실제 $key가 최대치에 닿은 경우만 내정 평판이다', (spec) => {
  const before = commandWorld(),
    city = before.cities[1]!;
  if (spec.field === 'tech') before.nations[1]!.tech = BALANCE.MAX_TECH - 1;
  else city[spec.field] = (spec.field === 'trust' ? BALANCE.MAX_TRUST : city[`${spec.field}Max`]) - 1;
  const done = execute(before, spec.key);
  expect('code' in done.result).toBe(false);
  expect(reputationTurnEvents(done)).toMatchObject([
    { generalId: 1, kind: 'domestic', score: 2, data: { city: null } },
  ]);
  expect(reputationTurnEvents(execute(done.after, spec.key))).toEqual([]);
});

it('T3-07 AC-M3-15 실제 교전의 승패와 점령만 세며 기존 전투·난수는 같다', () => {
  const before = commandWorld();
  before.ruleFeatures = ['reputation-v1'];
  Object.assign(before.generals[1]!, { crew: 10000, rice: 100000, train: 100, atmos: 100 });
  Object.assign(before.generals[2]!, { crew: 1, rice: 10000, train: 100, atmos: 100 });
  before.generals[3]!.crew = 0;
  before.cities[2]!.wall = 0;
  const legacy = structuredClone(before);
  delete legacy.ruleFeatures;
  const done = execute(before, 'attack', 1, { cityKey: 2 });
  const old = execute(legacy, 'attack', 1, { cityKey: 2 });
  if ('code' in done.result || 'code' in old.result) throw Error('출병 고정물 실패');
  expect(done.result.battleOutcomes).toEqual([{ winnerId: 1, loserId: 2 }]);
  expect(old.result).not.toHaveProperty('battleOutcomes');
  expect(done.result.battleAwards).toEqual(old.result.battleAwards);
  expect(done.result.logs).toEqual(old.result.logs);
  expect(done.rng.next()).toBe(old.rng.next());
  const same = { ...done.after };
  delete same.ruleFeatures;
  expect(same).toEqual(old.after);
  const events = reputationTurnEvents(done);
  expect(events.map((row) => [row.generalId, row.kind])).toEqual([
    [1, 'victory'],
    [2, 'defeat'],
    [1, 'conquest'],
  ]);
  expect(events.find((row) => row.kind === 'defeat')?.data.nation?.id).toBe(2);
});

it('T3-07 AC-M3-15 공격 패배는 수비 승전과 공격 패전이다', () => {
  const before = commandWorld();
  before.ruleFeatures = ['reputation-v1'];
  Object.assign(before.generals[1]!, { crew: 1, rice: 100000, train: 100, atmos: 100 });
  Object.assign(before.generals[2]!, { crew: 10000, rice: 100000, train: 100, atmos: 100 });
  before.generals[3]!.crew = 0;
  const done = execute(before, 'attack', 1, { cityKey: 2 });
  expect(reputationTurnEvents(done).map((row) => [row.generalId, row.kind])).toEqual([
    [2, 'victory'],
    [1, 'defeat'],
  ]);
});

it('T3-07 AC-M3-15 수비 없는 도시 점령에 가짜 장수 승패를 더하지 않는다', () => {
  const before = commandWorld();
  before.ruleFeatures = ['reputation-v1'];
  before.generals[2]!.crew = 0;
  before.generals[3]!.crew = 0;
  before.cities[2]!.wall = 0;
  const done = execute(before, 'attack', 1, { cityKey: 2 });
  expect(reputationTurnEvents(done).map((row) => row.kind)).toEqual(['conquest']);
});

it('T3-07 AC-M3-15 하야와 검증된 파기만 배신이며 거절·다른 입력은 세지 않는다', () => {
  const before = commandWorld();
  expect(reputationTurnEvents(execute(before, 'resign', 3))).toMatchObject([{ generalId: 3, kind: 'betrayal' }]);
  expect(reputationTurnEvents(execute(before, 'accept_invite', 3))).toEqual([]);
  const input: RecordedInput = {
    sequence: 1,
    generalId: 1,
    kind: 'treaty.break',
    status: 'APPLIED',
    tick: 5,
    payload: {},
    result: {},
  };
  expect(reputationInputEvents({ before, input })).toMatchObject([{ generalId: 1, kind: 'betrayal', score: -3 }]);
  expect(reputationInputEvents({ before, input: { ...input, status: 'REJECTED' } })).toEqual([]);
  expect(reputationInputEvents({ before, input: { ...input, kind: 'offer.respond' } })).toEqual([]);
});

it('T3-07 AC-M3-15 중립 도시 점령과 동시 전멸에는 장수 승패가 없다', () => {
  const neutral = commandWorld();
  neutral.ruleFeatures = ['reputation-v1'];
  neutral.cities[2]!.nationId = null;
  neutral.cities[2]!.wall = 0;
  neutral.cities[3]!.nationId = 2;
  neutral.nations[2]!.capitalCityKey = 3;
  for (const id of [2, 3]) neutral.generals[id]!.cityKey = 3;
  expect(reputationTurnEvents(execute(neutral, 'attack', 1, { cityKey: 2 })).map((row) => row.kind)).toEqual([
    'conquest',
  ]);
  const draw = commandWorld(),
    units = structuredClone(testUnits);
  draw.ruleFeatures = ['reputation-v1'];
  draw.generals[1]!.crew = 1;
  draw.generals[2]!.crew = 1;
  draw.generals[3]!.crew = 0;
  for (const type of units.crewTypes) type.avoid = 0;
  const done = execute(draw, 'attack', 1, { cityKey: 2 }, units);
  expect(done.after.generals[1]!.crew).toBe(0);
  expect(done.after.generals[2]!.crew).toBe(0);
  expect(reputationTurnEvents(done)).toEqual([]);
});

it('T3-07 AC-M3-15 실제 부곡 교전은 싸운 지휘관에게만 승패를 준다', () => {
  const before = commandWorld();
  before.ruleFeatures = ['five-stats', 'reputation-v1'];
  for (const general of Object.values(before.generals)) Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  before.cities[2]!.wall = 0;
  before.campaign = emptyCampaignState(before, 'reputation-campaign', 'sourced-fixture');
  before.campaign.units = [
    { id: 1, ownerId: 1, commanderId: 1, troops: 9000, crewType: 1100, train: 100, atmos: 100 },
    { id: 2, ownerId: 2, commanderId: 2, troops: 1, crewType: 1100, train: 100, atmos: 100 },
  ];
  before.campaign.nextUnitId = 3;
  const actor = { generalId: 1, tick: 7, unitSet: testUnits };
  expect(campaignAttack.check(before, actor, { cityKey: 2 })).toBeNull();
  const result = campaignAttack.execute(before, actor, { cityKey: 2 }, rngFor('campaign-reputation'));
  expect(result.battleOutcomes).toEqual([{ winnerId: 1, loserId: 2 }]);
  const after = applyEffects(before, result.effects);
  expect(
    reputationTurnEvents({ before, after, generalId: 1, tick: 7, commandKey: 'attack', result }).map((row) => [
      row.generalId,
      row.kind,
    ]),
  ).toEqual([
    [1, 'victory'],
    [2, 'defeat'],
    [1, 'conquest'],
  ]);
});

it('T3-07 AC-M3-15 순수 재생에서 사건과 월단평을 같은 달에 남기고 기본 상태를 보존한다', () => {
  const initial = commandInitial();
  initial.nations[0]!.tech = BALANCE.MAX_TECH - 1;
  for (const general of initial.generals) general.nextTurnTick = general.id === 1 ? 0 : 10000;
  const old = initialReplayState(initial),
    enabled = initialReplayState({ ...initial, ruleFeatures: ['reputation-v1'] });
  old.turns[1]![0] = { commandKey: 'research', args: {} };
  enabled.turns[1]![0] = { commandKey: 'research', args: {} };
  const afterOld = runReplayAction(old, initial.seed, testUnits);
  const afterNew = runReplayAction(enabled, initial.seed, testUnits);
  expect(afterNew.reputation?.events).toMatchObject([{ kind: 'domestic', score: 2 }]);
  const settledOld = runReplayAction(afterOld, initial.seed, testUnits);
  const settledNew = runReplayAction(afterNew, initial.seed, testUnits);
  expect(settledNew.reputation?.reviews[0]?.entries[0]).toMatchObject({ generalId: 1, score: 2 });
  const same = { ...settledNew.state };
  delete same.ruleFeatures;
  expect(same).toEqual(settledOld.state);
  expect(settledOld).not.toHaveProperty('reputation');
  expect(settledNew.turns).toEqual(settledOld.turns);
  expect(settledNew.revisions).toEqual(settledOld.revisions);
  expect(() => settleReplayMonth(settledNew, initial.seed, 10000)).toThrow('같은 달');
  expect(() => reputationFeature.checkOrigin!({ initial, data: {} })).toThrow('빈 원장');
});
