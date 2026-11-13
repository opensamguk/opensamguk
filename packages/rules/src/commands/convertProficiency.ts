import { z } from 'zod';
import { BALANCE } from '../balance';
import { proficiencyConversion } from '../general/proficiency';
import { defineCommand, fail, ownCity, positive, success } from './support';

export const convertProficiency = defineCommand({
  key: 'convert_proficiency',
  name: '숙련전환',
  category: 'military',
  args: z.strictObject({ srcArmType: positive, destArmType: positive }),
  check(view, actor, args) {
    const failure = ownCity(view, actor);
    if (failure) return failure;
    const { srcArmType, destArmType } = args;
    const types = actor.unitSet?.armTypes;
    if (!types || srcArmType === destArmType || !types[srcArmType] || !types[destArmType])
      return fail('BAD_ARGS', '서로 다른 병종 계열을 골라야 합니다.');
    const general = view.generals[actor.generalId]!;
    if (general.gold < BALANCE.DEVEL_COST) return fail('NO_GOLD', '금이 부족합니다.');
    if (general.rice < BALANCE.DEVEL_COST) return fail('NO_RICE', '쌀이 부족합니다.');
    const conversion = proficiencyConversion(
      general.proficiency?.[srcArmType] ?? 0,
      general.proficiency?.[destArmType] ?? 0,
    );
    return conversion.gain > 0 ? null : fail('BAD_STATE', '전환할 숙련이 부족하거나 대상 숙련이 가득 찼습니다.');
  },
  change(state, actor, { srcArmType, destArmType }) {
    const general = state.generals[actor.generalId]!;
    const proficiency = (general.proficiency ??= {});
    const conversion = proficiencyConversion(proficiency[srcArmType] ?? 0, proficiency[destArmType] ?? 0);
    proficiency[srcArmType] = conversion.source;
    proficiency[destArmType] = conversion.target;
    general.gold -= BALANCE.DEVEL_COST;
    general.rice -= BALANCE.DEVEL_COST;
    general.experience += 10;
    const types = actor.unitSet!.armTypes;
    return success(
      `${types[srcArmType]} 숙련 ${conversion.cut} 감소 · ${types[destArmType]} 숙련 ${conversion.gain} 증가`,
    );
  },
});
