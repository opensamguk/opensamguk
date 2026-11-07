import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import { applyHistoricDomesticEffects } from './effects';
import { initialHistoricEvents, readHistoricEventsConfig, settleHistoricEvents } from './state';
import type { HistoricEventsConfig } from './state';

type Event = HistoricEventsConfig['events'][number];
type Effects = Event['options'][number]['effects'];

const firedTick = 11 * TICKS_PER_MONTH;
const resolvedTick = 12 * TICKS_PER_MONTH;

function event(id: string, effects: Effects): Event {
  return {
    id,
    year: 191,
    month: 11,
    chooser: { nationId: 1, name: '국가1' },
    counterpart: null,
    title: id,
    text: id,
    options: [
      { label: '적용', effects },
      { label: '유지', effects: [] },
    ],
    defaultOption: 0,
    ref: '시험 자료',
  };
}

function resolve(world: ReturnType<typeof commandWorld>, events: Event[]) {
  const { startYear } = world;
  const config = readHistoricEventsConfig(
    { startYear, nations: Object.values(world.nations) },
    { events, windowMonths: 1 },
  );
  const context = { startYear, nationExists: (id: number) => !!world.nations[id] };
  const opened = settleHistoricEvents(initialHistoricEvents(), config, { ...context, tick: firedTick });
  return { config, ...settleHistoricEvents(opened.state, config, { ...context, tick: resolvedTick }) };
}

describe('AC-P2-21 역사 사건의 국고·사기 효과', () => {
  it('기한 정산 결과만 적용하고 국고를 저장 범위 안에 유지한다', () => {
    const world = commandWorld();
    world.nations[1]!.gold = 5;
    world.nations[1]!.rice = 2_147_483_645;
    const { config, resolved } = resolve(world, [
      event('A', [
        { kind: 'gold', value: -7 },
        { kind: 'rice', value: 7 },
      ]),
    ]);
    const next = applyHistoricDomesticEffects(world, config, resolved);
    expect(next.nations[1]).toMatchObject({ gold: 0, rice: 2_147_483_647 });
    expect(next.nations[2]).toEqual(world.nations[2]);
    expect(world.nations[1]).toMatchObject({ gold: 5, rice: 2_147_483_645 });
  });

  it('같은 달 여러 사건의 효과를 사건 ID 순서대로 적용한다', () => {
    const world = commandWorld();
    world.nations[1]!.gold = 5;
    const { config, resolved } = resolve(world, [
      event('B', [{ kind: 'gold', value: 3 }]),
      event('A', [{ kind: 'gold', value: -8 }]),
    ]);
    expect(applyHistoricDomesticEffects(world, config, resolved).nations[1]!.gold).toBe(3);
  });

  it.each([
    [-10, 0, 88],
    [10, 12, 100],
  ])('12월에 이미 등장한 소속 장수의 사기를 %i 조정한다', (value, low, high) => {
    const world = commandWorld();
    const general = world.generals[1]!;
    Object.assign(general, { atmos: 2, activeFromYear: 191 });
    world.generals[5] = { ...general, id: 5, atmos: 98 };
    world.generals[6] = { ...general, id: 6, activeFromYear: 192 };
    world.generals[7] = { ...general, id: 7, removedAt: firedTick };
    world.generals[8] = { ...general, id: 8, activeFromYear: LINEAGE_EXITED_YEAR };
    const { config, resolved } = resolve(world, [event('A', [{ kind: 'atmos', value }])]);
    const next = applyHistoricDomesticEffects(world, config, resolved);
    expect(next.generals[1]!.atmos).toBe(low);
    expect(next.generals[5]!.atmos).toBe(high);
    for (const id of [2, 3, 4, 6, 7, 8]) expect(next.generals[id]).toEqual(world.generals[id]);
  });

  it('선택 없이 닫힌 사건과 효과가 없는 선택지는 월드를 그대로 돌려준다', () => {
    const world = commandWorld();
    const { config, resolved } = resolve(world, [event('A', [{ kind: 'gold', value: 7 }])]);
    expect(applyHistoricDomesticEffects(world, config, [{ ...resolved[0]!, choice: null }])).toBe(world);
    expect(applyHistoricDomesticEffects(world, config, [{ ...resolved[0]!, choice: 1 }])).toBe(world);
  });
});
