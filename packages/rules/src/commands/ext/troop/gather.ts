import { defineCommand, fail, noArgs, ownCity, success } from '../../support';
import { readTroops } from './state';

export const troopGather = defineCommand({
  key: 'troop_gather',
  name: '집합',
  category: 'military',
  args: noArgs,
  check(view, actor) {
    const cityFailure = ownCity(view, actor);
    if (cityFailure) return cityFailure;
    const troop = readTroops(view)?.troops[actor.generalId];
    if (!troop) return fail('BAD_STATE', '부대장이 아닙니다.');
    return troop.members.length ? null : fail('BAD_STATE', '집합할 부대원이 없습니다.');
  },
  change(state, actor) {
    const troop = readTroops(state)!.troops[actor.generalId]!;
    const leader = state.generals[actor.generalId]!;
    const arrivals: string[] = [];
    for (const id of troop.members) {
      const member = state.generals[id]!;
      if (member.cityKey === leader.cityKey) continue;
      member.cityKey = leader.cityKey;
      arrivals.push(member.name);
    }
    leader.experience += 70;
    leader.dedication += 100;
    return success(
      arrivals.length
        ? `집합: ${arrivals.join(', ')} (${arrivals.length}명)`
        : '집합: 모든 부대원이 같은 도시에 있습니다.',
    );
  },
});
