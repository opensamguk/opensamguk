import { describe, expect, it } from 'vitest';
import { appointOfficer, dismissOfficer } from './appointments';
import { syncOffices, type OfficeRevisions, type OfficeState } from './offices';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

const rest = () => Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} }));
const reserved = () =>
  Array.from({ length: 12 }, (_, slot) => ({
    commandKey: 'nation_reward',
    args: { generalId: 3, amount: slot + 1 },
  }));
function fixture(): { state: OfficeState; offices: OfficeRevisions } {
  const state: OfficeState = personnelWorld();
  state.officeTurns = { 1: { 5: reserved(), 12: reserved() }, 2: { 12: reserved() } };
  return {
    state,
    offices: {
      1: { 5: { revision: 7, tenure: 2 }, 12: { revision: 8, tenure: 3 } },
      2: { 12: { revision: 9, tenure: 4 } },
    },
  };
}

describe('직책 칸 동기화', () => {
  it('임명은 새 직책만 비우고 없는 revision과 tenure를 0에서 올린다', () => {
    const { state, offices } = fixture();
    const appointed = applied(appointOfficer(state, 1, 3, 11)).state;
    const result = syncOffices(state, appointed, offices);
    expect(result.state.officeTurns?.[1]?.[11]).toEqual(rest());
    expect(result.offices[1]?.[11]).toEqual({ revision: 1, tenure: 1 });
    expect(result.state.officeTurns?.[1]?.[5]).toEqual(state.officeTurns?.[1]?.[5]);
    expect(result.state.officeTurns?.[1]?.[12]).toEqual(state.officeTurns?.[1]?.[12]);
    expect(result.offices[1]?.[5]).toEqual(offices[1]?.[5]);
    expect(result.offices[1]?.[12]).toEqual(offices[1]?.[12]);
    expect(result.offices[2]).toEqual(offices[2]);
    expect(result.state.officeTurns?.[2]).toEqual(state.officeTurns?.[2]);
  });

  it('해임은 빈 직책의 과거 초안도 무효로 만든다', () => {
    const { state, offices } = fixture();
    const dismissed = applied(dismissOfficer(state, 1, 4)).state;
    const result = syncOffices(state, dismissed, offices);
    expect(result.state.generals[4]?.officerLevel).toBe(1);
    expect(result.state.officeTurns?.[1]?.[5]).toEqual(rest());
    expect(result.offices[1]?.[5]).toEqual({ revision: 8, tenure: 3 });
  });

  it('직책 이동은 원래 직책과 새 직책을 각각 한 번 비운다', () => {
    const { state, offices } = fixture();
    const promoted = applied(appointOfficer(state, 1, 4, 11)).state;
    const result = syncOffices(state, promoted, offices);
    expect(result.offices[1]?.[5]).toEqual({ revision: 8, tenure: 3 });
    expect(result.offices[1]?.[11]).toEqual({ revision: 1, tenure: 1 });
    expect(result.state.officeTurns?.[1]?.[5]).toEqual(rest());
    expect(result.state.officeTurns?.[1]?.[11]).toEqual(rest());
  });

  it.each([5, 6, 7, 8, 9, 10, 11, 12])('직책 %i의 사람이 바뀌면 직책 레벨이 같아도 비운다', (level) => {
    const { state, offices } = fixture();
    state.generals[1]!.officerLevel = 1;
    state.generals[4]!.officerLevel = level;
    state.officeTurns![1]![level] = reserved();
    offices[1]![level] = { revision: 7, tenure: 2 };
    const after = structuredClone(state);
    after.generals[4]!.officerLevel = 1;
    after.generals[3]!.officerLevel = level;
    const result = syncOffices(state, after, offices);
    expect(result.offices[1]?.[level]).toEqual({ revision: 8, tenure: 3 });
    expect(result.state.officeTurns?.[1]?.[level]).toEqual(rest());
  });

  it.each(['탈국', '장수 삭제', '타국 이동'] as const)('%s 뒤 원래 직책을 비운다', (change) => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    if (change === '장수 삭제') delete after.generals[4];
    else after.generals[4]!.nationId = change === '탈국' ? null : 2;
    const result = syncOffices(state, after, offices);
    expect(result.offices[1]?.[5]).toEqual({ revision: 8, tenure: 3 });
    expect(result.state.officeTurns?.[1]?.[5]).toEqual(rest());
    if (change === '타국 이동') {
      expect(result.offices[2]?.[5]).toEqual({ revision: 1, tenure: 1 });
      expect(result.state.officeTurns?.[2]?.[5]).toEqual(rest());
    }
  });

  it('새 국가의 군주 직책도 최초 취임으로 센다', () => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    after.nations[3] = { ...after.nations[1]!, id: 3 };
    after.generals[3]!.nationId = 3;
    after.generals[3]!.officerLevel = 12;
    const result = syncOffices(state, after, offices);
    expect(result.offices[3]?.[12]).toEqual({ revision: 1, tenure: 1 });
    expect(result.state.officeTurns?.[3]?.[12]).toEqual(rest());
  });

  it('멸망한 국가의 직책과 칸만 지우고 발령 제안은 해석하지 않는다', () => {
    const { state, offices } = fixture();
    state.assignmentOffers = {
      3: { id: 'pending', nationId: 1, issuerGeneralId: 4, cityKey: 1, createdTick: 0, expiresTick: 200 },
    };
    const after = structuredClone(state);
    delete after.nations[1];
    for (const general of Object.values(after.generals)) {
      if (general.nationId === 1) {
        general.nationId = null;
        general.officerLevel = 0;
      }
    }
    const result = syncOffices(state, after, offices);
    expect(result.offices).toEqual({ 2: offices[2] });
    expect(result.state.officeTurns).toEqual({ 2: state.officeTurns?.[2] });
    expect(result.state.assignmentOffers).toEqual(state.assignmentOffers);
  });

  it('마지막 국가의 칸이 없어지면 선택 필드도 지운다', () => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    after.nations = {};
    after.generals = {};
    const result = syncOffices(state, after, offices);
    expect(result.offices).toEqual({});
    expect(Object.hasOwn(result.state, 'officeTurns')).toBe(false);
  });

  it('직책자가 같으면 다른 상태 변화와 편집된 칸을 그대로 보존한다', () => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    after.generals[4]!.gold += 1;
    after.officeTurns![1]![5]![0] = { commandKey: 'nation_seize', args: { generalId: 3 } };
    const result = syncOffices(state, after, offices);
    expect(result).toEqual({ state: after, offices });
  });

  it('직책자가 그대로인 초기 상태에 칸과 revision을 만들지 않는다', () => {
    const state = personnelWorld();
    const result = syncOffices(state, state, {});
    expect(result).toEqual({ state, offices: {} });
    expect(Object.hasOwn(result.state, 'officeTurns')).toBe(false);
  });

  it('일반 장수의 변화는 직책 칸을 만들지 않는다', () => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    after.generals[3]!.nationId = 2;
    after.generals[3]!.officerLevel = 0;
    expect(syncOffices(state, after, offices)).toEqual({ state: after, offices });
  });

  it('다음 step의 재동기화는 revision과 tenure를 다시 올리지 않는다', () => {
    const { state, offices } = fixture();
    const after = applied(dismissOfficer(state, 1, 4)).state;
    const first = syncOffices(state, after, offices);
    const next = syncOffices(first.state, first.state, first.offices);
    expect(next).toEqual(first);
  });

  it('해임 뒤 재임명은 두 step의 취임 변화를 각각 센다', () => {
    const { state, offices } = fixture();
    const dismissed = applied(dismissOfficer(state, 1, 4)).state;
    const first = syncOffices(state, dismissed, offices);
    const appointed = applied(appointOfficer(first.state, 1, 4, 5)).state;
    const next = syncOffices(first.state, appointed, first.offices);
    expect(next.offices[1]?.[5]).toEqual({ revision: 9, tenure: 4 });
    expect(next.state.officeTurns?.[1]?.[5]).toEqual(rest());
  });

  it('입력을 동결해도 동작하고 결과의 예약 인수와 revision은 입력과 독립이다', () => {
    const { state, offices } = fixture();
    const after: OfficeState = applied(appointOfficer(state, 1, 3, 11)).state;
    const beforeCopy = structuredClone(state);
    const afterCopy = structuredClone(after);
    const officesCopy = structuredClone(offices);
    const result = syncOffices(deepFreeze(state), deepFreeze(after), deepFreeze(offices));
    (result.state.officeTurns![2]![12]![0]!.args as { amount: number }).amount = -1;
    result.offices[2]![12]!.revision++;
    (result.state.officeTurns![1]![11]![0]!.args as Record<string, unknown>).changed = true;
    expect(result.state.officeTurns![1]![11]![1]!.args).toEqual({});
    expect(state).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
    expect(offices).toEqual(officesCopy);
  });

  it.each(['before', 'after'] as const)('%s에 직책자가 둘이면 임의로 고르지 않는다', (side) => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    (side === 'before' ? state : after).generals[3]!.officerLevel = 5;
    expect(() => syncOffices(deepFreeze(state), deepFreeze(after), deepFreeze(offices))).toThrow(
      PersonnelInvariantError,
    );
  });

  it.each(['before', 'after'] as const)('%s의 직책자가 없는 국가를 가리키면 거부한다', (side) => {
    const { state, offices } = fixture();
    const after = structuredClone(state);
    (side === 'before' ? state : after).generals[4]!.nationId = 999;
    expect(() => syncOffices(state, after, offices)).toThrow(PersonnelInvariantError);
  });

  it.each(['revision', 'tenure'] as const)('%s의 잘못된 값과 정밀도 초과를 거부한다', (field) => {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      const { state, offices } = fixture();
      const after = applied(dismissOfficer(state, 1, 4)).state;
      offices[1]![5]![field] = invalid;
      expect(() => syncOffices(deepFreeze(state), deepFreeze(after), deepFreeze(offices))).toThrow(
        PersonnelInvariantError,
      );
    }
  });
});
