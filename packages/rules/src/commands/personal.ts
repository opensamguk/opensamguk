import { z } from 'zod';
import { BALANCE } from '../balance';
import { defineCommand, fail, noArgs, ownCity, positive, success } from './support';

export const personalCommands = [
  defineCommand({
    key: 'heal', name: '요양', category: 'personal', args: noArgs,
    check(view, actor) {
      const g = view.generals[actor.generalId]!;
      if (g.injury <= 0) return fail('AT_MAX', '부상이 없습니다.');
      return g.gold < BALANCE.HEAL_COST ? fail('NO_GOLD', '금이 부족합니다.') : null;
    },
    change(state, actor) {
      const g = state.generals[actor.generalId]!;
      g.gold -= BALANCE.HEAL_COST; g.injury = Math.max(0, g.injury - BALANCE.HEAL_GAIN);
      return success(`요양: 부상 ${g.injury}`);
    },
  }),
  defineCommand({
    key: 'trade_rice', name: '군량매매', category: 'personal', args: z.strictObject({ amount: positive, buy: z.boolean() }),
    check(view, actor, args) {
      const failure = ownCity(view, actor);
      if (failure) return failure;
      const g = view.generals[actor.generalId]!;
      return args.buy ? (g.gold < args.amount ? fail('NO_GOLD', '금이 부족합니다.') : null)
        : (g.rice < args.amount ? fail('NO_RICE', '쌀이 부족합니다.') : null);
    },
    change(state, actor, args) {
      const g = state.generals[actor.generalId]!;
      const delta = args.buy ? args.amount : -args.amount;
      g.gold -= delta; g.rice += delta;
      return success(`군량 ${args.buy ? '매입' : '매각'}: ${args.amount}`);
    },
  }),
  defineCommand({
    key: 'donate', name: '헌납', category: 'personal', args: z.strictObject({ resource: z.enum(['gold', 'rice']), amount: positive }),
    check(view, actor, args) {
      const g = view.generals[actor.generalId]!;
      if (g.nationId === null) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
      return g[args.resource] < args.amount ? fail(args.resource === 'gold' ? 'NO_GOLD' : 'NO_RICE', '헌납할 자원이 부족합니다.') : null;
    },
    change(state, actor, args) {
      const g = state.generals[actor.generalId]!;
      g[args.resource] -= args.amount; state.nations[g.nationId!]![args.resource] += args.amount;
      g.dedication += args.amount;
      return success(`헌납: ${args.resource === 'gold' ? '금' : '쌀'} ${args.amount}`);
    },
  }),
];
