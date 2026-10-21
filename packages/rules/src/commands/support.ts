import { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { WorldState, WorldView } from '../model/world';
import type { Actor, CommandDef, CommandResult, Failure } from './types';

export const noArgs = z.strictObject({});
export const positive = z.number().int().positive().max(1_000_000);
export const fail = (code: Failure['code'], message: string): Failure => ({ code, message });
export function ownCity(view: WorldView, actor: Actor): Failure | null {
  const general = view.generals[actor.generalId];
  if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
  if (general.nationId === null || !view.nations[general.nationId]) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
  const city = view.cities[general.cityKey];
  if (city?.nationId !== general.nationId) return fail('NOT_OWN_CITY', '자기 국가 도시에서만 가능합니다.');
  return city.supplied ? null : fail('NO_SUPPLY', '보급이 끊긴 도시입니다.');
}
export function ruler(view: WorldView, actor: Actor): Failure | null {
  const general = view.generals[actor.generalId];
  if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
  if (general.nationId === null || !view.nations[general.nationId]) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
  return general.officerLevel === BALANCE.RULER_LEVEL ? null : fail('NOT_RULER', '군주만 실행할 수 있습니다.');
}
export function defineCommand<A>(spec: {
  key: string;
  name: string;
  category: 'military' | 'strategy' | 'personal' | 'nation';
  target?: 'general' | 'nation';
  args: z.ZodType<A>;
  check(view: WorldView, actor: Actor, args: A): Failure | null;
  change(state: WorldState, actor: Actor, args: A, rng: Rng): Omit<CommandResult, 'effects'>;
}): CommandDef {
  const check = (view: WorldView, actor: Actor, raw: unknown) => {
    if (!view.generals[actor.generalId]) return fail('NO_ACTOR', '장수가 없습니다.');
    const parsed = spec.args.safeParse(raw);
    if (!parsed.success) return fail('BAD_ARGS', '명령 인자가 잘못되었습니다.');
    return (spec.target === 'nation' ? ruler(view, actor) : null) ?? spec.check(view, actor, parsed.data);
  };
  const definition = {
    key: spec.key, name: spec.name, target: spec.target ?? 'general', args: spec.args,
    category: spec.category,
    check, precheck: check,
    execute(view: WorldView, actor: Actor, raw: unknown, rng: Rng): CommandResult {
      const failure = check(view, actor, raw);
      if (failure) throw new Error(failure.message);
      const state = structuredClone(view) as WorldState;
      const result = spec.change(state, actor, spec.args.parse(raw), rng);
      return { ...result, effects: [{ kind: 'world', state }] };
    },
  };
  return definition;
}
export const success = (text: string): Omit<CommandResult, 'effects'> => ({ logs: [{ kind: 'success', text }] });
export function commandMeta(state: WorldState) {
  return state.commandMeta ??= { nextNationId: Math.max(0, ...Object.keys(state.nations).map(Number)) + 1, offers: {} };
}
export function relation(view: WorldView, a: number, b: number) {
  return view.diplomacies.find((d) => d.nationA === Math.min(a, b) && d.nationB === Math.max(a, b));
}
export function removeNation(state: WorldState, nationId: number) {
  commandMeta(state);
  delete state.nations[nationId];
  state.diplomacies = state.diplomacies.filter((d) => d.nationA !== nationId && d.nationB !== nationId);
  if (state.nationTurns) {
    delete state.nationTurns[nationId];
    if (!Object.keys(state.nationTurns).length) delete state.nationTurns;
  }
  for (const general of Object.values(state.generals)) {
    if (general.nationId === nationId) { general.nationId = null; general.officerLevel = 0; }
  }
  if (state.commandMeta) {
    for (const [id, nation] of Object.entries(state.commandMeta.offers)) {
      if (nation === nationId) delete state.commandMeta.offers[Number(id)];
    }
  }
}
