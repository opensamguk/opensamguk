// D16, T2-07의 2026-10-24 승인 식. v1 군량매매의 이식이 아니다.
import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { DeepReadonly, WorldView } from '../model/world';
import type { TreatyState } from '../diplomacy/treatyTypes';
import { treatyClauseEndTick } from '../diplomacy/treaty';
import type { Actor, CommandDef, Failure } from './types';

type TradeRouteView = {
  cities: Readonly<Record<number, { nationId: number | null; connections: readonly number[]; kind?: 'CITY' | 'PASS' }>>;
  nations: Readonly<Record<number, unknown>>;
  diplomacies: readonly { nationA: number; nationB: number; state: string }[];
  treaties?: readonly DeepReadonly<TreatyState>[];
};
export type TradeRoute = { cityKey: number; treatyId: string; endTick: number };

// 공개 도시·관계·검증된 조약만으로 후보를 정한다. 상업과 국고는 읽지 않는다.
export function findTradeRoutes(view: TradeRouteView, nationId: number, cityKey: number, tick: number): TradeRoute[] {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('교역 시각을 확인하세요.');
  const home = view.cities[cityKey];
  if (!home || home.kind === 'PASS' || home.nationId !== nationId || !view.nations[nationId]) return [];
  const monthlyTick = Math.floor(tick / TICKS_PER_MONTH) * TICKS_PER_MONTH;
  const result: TradeRoute[] = [];
  for (const key of [...new Set(home.connections)].sort((a, b) => a - b)) {
    const target = view.cities[key];
    if (target?.kind === 'PASS') continue;
    const other = target?.nationId;
    if (other === undefined || other === null || other === nationId || !view.nations[other]) continue;
    if (
      view.diplomacies.some(
        (d) =>
          d.state === 'WAR' &&
          ((d.nationA === nationId && d.nationB === other) || (d.nationA === other && d.nationB === nationId)),
      )
    )
      continue;
    const treaty = view.treaties
      ?.filter(
        (t) =>
          t.status === 'ACTIVE' &&
          t.startTick !== null &&
          t.startTick <= tick &&
          ((t.fromNationId === nationId && t.toNationId === other) ||
            (t.fromNationId === other && t.toNationId === nationId)),
      )
      .sort((a, b) => a.id - b.id)
      .find((t) => {
        const clause = t.clauses.find((c) => c.kind === 'trade');
        return clause !== undefined && treatyClauseEndTick(t.startTick!, clause.months) > monthlyTick;
      });
    if (!treaty) continue;
    const clause = treaty.clauses.find((c) => c.kind === 'trade')!;
    result.push({
      cityKey: key,
      treatyId: String(treaty.id),
      endTick: treatyClauseEndTick(treaty.startTick!, clause.months),
    });
  }
  return result;
}

function homeFailure(view: WorldView, actor: Actor): Failure | null {
  const general = view.generals[actor.generalId];
  if (!general) return { code: 'NO_ACTOR', message: '장수가 없습니다.' };
  if (general.nationId === null || !view.nations[general.nationId])
    return { code: 'NOT_NATION', message: '국가에 소속되어야 합니다.' };
  if (view.cities[general.cityKey]?.nationId !== general.nationId)
    return { code: 'NOT_OWN_CITY', message: '자기 국가 도시에서만 가능합니다.' };
  if (actor.tick === undefined || !Number.isSafeInteger(actor.tick) || actor.tick < 0)
    return { code: 'BAD_STATE', message: '교역 시각을 확인하세요.' };
  return null;
}
const argsSchema = z.strictObject({ cityKey: z.number().int().min(1).max(2_147_483_647) });
type TradeArgs = z.infer<typeof argsSchema>;
function check(view: WorldView, actor: Actor, args: TradeArgs): Failure | null {
  const failure = homeFailure(view, actor);
  if (failure) return failure;
  const general = view.generals[actor.generalId]!;
  const target = view.cities[args.cityKey];
  if (!target || target.nationId === null || target.nationId === general.nationId)
    return { code: 'BAD_TARGET', message: '다른 국가의 도시를 고르세요.' };
  if (!view.cities[general.cityKey]!.connections.includes(args.cityKey))
    return { code: 'NOT_ADJACENT', message: '연결된 도시가 아닙니다.' };
  return findTradeRoutes(view, general.nationId!, general.cityKey, actor.tick!).some(
    (route) => route.cityKey === args.cityKey,
  )
    ? null
    : { code: 'BAD_STATE', message: '유효한 교역 조약이 없거나 교전 중입니다.' };
}

export const trade: CommandDef<TradeArgs> = {
  key: 'trade',
  name: '교역',
  category: 'domestic',
  target: 'general',
  args: argsSchema,
  precheck: homeFailure,
  check,
  execute(view, actor, args, rng) {
    const failure = check(view, actor, args);
    if (failure) throw new Error(failure.message);
    const general = view.generals[actor.generalId]!;
    const home = view.cities[general.cityKey]!;
    const target = view.cities[args.cityKey]!;
    const income = ((home.commerce + target.commerce) / 2) * 0.05 * (0.9 + 0.2 * rng.next());
    return {
      effects: [
        { kind: 'nation', id: general.nationId!, field: 'gold', op: 'add', value: income },
        { kind: 'nation', id: general.nationId!, field: 'rice', op: 'add', value: income },
        { kind: 'city', id: home.cityKey, field: 'commerce', op: 'add', value: home.commerce * 0.01 },
        { kind: 'city', id: home.cityKey, field: 'agriculture', op: 'add', value: home.agriculture * 0.01 },
        { kind: 'general', id: general.id, field: 'experience', op: 'add', value: 10 },
        { kind: 'general', id: general.id, field: 'dedication', op: 'add', value: 15 },
      ],
      logs: [{ kind: 'success', text: `${target.name} 교역: 국고 금 ${Math.round(income)}, 쌀 ${Math.round(income)}` }],
    };
  },
};
