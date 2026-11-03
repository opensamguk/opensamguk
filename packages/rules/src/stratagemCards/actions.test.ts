import { expect, it } from 'vitest';
import { commandInitial, commandWorld } from '../../test/commandFixture';
import type { ReplayState, RecordedInput } from '../replay';
import { decideStratagemCardsAction } from './actions';
import { initialStratagemCards } from './state';
import { TEST_STRATAGEM_CARDS_CONFIG } from './testFixture';
import { stratagemCardsFeature, stratagemCardsInputKind } from './feature';

const payload = { type: 'trap.set', nationId: 1, cityKey: 1 };
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats', 'stratagem-basic', 'stratagem-cards-v1'];
  world.generals[1]!.userId = 'owner';
  world.stratagemCards = initialStratagemCards(TEST_STRATAGEM_CARDS_CONFIG, world, 'action-fixture');
  world.stratagemCards.nations[1]!.hand = ['trap'];
  return world;
}

it('AC-P2-23 군주는 함정 패를 설치로 바꾸며 재화·장수·원본을 바꾸지 않는다', () => {
  const world = fixture(),
    before = structuredClone(world),
    result = decideStratagemCardsAction(world, 1, payload, 0);
  if (!result.ok) throw Error(result.message);
  expect(result.state.stratagemCards!.nations[1]).toEqual({ hand: [], traps: [{ cityKey: 1, setTick: 0 }] });
  expect(result.result).toEqual({ action: 'trap.set', revision: 1, tick: 0 });
  expect(result.state.generals).toEqual(before.generals);
  expect(result.state.nations).toEqual(before.nations);
  expect(world).toEqual(before);
});

it('AC-P2-23 소속·군주·패·거점·중복 검사를 보존한다', () => {
  const world = fixture();
  expect(decideStratagemCardsAction(world, 4, payload, 0)).toMatchObject({ code: 'NATION_CHANGED' });
  expect(decideStratagemCardsAction(world, 3, { ...payload, nationId: 2 }, 0)).toMatchObject({ code: 'FORBIDDEN' });
  expect(decideStratagemCardsAction(world, 1, { ...payload, cityKey: 2 }, 0)).toMatchObject({ code: 'BAD_CITY' });
  expect(decideStratagemCardsAction(world, 1, { ...payload, extra: true }, 0)).toMatchObject({ code: 'BAD_ARGS' });
  world.stratagemCards!.nations[1]!.traps = [{ cityKey: 1, setTick: 0 }];
  expect(decideStratagemCardsAction(world, 1, payload, 0)).toMatchObject({ code: 'TRAP_EXISTS' });
  world.stratagemCards!.nations[1]!.hand = [];
  expect(decideStratagemCardsAction(world, 1, { ...payload, cityKey: 2 }, 0)).toMatchObject({ code: 'NO_TRAP_CARD' });
});

it('AC-P2-23 꺼진 기능·등장 전·잘못된 월·변경 한도는 상태를 바꾸지 않는다', () => {
  expect(decideStratagemCardsAction(commandWorld(), 1, payload, 0)).toMatchObject({ code: 'FEATURE_DISABLED' });
  const world = fixture();
  world.generals[1]!.activeFromYear = 210;
  expect(decideStratagemCardsAction(world, 1, payload, 0)).toMatchObject({ code: 'NO_GENERAL' });
  world.generals[1]!.activeFromYear = 175;
  expect(decideStratagemCardsAction(world, 1, payload, 10_000)).toMatchObject({ code: 'BAD_TICK' });
  world.stratagemCards!.revision = 2_147_483_647;
  const before = structuredClone(world);
  expect(decideStratagemCardsAction(world, 1, payload, 0)).toMatchObject({ code: 'LIMIT' });
  expect(world).toEqual(before);
});

it.each([
  { consumeOnRollFailure: false },
  { campaignLoss: 'eligibleFirst' },
  { setter: 'chiefs' },
  { deck: [{ kind: 'nation_raid', weight: 1 }] },
])('AC-P2-23 아직 구현하지 않은 config %j는 원생성에서 거부한다', (change) => {
  expect(() =>
    stratagemCardsFeature.checkOrigin!({
      initial: commandInitial(),
      data: { version: 1, config: { ...TEST_STRATAGEM_CARDS_CONFIG, ...change } },
    }),
  ).toThrow();
});

it('AC-P2-23 실제 월간 뽑기 뒤의 설치 기록은 같은 결과로 재현되고 변조는 거부된다', () => {
  const world = commandWorld(),
    initial = commandInitial();
  world.ruleFeatures = ['five-stats', 'stratagem-basic', 'stratagem-cards-v1'];
  world.generals[1]!.userId = 'owner';
  const start: ReplayState = { state: world, turns: { 1: [] }, revisions: { 1: 0 }, monthlyTick: 0 },
    data = { version: 1, config: { ...TEST_STRATAGEM_CARDS_CONFIG, deck: [{ kind: 'trap', weight: 1 }] } };
  stratagemCardsFeature.checkOrigin!({ initial, data });
  const initialized = stratagemCardsFeature.initReplayState!(start, { initial, data }),
    month = stratagemCardsFeature.settleMonthly!({
      before: initialized,
      settled: { ...initialized, monthlyTick: 10_000 },
      tick: 10_000,
    }).replay,
    result = decideStratagemCardsAction(month.state, 1, payload, 10_000);
  if (!result.ok) throw Error(result.message);
  const input: RecordedInput = {
      sequence: 1,
      tick: 10_000,
      generalId: 1,
      kind: 'stratagem-cards.act',
      status: 'APPLIED',
      payload,
      result: result.result,
    },
    applied = stratagemCardsInputKind.apply(month, input);
  expect(applied).toEqual({ ...month, state: result.state });
  expect(applied.turns).toBe(month.turns);
  expect(applied.revisions).toBe(month.revisions);
  expect(() => stratagemCardsInputKind.apply(month, { ...input, result: { ...result.result, revision: 99 } })).toThrow(
    '재현',
  );
  expect(() => stratagemCardsInputKind.apply(month, { ...input, result: { ...result.result, tick: 0 } })).toThrow(
    '시각',
  );
  const rejected: RecordedInput = {
    ...input,
    generalId: null,
    status: 'REJECTED',
    result: { code: 'FORBIDDEN', message: '거부' },
  };
  expect(stratagemCardsInputKind.apply(month, rejected)).toBe(month);
  expect(() => stratagemCardsFeature.settleMonthly!({ before: start, settled: month, tick: 20_000 })).toThrow(
    '정산 시각',
  );
});

it('AC-P2-23 direct 입력 뒤에는 시계만 앞섰다는 이유로 만료·revision을 바꾸지 않는다', () => {
  const world = fixture();
  world.stratagemCards!.nations[1] = { hand: [], traps: [{ cityKey: 1, setTick: 0 }] };
  world.stratagemCards!.config.trapExpiryMonths = 1;
  const before: ReplayState = { state: world, turns: {}, revisions: {}, monthlyTick: 0 },
    input: RecordedInput = {
      sequence: 1,
      tick: 15_000,
      generalId: 1,
      kind: 'nationTurns.set',
      status: 'APPLIED',
      payload: {},
      result: {},
    },
    result = stratagemCardsFeature.afterAppliedInput!(before, before, input, { route: 'direct' });
  expect(result).toEqual(before);
  expect(result.state.stratagemCards!.revision).toBe(0);
});

it('AC-P2-23 queued 입력의 소유 변경 뒤 함정을 같은 프레임에서 정리한다', () => {
  const world = fixture();
  world.stratagemCards!.nations[1] = { hand: [], traps: [{ cityKey: 1, setTick: 0 }] };
  const before: ReplayState = { state: world, turns: {}, revisions: {}, monthlyTick: 0 },
    after = structuredClone(before);
  // 다른 입력이 이미 적용된 소유 상태 고정물이다. 입력 자체의 재생 증거가 아니다.
  after.state.cities[4]!.nationId = 1;
  after.state.nations[1]!.capitalCityKey = 4;
  after.state.cities[1]!.nationId = 2;
  const input: RecordedInput = {
      sequence: 1,
      tick: 100,
      generalId: 1,
      kind: 'campaign.order',
      status: 'APPLIED',
      payload: {},
      result: {},
    },
    result = stratagemCardsFeature.afterAppliedInput!(before, after, input, { route: 'queued' });
  expect(result.state.stratagemCards!.nations[1]!.traps).toEqual([]);
  expect(result.state.stratagemCards!.revision).toBe(1);
  expect(before.state.stratagemCards!.nations[1]!.traps).toHaveLength(1);
  expect(stratagemCardsFeature.requires).toContain('personnel');
});
