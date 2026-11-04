import { TICKS_PER_MONTH } from '../clock/constants';
import { governanceMonarchs } from '../governance/realm';
import type { WorldView } from '../model/world';
import { readStratagemCardsState } from './state';

// 타국 상태와 RNG 시드는 반환하지 않는다. 반환한 배열도 저장 상태와 공유하지 않는다.
export function stratagemCardsView(world: WorldView, actorId: number | null, tick: number) {
  const cards = readStratagemCardsState(world.stratagemCards, world),
    actor = actorId === null ? undefined : world.generals[actorId],
    nationId = actor?.nationId ?? null,
    own = nationId === null ? undefined : cards.nations[nationId];
  const active = !!actor && actor.activeFromYear <= world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
  return {
    capacity: cards.config.capacity,
    hand: own ? [...own.hand] : [],
    traps: own ? own.traps.map((trap) => ({ ...trap, cityName: world.cities[trap.cityKey]!.name })) : [],
    mine:
      actor && nationId !== null && own
        ? {
            generalId: actor.id,
            nationId,
            active,
            canSetTrap: active && governanceMonarchs(world, tick).get(nationId) === actor.id,
          }
        : null,
  };
}
