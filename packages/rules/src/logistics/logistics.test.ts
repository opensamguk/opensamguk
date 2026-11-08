import { createRng } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { CITY_RESOURCE_MAX, emptyCityResourcesState } from '../cityResources/state';
import { cloneWorld } from '../model/clone';
import { deepFreeze } from '../personnel/testFixture';
import { logisticsInputKind, logisticsResultSchema, validateLogisticsRecord } from './feature';
import { assertLogisticsConserved } from './ledger';
import { applyLogisticsInput, findLogisticsPath, settleLogisticsMonthly, type LogisticsInput } from './operations';
import { initialLogisticsState, readLogisticsState, type LogisticsConfig } from './state';
import type { RecordedInput, ReplayState } from '../replay';

const config: LogisticsConfig = {
  version: 1,
  specialties: [],
  capacity: { base: 100, perLevel: 100, maxLevel: 2 },
  upgrade: { gold: 50, wood: 10 },
  transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 1000, maxPerOrder: 100, maxActivePerNation: 2 },
  recruitPer100: { '1': { iron: 2, wood: 0, horses: 0 } },
  build: { wall: { iron: 0, wood: 10, horses: 0 }, defence: { iron: 5, wood: 5, horses: 0 } },
  trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
};
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['logistics-v1', 'city-resources-v1'];
  for (const city of Object.values(world.cities)) {
    city.nationId = 1;
    city.supplied = true;
  }
  world.generals[1]!.userId = 'player';
  world.cityResources = emptyCityResourcesState(world);
  world.cityResources.cities['1']!.gold = 1000;
  world.logistics = initialLogisticsState(config, world);
  world.logistics.cities['1'] = { iron: 60, wood: 30, horses: 10, level: 0 };
  return world;
}
const actor = { tick: 1, userId: 'player', userActive: true };
const dispatch: LogisticsInput = {
  type: 'dispatch',
  fromCityKey: 1,
  toCityKey: 4,
  goods: { iron: 40, wood: 10, horses: 0 },
};
function send(world = fixture()) {
  const result = applyLogisticsInput(deepFreeze(world), dispatch, 1, actor);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('AC-P2-30 물류 정본·수량 보존', () => {
  it('새 판은 빈 재고이며 금·쌀을 복제하지 않고 모든 가변 필드를 복제한다', () => {
    const world = fixture(),
      initial = initialLogisticsState(config, world);
    expect(initial.cities['1']).toEqual({ iron: 0, wood: 0, horses: 0, level: 0 });
    expect(initial).not.toHaveProperty('gold');
    const clone = cloneWorld(deepFreeze(world));
    clone.logistics!.config.transport.maxHops = 1;
    clone.logistics!.cities['1']!.iron = 0;
    expect(world.logistics!.config.transport.maxHops).toBe(8);
    expect(world.logistics!.cities['1']!.iron).toBe(60);
    delete clone.logistics;
    expect(cloneWorld(clone)).not.toHaveProperty('logistics');
  });

  it('특산표의 거점만 인구 비율로 생산하고 합계 용량 초과분을 명시적 손실로 적는다', () => {
    const world = fixture();
    world.logistics!.config.specialties = [
      { cityKey: 1, good: 'iron', perMonth: 100 },
      { cityKey: 2, good: 'wood', perMonth: 100 },
    ];
    world.cities[2]!.supplied = false;
    const result = settleLogisticsMonthly(deepFreeze(world), 10_000);
    expect(result.state.logistics!.cities['1']!.iron).toBe(60);
    expect(result.state.logistics!.cities['2']!.wood).toBe(0);
    expect(result.movements).toEqual([
      { holder: 'city', id: 1, good: 'iron', delta: 40, reason: 'PRODUCE' },
      { holder: 'city', id: 1, good: 'iron', delta: -40, reason: 'LOSS_OVERFLOW' },
    ]);
    expect(() => settleLogisticsMonthly(result.state, 10_000)).toThrow('중복');
    expect(() => settleLogisticsMonthly(result.state, 30_000)).toThrow('순서');
    expect(world.logistics!.monthlyTick).toBe(0);
  });

  it('출발에서 재고를 한 번 빼고 경로 소요 뒤 도착·손실을 한 번 반영한다', () => {
    const started = send();
    expect(started.state.logistics!.cities['1']!.iron).toBe(20);
    expect(started.result).toMatchObject({ convoyId: 1, arriveTick: 20_000, path: [1, 2, 3, 4] });
    const first = settleLogisticsMonthly(deepFreeze(started.state), 10_000);
    expect(first.state.logistics!.convoys).toHaveLength(1);
    const second = settleLogisticsMonthly(deepFreeze(first.state), 20_000);
    expect(second.state.logistics!.convoys).toEqual([]);
    expect(second.state.logistics!.cities['4']).toEqual({ iron: 28, wood: 7, horses: 0, level: 0 });
    expect(second.movements.filter((row) => row.reason === 'LOSS_TRANSIT').map((row) => row.delta)).toEqual([-12, -3]);
    assertLogisticsConserved(first.state.logistics!, second.state.logistics!, second.movements);
  });

  it.each(['return', 'capture', 'lost'] as const)(
    '소유권·외교 변경에 따른 %s도 재화를 만들거나 지우지 않는다',
    (kind) => {
      const started = send().state;
      started.cities[4]!.nationId = kind === 'lost' ? null : 2;
      if (kind === 'return') started.diplomacies = [];
      if (kind === 'lost') started.cities[1]!.nationId = 2;
      const first = settleLogisticsMonthly(started, 10_000);
      const result = settleLogisticsMonthly(first.state, 20_000);
      expect(result.state.logistics!.convoys).toEqual([]);
      const reason = kind === 'return' ? 'RETURN' : kind === 'capture' ? 'CAPTURE' : 'LOSS_TRANSIT';
      expect(result.movements.every((row) => row.reason === reason)).toBe(true);
      if (kind === 'return') expect(result.state.logistics!.cities['1']!.iron).toBe(60);
      if (kind === 'capture') expect(result.state.logistics!.cities['4']!.iron).toBe(40);
      if (kind === 'lost') expect(result.movements.reduce((sum, row) => sum + row.delta, 0)).toBe(-50);
    },
  );

  it('중간 거점의 보급 단절은 출발지 반환이고 출발 시 경로를 속일 수 없다', () => {
    const started = send().state;
    started.cities[2]!.supplied = false;
    expect(findLogisticsPath(started, 1, 4, 1, 8)).toBeNull();
    const result = settleLogisticsMonthly(settleLogisticsMonthly(started, 10_000).state, 20_000);
    expect(result.state.logistics!.cities['1']!.iron).toBe(60);
    const malformed = send().state;
    malformed.logistics!.convoys[0]!.path = [1, 3, 4];
    expect(() => readLogisticsState(malformed.logistics, malformed)).toThrow();
  });

  it('취소 반환과 창고 초과 손실을 보존하고 중복 취소·국가별 한도를 거부한다', () => {
    const started = send().state;
    started.logistics!.cities['1']!.iron += 50;
    const result = applyLogisticsInput(started, { type: 'cancel', convoyId: 1 }, 1, actor);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.logistics!.cities['1']!.iron).toBe(70);
    expect(
      result.result.movements.filter((row) => row.reason === 'LOSS_OVERFLOW').reduce((sum, row) => sum + row.delta, 0),
    ).toBe(-50);
    expect(applyLogisticsInput(result.state, { type: 'cancel', convoyId: 1 }, 1, actor)).toMatchObject({
      ok: false,
      code: 'BAD_TARGET',
    });
    const limited = send().state;
    limited.logistics!.config.transport.maxActivePerNation = 1;
    expect(
      applyLogisticsInput(limited, { ...dispatch, goods: { iron: 1, wood: 0, horses: 0 } }, 1, actor),
    ).toMatchObject({ ok: false, code: 'LIMIT' });
  });

  it('증축과 교역은 같은 도시 금 원장과 재고를 함께 바꾸고 부족·저장 한도를 검사한다', () => {
    const world = fixture(),
      upgrade = applyLogisticsInput(deepFreeze(world), { type: 'upgrade', cityKey: 1 }, 1, actor);
    if (!upgrade.ok) throw new Error(upgrade.message);
    expect(upgrade.state.cityResources!.cities['1']!.gold).toBe(950);
    expect(upgrade.state.logistics!.cities['1']).toMatchObject({ wood: 20, level: 1 });
    const buy = applyLogisticsInput(
      upgrade.state,
      { type: 'trade', cityKey: 1, side: 'buy', good: 'horses', amount: 20 },
      1,
      actor,
    );
    if (!buy.ok) throw new Error(buy.message);
    expect(buy.state.cityResources!.cities['1']!.gold).toBe(890);
    expect(buy.state.logistics!.cities['1']!.horses).toBe(30);
    const exhausted = fixture();
    exhausted.cityResources!.cities['1']!.gold = CITY_RESOURCE_MAX;
    expect(
      applyLogisticsInput(exhausted, { type: 'trade', cityKey: 1, side: 'sell', good: 'iron', amount: 1 }, 1, actor),
    ).toMatchObject({ ok: false, code: 'LIMIT' });
    expect(
      applyLogisticsInput(
        world,
        { type: 'trade', cityKey: 1, side: 'buy', good: 'iron', amount: CITY_RESOURCE_MAX },
        1,
        actor,
      ),
    ).toMatchObject({ ok: false, code: 'NO_GOLD' });
    expect(world.cityResources!.cities['1']!.gold).toBe(1000);
    expect(world.nations).toEqual(upgrade.state.nations);
    expect(world.generals).toEqual(upgrade.state.generals);
  });

  it.each(['inactive', 'foreign', 'rank', 'future', 'disabled', 'input'] as const)(
    '%s 거부는 원본과 재고를 바꾸지 않는다',
    (kind) => {
      const world = fixture(),
        context = { ...actor };
      if (kind === 'inactive') context.userActive = false;
      if (kind === 'foreign') context.userId = 'another';
      if (kind === 'rank') world.generals[1]!.officerLevel = 4;
      if (kind === 'future') world.generals[1]!.activeFromYear = 200;
      if (kind === 'disabled') world.ruleFeatures = [];
      const before = structuredClone(world);
      expect(
        applyLogisticsInput(
          deepFreeze(world),
          kind === 'input' ? { ...dispatch, goods: { iron: -1, wood: 0, horses: 0 } } : dispatch,
          1,
          context,
        ).ok,
      ).toBe(false);
      expect(world).toEqual(before);
    },
  );

  it('설정·정본의 중복/누락/범위와 보유처별 위조를 거부한다', () => {
    const world = fixture();
    expect(() =>
      initialLogisticsState({ ...config, specialties: [{ cityKey: 9, good: 'iron', perMonth: 1 }] }, world),
    ).toThrow();
    const corrupt = structuredClone(world.logistics!);
    delete corrupt.cities['4'];
    expect(() => readLogisticsState(corrupt, world)).toThrow();
    const wrong = structuredClone(world.logistics!);
    wrong.cities['1']!.iron--;
    wrong.cities['2']!.iron++;
    expect(() => assertLogisticsConserved(world.logistics!, wrong, [])).toThrow('보존');
  });

  it('수량을 맞춰도 출발·도착의 보유처 방향을 뒤집은 원장은 거부한다', () => {
    const world = fixture(),
      result = send(world);
    expect(() =>
      assertLogisticsConserved(
        result.state.logistics!,
        world.logistics!,
        result.result.movements.map((row) => ({ ...row, delta: -row.delta })),
      ),
    ).toThrow('방향');
    for (const reason of ['ARRIVE', 'RETURN', 'CAPTURE'] as const)
      expect(() =>
        assertLogisticsConserved(
          world.logistics!,
          result.state.logistics!,
          result.result.movements.map((row) => ({ ...row, reason })),
        ),
      ).toThrow('방향');
  });

  it.each(['PRODUCE', 'TRADE', 'UPGRADE'] as const)(
    'AC-P2-30 수량이 맞아도 보유처에 맞지 않는 %s 기록은 거부한다',
    (reason) => {
      const world = fixture();
      const result = send(world);
      const reverse = reason === 'UPGRADE';
      const before = world.logistics!;
      const after = result.state.logistics!;
      const movements = result.result.movements.map((row) => ({
        ...row,
        delta: reverse ? -row.delta : row.delta,
        reason: row.holder === 'convoy' ? reason : ('TRADE' as const),
      }));
      expect(() => assertLogisticsConserved(reverse ? after : before, reverse ? before : after, movements)).toThrow(
        '사유와 보유처',
      );
    },
  );

  it('AC-P2-30 도시 재고 감소를 수송 중 손실로 기록할 수 없다', () => {
    const before = fixture().logistics!;
    const after = structuredClone(before);
    after.cities['1']!.iron--;
    expect(() =>
      assertLogisticsConserved(before, after, [
        { holder: 'city', id: 1, good: 'iron', delta: -1, reason: 'LOSS_TRANSIT' },
      ]),
    ).toThrow('사유와 보유처');
  });

  it('같은 입력의 처리 결과를 재현하고 결과 수량·tick 위조를 거부한다', () => {
    const world = fixture(),
      result = send(world),
      replay = { state: world } as ReplayState;
    const input: RecordedInput = {
      kind: 'logistics.order',
      sequence: 1,
      tick: 1,
      generalId: 1,
      status: 'APPLIED',
      payload: dispatch,
      result: logisticsResultSchema.parse(result.result),
    };
    expect(logisticsInputKind.apply(replay, input).state).toEqual(result.state);
    expect(() => validateLogisticsRecord({ ...input, tick: 2 })).toThrow();
    const forged = structuredClone(input);
    (forged.result as { movements: { delta: number }[] }).movements[0]!.delta++;
    expect(() => logisticsInputKind.apply(replay, forged)).toThrow('재현');
  });

  it('고정 시드 300개 입력열에서 재고·화물과 이동 기록을 대조하고 다시 실행해 같은 결과를 얻는다', () => {
    function run() {
      let world = fixture();
      const random = createRng('logistics-conservation');
      for (let index = 0; index < 300; index++) {
        if (index % 20 === 19) {
          world = settleLogisticsMonthly(world, world.logistics!.monthlyTick + 10_000).state;
          continue;
        }
        const good = random.pick(['iron', 'wood', 'horses'] as const),
          amount = random.int(1, 10);
        const input: LogisticsInput =
          random.int(0, 1) === 0
            ? {
                type: 'trade',
                cityKey: random.pick([1, 4]),
                good,
                side: random.pick(['buy', 'sell'] as const),
                amount,
              }
            : {
                type: 'dispatch',
                fromCityKey: random.pick([1, 4]),
                toCityKey: random.pick([1, 4]),
                goods: { iron: 0, wood: 0, horses: 0, [good]: amount },
              };
        const outcome = applyLogisticsInput(world, input, 1, { ...actor, tick: world.logistics!.monthlyTick + 1 });
        if (outcome.ok) {
          assertLogisticsConserved(world.logistics!, outcome.state.logistics!, outcome.result.movements);
          world = outcome.state;
        }
      }
      return world;
    }
    expect(run()).toEqual(run());
  });
});
