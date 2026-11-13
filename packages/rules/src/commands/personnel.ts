import { TICKS_PER_MONTH } from '../clock/constants';
import { z } from 'zod';
import { BALANCE } from '../balance';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import { NATION_PHILOSOPHY_FEATURE, nationPhilosophyNames } from '../personnel/nationPhilosophy';
import { refreshSupply } from '../supply';
import { DIPLOMATIC_COOLDOWN_FEATURE } from '../diplomacy/cooldown';
import type { WorldView } from '../model/world';
import { commandMeta, defineCommand, fail, noArgs, positive, ruler, success, targetGeneral } from './support';

const establish = (uprising: boolean) =>
  defineCommand({
    key: uprising ? 'uprising' : 'found',
    name: uprising ? '거병' : '건국',
    category: 'strategy',
    args: z.strictObject({
      name: z.string().trim().min(1).max(30),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      philosophy: z.enum(nationPhilosophyNames).optional(),
    }),
    check(view, actor, args) {
      if (args.philosophy && !view.ruleFeatures?.includes(NATION_PHILOSOPHY_FEATURE))
        return fail('BAD_ARGS', '이 월드는 국가 성향 선택을 지원하지 않습니다.');
      if (Math.floor((actor.tick ?? 0) / TICKS_PER_MONTH) < (view.presetRules?.protection.foundUntilMonths ?? 0))
        return fail('PROTECTED', '초반 보호 기간에는 건국하거나 거병할 수 없습니다.');
      const general = view.generals[actor.generalId]!;
      if (general.nationId !== null) return fail('BAD_STATE', '재야 장수만 가능합니다.');
      if (view.cities[general.cityKey]?.kind === 'PASS') return fail('BAD_TARGET', '도시에서만 건국할 수 있습니다.');
      if (view.cities[general.cityKey]?.nationId !== null) return fail('NOT_OWN_CITY', '빈 도시에서만 가능합니다.');
      if (Object.values(view.nations).some((nation) => nation.name === args.name))
        return fail('BAD_STATE', '같은 이름의 국가가 있습니다.');
      if (general.gold < BALANCE.FOUND_COST) return fail('NO_GOLD', '금이 부족합니다.');
      return uprising && general.crew <= 0 ? fail('NO_CREW', '거병할 병력이 없습니다.') : null;
    },
    change(state, actor, args) {
      const general = state.generals[actor.generalId]!;
      const meta = commandMeta(state);
      const id = meta.nextNationId++;
      state.nations[id] = {
        id,
        name: args.name,
        color: args.color,
        gold: 0,
        rice: 0,
        description: '',
        tech: 0,
        philosophy: args.philosophy ?? '',
        level: 0,
        capitalCityKey: general.cityKey,
        isNpc: general.userId === null,
        ...(uprising && state.ruleFeatures?.includes(DIPLOMATIC_COOLDOWN_FEATURE)
          ? { diplomaticAidUntilMonth: Math.floor((actor.tick ?? 0) / TICKS_PER_MONTH) + 72 }
          : {}),
      };
      general.gold -= BALANCE.FOUND_COST;
      general.nationId = id;
      general.officerLevel = BALANCE.RULER_LEVEL;
      delete meta.offers[general.id];
      state.cities[general.cityKey]!.nationId = id;
      refreshSupply(state);
      return {
        ...success(`${args.name} ${uprising ? '거병' : '건국'}`),
        history: [{ nationId: id, text: `${general.name} ${args.name} 건국` }],
      };
    },
  });
const blockedRecruitmentNation = (view: WorldView) => view.commandMeta?.lastNationRecruitmentLock?.blockedNationId;

function recruitmentCandidates(view: WorldView) {
  const blocked = blockedRecruitmentNation(view);
  return Object.values(view.nations).filter(
    (nation) =>
      nation.id !== blocked &&
      nation.capitalCityKey !== null &&
      view.cities[nation.capitalCityKey]?.nationId === nation.id,
  );
}

const join = (random: boolean) =>
  defineCommand<{ nationId?: number | undefined }>({
    key: random ? 'join_random' : 'join',
    name: random ? '무작위 임관' : '임관',
    category: 'strategy',
    args: random ? z.strictObject({ nationId: z.never().optional() }) : z.strictObject({ nationId: positive }),
    check(view, actor, args) {
      if (view.generals[actor.generalId]!.nationId !== null)
        return fail('BAD_STATE', '재야 장수만 임관할 수 있습니다.');
      const candidates = recruitmentCandidates(view);
      if (random ? candidates.length > 0 : candidates.some((nation) => nation.id === args.nationId)) return null;
      const blocked = blockedRecruitmentNation(view);
      if (blocked !== undefined && (random ? view.nations[blocked] : blocked === args.nationId))
        return fail('PROTECTED', '이 국가에는 임관할 수 없습니다.');
      return fail('BAD_TARGET', '임관할 국가가 없습니다.');
    },
    change(state, actor, args, rng) {
      const nation = random
        ? rng.pick(recruitmentCandidates(state).sort((a, b) => a.id - b.id))
        : state.nations[args.nationId!]!;
      const general = state.generals[actor.generalId]!;
      general.nationId = nation.id;
      general.officerLevel = 1;
      general.cityKey = nation.capitalCityKey!;
      if (state.commandMeta) delete state.commandMeta.offers[general.id];
      return success(`${nation.name} 임관`);
    },
  });
export const personnelCommands = [
  join(false),
  join(true),
  establish(false),
  establish(true),
  defineCommand({
    key: 'resign',
    name: '하야',
    category: 'strategy',
    args: noArgs,
    check(view, actor) {
      const general = view.generals[actor.generalId]!;
      if (general.nationId === null) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
      return general.officerLevel === BALANCE.RULER_LEVEL ? fail('BAD_STATE', '군주는 하야할 수 없습니다.') : null;
    },
    change(state, actor) {
      const general = state.generals[actor.generalId]!;
      general.nationId = null;
      general.officerLevel = 0;
      return success('하야');
    },
  }),
  defineCommand({
    key: 'invite',
    name: '등용',
    category: 'strategy',
    args: z.strictObject({ generalId: positive }),
    check(view, actor, args) {
      const failure = ruler(view, actor);
      if (failure) return failure;
      const target = targetGeneral(view, args.generalId);
      return target?.nationId === null && target.activeFromYear !== LINEAGE_EXITED_YEAR
        ? null
        : fail('BAD_TARGET', '재야 장수만 등용할 수 있습니다.');
    },
    change(state, actor, args) {
      const nationId = state.generals[actor.generalId]!.nationId!;
      commandMeta(state).offers[args.generalId] = nationId;
      return success(`${state.generals[args.generalId]!.name} 등용 제안`);
    },
  }),
  defineCommand({
    key: 'accept_invite',
    name: '등용 수락',
    category: 'strategy',
    args: noArgs,
    check(view, actor) {
      const general = view.generals[actor.generalId]!;
      if (general.nationId !== null) return fail('BAD_STATE', '재야 장수만 수락할 수 있습니다.');
      const id = view.commandMeta?.offers[general.id];
      if (id !== undefined && id === blockedRecruitmentNation(view))
        return fail('PROTECTED', '이 국가에는 임관할 수 없습니다.');
      const nation = id === undefined ? undefined : view.nations[id];
      return nation && nation.capitalCityKey !== null && view.cities[nation.capitalCityKey]?.nationId === nation.id
        ? null
        : fail('NO_OFFER', '수락할 등용 제안이 없습니다.');
    },
    change(state, actor) {
      const general = state.generals[actor.generalId]!;
      const nation = state.nations[state.commandMeta!.offers[general.id]!]!;
      general.nationId = nation.id;
      general.cityKey = nation.capitalCityKey!;
      general.officerLevel = 1;
      delete state.commandMeta!.offers[general.id];
      return success(`${nation.name} 등용 수락`);
    },
  }),
];
