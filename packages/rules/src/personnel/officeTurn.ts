import type { DeepReadonly } from '../model/world';
import type { Actor, CommandResult, Failure } from '../commands/types';
import { commandRegistry } from '../commands/registry';
import { assignGeneral } from './assignments';
import type { OfficeRevisions, OfficeView } from './offices';
import { canUseNationTurns } from './permissions';
import { PersonnelInvariantError, type ClosedOffer, type PersonnelLog } from './types';

export type OfficeSlot = { commandKey: string; args: unknown };
export type OfficeTurnTake = Readonly<{
  nationId: number;
  officerLevel: number;
  slot: OfficeSlot;
  queue: OfficeSlot[] | null;
  offices: OfficeRevisions;
}>;

export function takeOfficeTurn(
  view: OfficeView,
  offices: DeepReadonly<OfficeRevisions>,
  generalId: number,
): OfficeTurnTake | null {
  const general = view.generals[generalId];
  if (!general) throw new PersonnelInvariantError('장수가 없습니다.');
  const { nationId, officerLevel } = general;
  if (nationId === null || !canUseNationTurns(officerLevel)) return null;
  if (!view.nations[nationId]) throw new PersonnelInvariantError('직책자가 속한 국가가 없습니다.');
  const queue = view.officeTurns?.[nationId]?.[officerLevel];
  if (queue !== undefined) {
    if (!Array.isArray(queue) || queue.length !== 12)
      throw new PersonnelInvariantError('직책 예턴은 12칸이어야 합니다.');
    for (const slot of queue) {
      if (
        slot === null ||
        typeof slot !== 'object' ||
        Array.isArray(slot) ||
        Object.keys(slot).length !== 2 ||
        !Object.hasOwn(slot, 'commandKey') ||
        typeof slot.commandKey !== 'string' ||
        !Object.hasOwn(slot, 'args')
      )
        throw new PersonnelInvariantError('직책 예턴의 명령과 인자를 확인하세요.');
    }
  }
  const stored = offices[nationId]?.[officerLevel];
  const counter = stored === undefined ? { revision: 0, tenure: 0 } : stored;
  if (
    counter === null ||
    typeof counter !== 'object' ||
    Array.isArray(counter) ||
    Object.keys(counter).length !== 2 ||
    !Object.hasOwn(counter, 'revision') ||
    !Object.hasOwn(counter, 'tenure') ||
    !Number.isSafeInteger(counter.revision) ||
    counter.revision < 0 ||
    counter.revision === Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(counter.tenure) ||
    counter.tenure < 0
  )
    throw new PersonnelInvariantError('직책 revision 또는 tenure가 잘못됐습니다.');
  const next = structuredClone(offices) as OfficeRevisions;
  (next[nationId] ??= {})[officerLevel] = { revision: counter.revision + 1, tenure: counter.tenure };
  return {
    nationId,
    officerLevel,
    slot: queue === undefined ? { commandKey: 'nation_rest', args: {} } : structuredClone(queue[0]!),
    queue:
      queue === undefined
        ? null
        : [...(structuredClone(queue.slice(1)) as OfficeSlot[]), { commandKey: 'nation_rest', args: {} }],
    offices: next,
  };
}

export type OfficeAssignRun = Readonly<{
  result: CommandResult | Failure;
  closedOffers: ClosedOffer[];
  logs: PersonnelLog[];
}>;

export function runOfficeAssign(view: OfficeView, actor: Actor, args: unknown, tick: number): OfficeAssignRun {
  const parsed = commandRegistry.get('nation_assign')!.args.safeParse(args);
  if (!parsed.success)
    return {
      result: { code: 'BAD_ARGS', message: '명령 인자가 잘못되었습니다.' },
      closedOffers: [],
      logs: [],
    };
  // registry의 Args는 unknown이다. 검증한 발령 인자 두 칸만 읽는다.
  const { generalId, cityKey } = parsed.data as { generalId: number; cityKey: number };
  const change = assignGeneral(view, actor.generalId, generalId, cityKey, tick);
  if (!change.ok) {
    switch (change.code) {
      case 'NO_ACTOR':
      case 'NOT_NATION':
      case 'BAD_TARGET':
        return { result: { code: change.code, message: change.message }, closedOffers: [], logs: [] };
      default:
        throw new PersonnelInvariantError(change.message);
    }
  }
  return {
    result: {
      effects: [{ kind: 'world', state: change.state }],
      logs: change.logs.map(({ kind, text }) => ({ kind, text })),
    },
    closedOffers: change.closedOffers,
    logs: change.logs,
  };
}
