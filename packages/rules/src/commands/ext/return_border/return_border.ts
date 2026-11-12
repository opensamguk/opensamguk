import type { WorldView } from '../../../model/world';
import { isWandering } from '../../../nationLifecycle/state';
import { defineCommand, fail, noArgs, success } from '../../support';

function nearestOwnCities(view: WorldView, from: number, nationId: number): number[] {
  const visited = new Set([from]);
  let frontier = [from];
  for (let distance = 1; distance <= 3 && frontier.length; distance++) {
    const next: number[] = [];
    for (const cityKey of frontier) {
      for (const neighbor of view.cities[cityKey]?.connections ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    const supplied = next.filter((cityKey) => {
      const city = view.cities[cityKey];
      return city?.nationId === nationId && city.supplied;
    });
    if (supplied.length) return supplied.sort((a, b) => a - b);
    frontier = next;
  }
  return [];
}

export const returnBorder = defineCommand({
  key: 'return_border',
  name: '접경귀환',
  category: 'military',
  args: noArgs,
  check(view, actor) {
    const general = view.generals[actor.generalId]!;
    const { cityKey, nationId } = general;
    if (nationId === null || !view.nations[nationId]) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
    if (isWandering(view, nationId)) return fail('BAD_STATE', '방랑 중인 국가는 접경귀환할 수 없습니다.');
    if (view.cities[cityKey]?.nationId === nationId) return fail('BAD_STATE', '이미 자기 국가 도시에 있습니다.');
    return nearestOwnCities(view, cityKey, nationId).length
      ? null
      : fail('BAD_TARGET', '3칸 안에 돌아갈 자기 국가 도시가 없습니다.');
  },
  change(state, actor, _args, rng) {
    const general = state.generals[actor.generalId]!;
    general.cityKey = rng.pick(nearestOwnCities(state, general.cityKey, general.nationId!));
    return success(`${state.cities[general.cityKey]!.name} 접경귀환`);
  },
});
