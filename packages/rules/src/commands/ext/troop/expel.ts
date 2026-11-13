import { z } from 'zod';
import { defineCommand, fail, positive, success, targetGeneral } from '../../support';
import { readTroops } from './state';
import { troopOf } from './actions';

export const troopExpel = defineCommand({
  key: 'nation_troop_expel',
  name: '부대 탈퇴 지시',
  category: 'nation',
  target: 'nation',
  args: z.strictObject({ generalId: positive }),
  check(view, actor, args) {
    const source = view.generals[actor.generalId]!;
    const target = targetGeneral(view, args.generalId);
    if (!target || target.id === source.id || target.nationId !== source.nationId)
      return fail('BAD_TARGET', '같은 국가의 다른 장수를 선택하세요.');
    const troops = readTroops(view);
    const membership = troops && troopOf(troops, target.id);
    if (!membership || membership.leaderId === target.id)
      return fail('BAD_TARGET', '부대장을 제외한 부대원만 선택할 수 있습니다.');
    return null;
  },
  change(state, _actor, args) {
    const troops = readTroops(state)!;
    const membership = troopOf(troops, args.generalId)!;
    const row = troops.troops[membership.leaderId]!;
    row.members = row.members.filter((id) => id !== args.generalId);
    state.ext!.troop = troops;
    return success(`부대 탈퇴 지시: ${state.generals[args.generalId]!.name} · ${row.name}`);
  },
});
