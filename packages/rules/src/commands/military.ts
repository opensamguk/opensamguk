import { z } from 'zod';
import { BALANCE } from '../balance';
import { defineCommand, fail, noArgs, ownCity, positive, success } from './support';

const recruits = (forced: boolean) => defineCommand({
  key: forced ? 'conscript' : 'recruit', name: forced ? '징병' : '모병', category: 'military',
  args: z.strictObject({ amount: positive, crewType: positive }),
  check(view, actor, args) {
    const failure = ownCity(view, actor);
    if (failure) return failure;
    const general = view.generals[actor.generalId]!;
    const city = view.cities[general.cityKey]!;
    const unit = actor.unitSet?.crewTypes.find((unit) => unit.id === args.crewType && unit.armType > 0);
    if (!unit) return fail('NO_UNIT_SET', '모집할 병종을 확인하세요.');
    if (general.crew > 0 && general.crewType !== args.crewType) return fail('BAD_STATE', '소집해제 후 병종을 바꿀 수 있습니다.');
    if (general.crew + args.amount > general.leadership * BALANCE.CREW_PER_LEADERSHIP) return fail('AT_MAX', '통솔 가능한 병력을 넘습니다.');
    if (city.population < args.amount) return fail('NO_POPULATION', '도시 인구가 부족합니다.');
    const cost = Math.ceil(args.amount * unit.cost * (forced ? BALANCE.CONSCRIPT_COST_FACTOR : 1));
    if (general.gold < cost) return fail('NO_GOLD', '금이 부족합니다.');
    return null;
  },
  change(state, actor, args) {
    const general = state.generals[actor.generalId]!;
    const city = state.cities[general.cityKey]!;
    const unit = actor.unitSet!.crewTypes.find((unit) => unit.id === args.crewType)!;
    general.gold -= Math.ceil(args.amount * unit.cost * (forced ? BALANCE.CONSCRIPT_COST_FACTOR : 1));
    general.train = Math.floor(general.train * general.crew / (general.crew + args.amount));
    general.atmos = Math.floor(general.atmos * general.crew / (general.crew + args.amount));
    general.crew += args.amount;
    general.crewType = args.crewType;
    city.population -= args.amount;
    if (forced) city.trust = Math.max(0, city.trust - BALANCE.CONSCRIPT_TRUST_LOSS);
    return success(`${forced ? '징병' : '모병'}: ${args.amount}명, 병력 ${general.crew}명`);
  },
});
const drill = (morale: boolean) => defineCommand({
  key: morale ? 'morale' : 'train', name: morale ? '사기진작' : '훈련', category: 'military', args: noArgs,
  check(view, actor) {
    const failure = ownCity(view, actor);
    if (failure) return failure;
    const general = view.generals[actor.generalId]!;
    if (general.crew <= 0) return fail('NO_CREW', '병력이 없습니다.');
    if (general[morale ? 'atmos' : 'train'] >= 100) return fail('AT_MAX', '이미 최대치입니다.');
    return general.gold < BALANCE.DRILL_COST ? fail('NO_GOLD', '금이 부족합니다.') : null;
  },
  change(state, actor) {
    const general = state.generals[actor.generalId]!;
    general.gold -= BALANCE.DRILL_COST;
    const field = morale ? 'atmos' : 'train';
    general[field] = Math.min(100, general[field] + (morale ? BALANCE.ATMOS_GAIN : BALANCE.TRAIN_GAIN));
    return success(`${morale ? '사기진작' : '훈련'}: ${general[field]}`);
  },
});
export const militaryCommands = [
  recruits(false), recruits(true), drill(false), drill(true),
  defineCommand({
    key: 'move', name: '이동', category: 'military', args: z.strictObject({ cityKey: positive }),
    check(view, actor, args) {
      const general = view.generals[actor.generalId]!;
      const city = view.cities[args.cityKey];
      if (!city) return fail('BAD_TARGET', '도시가 없습니다.');
      if (!view.cities[general.cityKey]?.connections.includes(args.cityKey)) return fail('NOT_ADJACENT', '연결된 도시가 아닙니다.');
      return general.nationId !== null && city.nationId !== null && city.nationId !== general.nationId
        ? fail('NOT_OWN_CITY', '다른 국가 도시에는 출병해야 합니다.') : null;
    },
    change(state, actor, args) {
      const general = state.generals[actor.generalId]!;
      general.cityKey = args.cityKey;
      return success(`${state.cities[args.cityKey]!.name} 이동`);
    },
  }),
  defineCommand({
    key: 'return', name: '귀환', category: 'military', args: noArgs,
    check(view, actor) {
      const general = view.generals[actor.generalId]!;
      const nation = general.nationId === null ? undefined : view.nations[general.nationId];
      if (!nation) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
      const target = view.cities[nation.capitalCityKey];
      if (target?.nationId !== nation.id) return fail('BAD_TARGET', '돌아갈 수도가 없습니다.');
      return general.cityKey === target.cityKey ? fail('BAD_STATE', '이미 수도에 있습니다.') : null;
    },
    change(state, actor) {
      const general = state.generals[actor.generalId]!;
      general.cityKey = state.nations[general.nationId!]!.capitalCityKey;
      return success(`${state.cities[general.cityKey]!.name} 귀환`);
    },
  }),
  defineCommand({
    key: 'dismiss', name: '소집해제', category: 'military', args: noArgs,
    check: (view, actor) => view.generals[actor.generalId]!.crew > 0 ? null : fail('NO_CREW', '병력이 없습니다.'),
    change(state, actor) {
      const general = state.generals[actor.generalId]!;
      const city = state.cities[general.cityKey]!;
      if (city.nationId === general.nationId) city.population = Math.min(city.populationMax, city.population + general.crew);
      general.crew = 0; general.train = 0; general.atmos = 0;
      return success('소집해제');
    },
  }),
];
