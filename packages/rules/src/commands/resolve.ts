import type { Rng } from '@opensamguk/shared';
import type { WorldView } from '../model/world';
import { commands } from './registry';
import { extensionCommands } from './ext/registry';
import type { Actor, CommandDef, CommandResult, Failure } from './types';

export { extensionCommands } from './ext/registry';
export { createExtState, type ExtInitContext, type ExtSlice } from './ext/state';
export type { JsonValue, WorldExt } from '../model/world';

export interface EnabledCommands {
  general: readonly string[];
  nation: readonly string[];
}
export interface CommandResolver {
  get(key: string): CommandDef | undefined;
  list(target: 'general' | 'nation'): readonly CommandDef[];
  precheck(view: WorldView, actor: Actor, key: string, args: unknown): Failure | null;
  run(view: WorldView, actor: Actor, key: string, args: unknown, rng: Rng): CommandResult | Failure;
}

export function createCommandResolver(enabled: EnabledCommands | null): CommandResolver {
  return createCommandResolverWithCommands(enabled, extensionCommands);
}

// 시험 목록은 운영 registry를 바꾸지 않고 주입한다. 패키지 공개 진입점에서는 내보내지 않는다.
export function createCommandResolverWithCommands(
  enabled: EnabledCommands | null,
  extensions: readonly CommandDef[],
): CommandResolver {
  const registry = new Map(commands.map((def) => [def.key, def]));
  for (const def of extensions) {
    if (registry.has(def.key)) throw new Error(`명령 key가 중복됩니다: ${def.key}`);
    registry.set(def.key, def);
  }
  const active = new Set(commands.map((def) => def.key));
  for (const target of ['general', 'nation'] as const) {
    for (const key of enabled?.[target] ?? []) {
      const def = registry.get(key);
      if (!def || active.has(key) || def.target !== target) throw new Error(`확장 명령 설정을 확인하세요: ${key}`);
      active.add(key);
    }
  }
  const get = (key: string) => (active.has(key) ? registry.get(key) : undefined);
  function prepare(actor: Actor, key: string, args: unknown): { def: CommandDef; args: unknown } | Failure {
    const def = registry.get(key);
    if (!def) return { code: 'UNKNOWN_COMMAND', message: '없는 명령입니다.' };
    if (!active.has(key)) return { code: 'COMMAND_DISABLED', message: '이 월드에서 꺼진 명령입니다.' };
    if (def.target !== (actor.target ?? 'general')) return { code: 'BAD_ARGS', message: '명령 대상이 다릅니다.' };
    const parsed = def.args.safeParse(args);
    if (!parsed.success) return { code: 'BAD_ARGS', message: '명령 인자가 잘못되었습니다.' };
    return { def, args: parsed.data };
  }
  return {
    get,
    list: (target) => [...registry.values()].filter((def) => active.has(def.key) && def.target === target),
    precheck(view, actor, key, args) {
      const parsed = prepare(actor, key, args);
      return 'code' in parsed ? parsed : parsed.def.precheck(view, actor, parsed.args);
    },
    run(view, actor, key, args, rng) {
      const parsed = prepare(actor, key, args);
      if ('code' in parsed) return parsed;
      return parsed.def.check(view, actor, parsed.args) ?? parsed.def.execute(view, actor, parsed.args, rng);
    },
  };
}
