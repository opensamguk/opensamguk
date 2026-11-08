import { z } from 'zod';
import { CITY_RESOURCE_MAX } from '../cityResources/state';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';

export const LOGISTICS_GOODS = ['iron', 'wood', 'horses'] as const;
export const LOGISTICS_MAX_CONVOYS = 100_000;
export const logisticsQuantity = z.number().int().min(0).max(CITY_RESOURCE_MAX);
const identifier = logisticsQuantity.min(1);
export const logisticsGoodsSchema = z.strictObject({
  iron: logisticsQuantity,
  wood: logisticsQuantity,
  horses: logisticsQuantity,
});
export type LogisticsGoods = z.infer<typeof logisticsGoodsSchema>;
export type LogisticsGood = (typeof LOGISTICS_GOODS)[number];
export const emptyLogisticsGoods = (): LogisticsGoods => ({ iron: 0, wood: 0, horses: 0 });
export const logisticsTotal = (goods: Readonly<LogisticsGoods>): number => goods.iron + goods.wood + goods.horses;

const priceSchema = z
  .strictObject({ buy: identifier, sell: identifier })
  .refine((row) => row.sell <= row.buy, '매도가가 매입가보다 높습니다.');

export const logisticsConfigSchema = z
  .strictObject({
    version: z.literal(1),
    specialties: z
      .array(
        z.strictObject({
          cityKey: identifier,
          good: z.enum(LOGISTICS_GOODS),
          perMonth: logisticsQuantity.min(1),
        }),
      )
      .max(10_000)
      .refine((rows) => new Set(rows.map((row) => row.cityKey)).size === rows.length, '특산 거점이 중복됐습니다.')
      .transform((rows) => rows.sort((a, b) => a.cityKey - b.cityKey)),
    capacity: z
      .strictObject({ base: identifier, perLevel: identifier, maxLevel: logisticsQuantity.max(100) })
      .refine(
        (value) => BigInt(value.base) + BigInt(value.perLevel) * BigInt(value.maxLevel) <= BigInt(CITY_RESOURCE_MAX),
        '창고 용량 한도를 넘었습니다.',
      ),
    upgrade: z.strictObject({ gold: identifier, wood: identifier }),
    transport: z.strictObject({
      maxHops: identifier.max(128),
      hopsPerMonth: identifier.max(128),
      lossBpPerHop: logisticsQuantity.max(10_000),
      maxPerOrder: identifier,
      maxActivePerNation: identifier.max(100),
    }),
    recruitPer100: z.record(z.string().regex(/^[1-9]\d*$/), logisticsGoodsSchema),
    build: z.strictObject({ wall: logisticsGoodsSchema, defence: logisticsGoodsSchema }),
    trade: z.strictObject({ iron: priceSchema, wood: priceSchema, horses: priceSchema }),
    npc: z
      .strictObject({
        recruitTarget: identifier
          .min(100)
          .max(2000)
          .refine((amount) => amount % 100 === 0),
        budgetBp: identifier.max(10_000),
        treasuryBudgetBp: identifier.max(10_000).optional(),
        maxActions: identifier.max(3),
        stockCapBp: identifier.max(10_000),
        upgradeAtBp: identifier.max(10_000),
      })
      .transform(({ treasuryBudgetBp, ...settings }) => {
        const withoutCap: typeof settings & { treasuryBudgetBp?: never } = settings;
        return treasuryBudgetBp === undefined ? withoutCap : { ...settings, treasuryBudgetBp };
      })
      .optional(),
  })
  .transform(({ npc, ...config }) => (npc === undefined ? config : { ...config, npc }));
export type LogisticsConfig = z.infer<typeof logisticsConfigSchema>;
const convoySchema = z.strictObject({
  id: identifier,
  nationId: identifier,
  fromCityKey: identifier,
  toCityKey: identifier,
  path: z.array(identifier).min(2).max(129),
  goods: logisticsGoodsSchema,
  departTick: logisticsQuantity,
  arriveTick: identifier,
});
export const logisticsStateSchema = z.strictObject({
  version: z.literal(1),
  config: logisticsConfigSchema,
  revision: logisticsQuantity,
  monthlyTick: logisticsQuantity,
  nextConvoyId: identifier,
  cities: z.record(z.string().regex(/^[1-9]\d*$/), logisticsGoodsSchema.extend({ level: logisticsQuantity })),
  convoys: z.array(convoySchema).max(LOGISTICS_MAX_CONVOYS),
});
export type LogisticsState = z.infer<typeof logisticsStateSchema>;
export type LogisticsConvoy = z.infer<typeof convoySchema>;
type CityWorld = Pick<WorldView, 'cities'>;

export function logisticsCapacity(config: Pick<LogisticsConfig, 'capacity'>, level: number): number {
  logisticsQuantity.max(config.capacity.maxLevel).parse(level);
  return config.capacity.base + config.capacity.perLevel * level;
}

export function readLogisticsConfig(value: unknown, world: CityWorld): LogisticsConfig {
  const config = logisticsConfigSchema.parse(value);
  if (config.specialties.some((row) => !world.cities[row.cityKey] || world.cities[row.cityKey]!.kind === 'PASS'))
    throw new Error('특산 생산 거점이 없거나 관문입니다.');
  return config;
}

export function readLogisticsState(value: unknown, world: CityWorld): LogisticsState {
  const state = logisticsStateSchema.parse(value);
  readLogisticsConfig(state.config, world);
  const keys = Object.keys(world.cities);
  if (
    keys.length !== Object.keys(state.cities).length ||
    keys.some((key) => String(world.cities[Number(key)]?.cityKey) !== key || !Object.hasOwn(state.cities, key))
  )
    throw new Error('물류 재고와 월드 거점의 대응이 다릅니다.');
  if (state.monthlyTick % TICKS_PER_MONTH !== 0) throw new Error('물류 월 정산 tick을 확인하세요.');
  for (const city of Object.values(state.cities))
    if (logisticsTotal(city) > logisticsCapacity(state.config, city.level))
      throw new Error('창고 전체 재고가 용량을 넘었습니다.');
  const ids = new Set<number>(),
    nations = new Map<number, number>();
  for (const convoy of state.convoys) {
    const hops = convoy.path.length - 1;
    if (
      ids.has(convoy.id) ||
      convoy.id >= state.nextConvoyId ||
      convoy.fromCityKey === convoy.toCityKey ||
      convoy.path[0] !== convoy.fromCityKey ||
      convoy.path.at(-1) !== convoy.toCityKey ||
      new Set(convoy.path).size !== convoy.path.length ||
      convoy.path.some((key) => !world.cities[key]) ||
      convoy.path.some(
        (key, index) => index > 0 && !world.cities[convoy.path[index - 1]!]!.connections.includes(key),
      ) ||
      hops > state.config.transport.maxHops ||
      logisticsTotal(convoy.goods) < 1 ||
      logisticsTotal(convoy.goods) > state.config.transport.maxPerOrder ||
      convoy.departTick < 0 ||
      convoy.departTick >= state.monthlyTick + TICKS_PER_MONTH ||
      convoy.arriveTick <= state.monthlyTick ||
      convoy.arriveTick !==
        (Math.floor(convoy.departTick / TICKS_PER_MONTH) + Math.ceil(hops / state.config.transport.hopsPerMonth)) *
          TICKS_PER_MONTH
    )
      throw new Error('수송대의 번호·경로·수량·도착 tick을 확인하세요.');
    ids.add(convoy.id);
    const count = (nations.get(convoy.nationId) ?? 0) + 1;
    if (count > state.config.transport.maxActivePerNation) throw new Error('국가의 수송대 한도를 넘었습니다.');
    nations.set(convoy.nationId, count);
  }
  state.convoys.sort((a, b) => a.id - b.id);
  return state;
}

export function initialLogisticsState(value: unknown, world: CityWorld): LogisticsState {
  return readLogisticsState(
    {
      version: 1,
      config: readLogisticsConfig(value, world),
      revision: 0,
      monthlyTick: 0,
      nextConvoyId: 1,
      cities: Object.fromEntries(Object.keys(world.cities).map((key) => [key, { ...emptyLogisticsGoods(), level: 0 }])),
      convoys: [],
    },
    world,
  );
}
