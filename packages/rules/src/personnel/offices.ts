import type { DeepReadonly, WorldView, OfficeRevisions } from '../model/world';
import { canUseNationTurns } from './permissions';
import { PersonnelInvariantError, type PersonnelState } from './types';

export type { OfficeTurns, OfficeRevisions } from '../model/world';
export type OfficeState = PersonnelState;
export type OfficeView = DeepReadonly<OfficeState>;
type Occupants = Record<number, Record<number, number>>;

function occupants(state: Pick<WorldView, 'nations' | 'generals'>): Occupants {
  const result: Occupants = {};
  for (const general of Object.values(state.generals)) {
    if (general.nationId === null || !canUseNationTurns(general.officerLevel)) continue;
    if (!state.nations[general.nationId]) {
      throw new PersonnelInvariantError('직책자가 속한 국가가 없습니다.');
    }
    const nation = (result[general.nationId] ??= {});
    if (nation[general.officerLevel] !== undefined) {
      throw new PersonnelInvariantError('한 직책에 장수가 둘 이상 있습니다.');
    }
    nation[general.officerLevel] = general.id;
  }
  return result;
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new PersonnelInvariantError('직책 revision 또는 tenure가 잘못됐습니다.');
  }
  return value + 1;
}

// before는 step 시작 상태다. 다음 step의 재검사는 직전 결과를 before와 after에 넣는다.
export function syncOffices(
  before: Pick<WorldView, 'nations' | 'generals'>,
  after: OfficeView,
  offices: DeepReadonly<OfficeRevisions>,
): { state: OfficeState; offices: OfficeRevisions } {
  const previous = occupants(before);
  const current = occupants(after);
  const next = structuredClone(after) as OfficeState;
  const revisions = structuredClone(offices) as OfficeRevisions;

  for (const nationId of Object.keys(revisions).map(Number)) {
    if (!after.nations[nationId]) delete revisions[nationId];
  }
  for (const nationId of Object.keys(next.officeTurns ?? {}).map(Number)) {
    if (!after.nations[nationId]) delete next.officeTurns![nationId];
  }

  for (const nationId of Object.keys(after.nations).map(Number)) {
    const levels = new Set([
      ...Object.keys(previous[nationId] ?? {}).map(Number),
      ...Object.keys(current[nationId] ?? {}).map(Number),
    ]);
    for (const level of levels) {
      if (previous[nationId]?.[level] === current[nationId]?.[level]) continue;
      const old = revisions[nationId]?.[level] ?? { revision: 0, tenure: 0 };
      const updated = { revision: increment(old.revision), tenure: increment(old.tenure) };
      (revisions[nationId] ??= {})[level] = updated;
      next.officeTurns ??= {};
      (next.officeTurns[nationId] ??= {})[level] = Array.from({ length: 12 }, () => ({
        commandKey: 'nation_rest',
        args: {},
      }));
    }
  }
  if (next.officeTurns && Object.keys(next.officeTurns).length === 0) delete next.officeTurns;
  return { state: next, offices: revisions };
}
