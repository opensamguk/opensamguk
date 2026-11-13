// core2026 df6c926의 준비 없는 국가 전략 3종을 D-074 기준으로 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { z } from 'zod';
import { toGameDate } from '../clock/clock';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cloneWorld } from '../model/clone';
import type { WorldState, WorldView } from '../model/world';
import { fail, positive, relation, targetGeneral } from '../commands/support';
import type { Actor, CommandDef, CommandResult, Failure } from '../commands/types';
import { readNationStrategy, strategyMonth, type StrategyKey } from './state';

import { nationPhilosophy } from '../personnel/nationPhilosophy';

const WAIT_FACTOR = { nation_mobilize: 4, nation_rivalry: 16, nation_raid: 16 } as const;
interface StrategySpec<A> {
  key: StrategyKey;
  name: string;
  minOfficerLevel: number;
  args: z.ZodType<A>;
  check(view: WorldView, actor: Actor, args: A): Failure | null;
  change(state: WorldState, actor: Actor, args: A): Omit<CommandResult, 'effects'>;
}
function defineStrategy<A>(spec: StrategySpec<A>): CommandDef {
  const check = (view: WorldView, actor: Actor, raw: unknown): Failure | null => {
    const general = targetGeneral(view, actor.generalId);
    if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
    if (general.nationId === null || !view.nations[general.nationId])
      return fail('NOT_NATION', '국가에 소속되어야 합니다.');
    if (view.cities[general.cityKey]?.nationId !== general.nationId)
      return fail('NOT_OWN_CITY', '자기 국가 도시에서만 가능합니다.');
    if (
      !Number.isInteger(general.officerLevel) ||
      general.officerLevel < spec.minOfficerLevel ||
      general.officerLevel > 12
    )
      return fail('NOT_RULER', '이 전략을 실행할 직책이 아닙니다.');
    const parsed = spec.args.safeParse(raw);
    if (!parsed.success) return fail('BAD_ARGS', '명령 인자가 잘못되었습니다.');
    const targetFailure = spec.check(view, actor, parsed.data);
    if (targetFailure) return targetFailure;
    const state = readNationStrategy(view.nationStrategy, view);
    if (!state) return fail('COMMAND_DISABLED', '이 월드에서 꺼진 명령입니다.');
    const current = strategyMonth(actor.tick ?? 0),
      cooldown = state.nations[general.nationId];
    if ((cooldown?.strategicUntil ?? 0) > current) return fail('BAD_STATE', '전략 기한이 남았습니다.');
    const remaining = (cooldown?.commands[spec.key] ?? 0) - current;
    return remaining > 0 ? fail('BAD_STATE', `${remaining}개월 더 기다려야 합니다.`) : null;
  };
  return {
    key: spec.key,
    name: spec.name,
    category: 'strategy',
    target: 'nation',
    args: spec.args,
    precheck: check,
    check,
    execute(view, actor, raw) {
      const failure = check(view, actor, raw);
      if (failure) throw new Error(failure.message);
      const state = cloneWorld(view),
        general = state.generals[actor.generalId]!,
        nationId = general.nationId!,
        tick = actor.tick ?? 0,
        current = strategyMonth(tick),
        year = toGameDate(state.startYear, tick).year;
      const result = spec.change(state, actor, spec.args.parse(raw));
      const ledger = readNationStrategy(state.nationStrategy, state)!;
      const cooldown = (ledger.nations[nationId] ??= { strategicUntil: 0, commands: {} });
      const count = Math.max(
        10,
        Object.values(state.generals).filter(
          (row) => row.nationId === nationId && row.activeFromYear <= year && row.removedAt === undefined,
        ).length,
      );
      const policy = nationPhilosophy(state, state.nations[nationId]!.philosophy);
      cooldown.strategicUntil = current + Math.round(9 * (policy?.globalDelay ?? 1));
      const delay = Math.round(Math.sqrt(count * WAIT_FACTOR[spec.key]) * 10);
      cooldown.commands[spec.key] =
        current + (policy?.delay ? Math.round((delay * policy.delay[0]) / policy.delay[1]) : delay);
      state.nationStrategy = ledger;
      general.experience += 5;
      general.dedication += 5;
      return { ...result, effects: [{ kind: 'world', state }] };
    },
  };
}

const nationArgs = z.strictObject({ nationId: positive });
const mutableDiplomacy = (state: WorldState, own: number, target: number) =>
  state.diplomacies.find((row) => row.nationA === Math.min(own, target) && row.nationB === Math.max(own, target))!;
const targetNationFailure = (view: WorldView, actor: Actor, nationId: number) =>
  !view.nations[nationId] || view.generals[actor.generalId]!.nationId === nationId
    ? fail('BAD_TARGET', '다른 국가를 골라야 합니다.')
    : null;
const nationRecord = (state: WorldState, actor: Actor, nationId: number, name: string) => {
  const ownId = state.generals[actor.generalId]!.nationId!,
    text = `${name}: ${state.nations[ownId]!.name} → ${state.nations[nationId]!.name}`;
  return {
    logs: [{ kind: 'success' as const, text }],
    history: [ownId, nationId].map((id) => ({ nationId: id, text })),
  };
};

export const nationStrategyCommands: readonly CommandDef[] = [
  defineStrategy({
    key: 'nation_mobilize',
    name: '백성동원',
    minOfficerLevel: 5,
    args: z.strictObject({ cityKey: positive }),
    check(view, actor, { cityKey }) {
      const city = view.cities[cityKey];
      if (!city) return fail('BAD_TARGET', '없는 도시입니다.');
      return city.nationId === view.generals[actor.generalId]!.nationId
        ? null
        : fail('BAD_TARGET', '자기 국가 도시에만 쓸 수 있습니다.');
    },
    change(state, actor, { cityKey }) {
      const city = state.cities[cityKey]!;
      city.defence = Math.max(city.defence, Math.round(city.defenceMax * 0.8));
      city.wall = Math.max(city.wall, Math.round(city.wallMax * 0.8));
      return {
        logs: [{ kind: 'success', text: `백성동원: ${city.name} 수비 ${city.defence}, 성벽 ${city.wall}` }],
        history: [{ nationId: state.generals[actor.generalId]!.nationId!, text: `백성동원: ${city.name}` }],
      };
    },
  }),
  defineStrategy({
    key: 'nation_rivalry',
    name: '이호경식',
    minOfficerLevel: 11,
    args: nationArgs,
    check(view, actor, { nationId }) {
      const failure = targetNationFailure(view, actor, nationId);
      if (failure) return failure;
      const diplomacy = relation(view, view.generals[actor.generalId]!.nationId!, nationId);
      return diplomacy?.state === 'WAR' || diplomacy?.state === 'DECLARED'
        ? null
        : fail('NOT_WAR', '선포 중이거나 전쟁 중인 국가에만 쓸 수 있습니다.');
    },
    change(state, actor, { nationId }) {
      const diplomacy = mutableDiplomacy(state, state.generals[actor.generalId]!.nationId!, nationId);
      diplomacy.untilTick = (diplomacy.state === 'WAR' ? (actor.tick ?? 0) : diplomacy.untilTick) + TICKS_PER_MONTH;
      diplomacy.state = 'DECLARED';
      return nationRecord(state, actor, nationId, '이호경식');
    },
  }),
  defineStrategy({
    key: 'nation_raid',
    name: '급습',
    minOfficerLevel: 11,
    args: nationArgs,
    check(view, actor, { nationId }) {
      const failure = targetNationFailure(view, actor, nationId);
      if (failure) return failure;
      const diplomacy = relation(view, view.generals[actor.generalId]!.nationId!, nationId);
      return diplomacy?.state === 'DECLARED' && diplomacy.untilTick - (actor.tick ?? 0) >= TICKS_PER_MONTH
        ? null
        : fail('NOT_WAR', '선포 기간이 1개월 이상 남은 국가에만 쓸 수 있습니다.');
    },
    change(state, actor, { nationId }) {
      mutableDiplomacy(state, state.generals[actor.generalId]!.nationId!, nationId).untilTick = actor.tick ?? 0;
      return nationRecord(state, actor, nationId, '급습');
    },
  }),
];
