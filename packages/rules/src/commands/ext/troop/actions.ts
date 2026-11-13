import { z } from 'zod';
import type { DeepReadonly, WorldView } from '../../../model/world';
import { reconcileTroops, troopName, type TroopSlice } from './state';

export const TROOP_ACTION_KIND = 'troop.update';
const id = z.number().int().positive();
const name = z.string().max(120);
export const troopActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), name }),
  z.strictObject({ action: z.literal('rename'), name }),
  z.strictObject({ action: z.literal('join'), leaderId: id }),
  z.strictObject({ action: z.literal('leave') }),
  z.strictObject({ action: z.literal('kick'), memberId: id }),
]);
export type TroopAction = z.infer<typeof troopActionSchema>;

type Outcome = { ok: true; slice: TroopSlice; changed: number[] } | { ok: false; code: string; message: string };
const fail = (code: string, message: string): Outcome => ({ ok: false, code, message });
const success = (slice: TroopSlice, changed: number[]): Outcome => ({
  ok: true,
  slice,
  changed: changed.sort((a, b) => a - b),
});

export function troopOf(source: DeepReadonly<TroopSlice>, generalId: number) {
  return Object.values(source.troops).find((row) => row.leaderId === generalId || row.members.includes(generalId));
}

export function changeTroop(
  view: WorldView,
  source: DeepReadonly<TroopSlice>,
  actorId: number,
  input: TroopAction,
): Outcome {
  const actor = view.generals[actorId];
  if (!actor || actor.removedAt !== undefined) return fail('NO_ACTOR', '장수가 없습니다.');
  const state = reconcileTroops(view, source);
  const membership = troopOf(state, actorId);
  const leader = state.troops[actorId];
  switch (input.action) {
    case 'create': {
      if (actor.nationId === null || !view.nations[actor.nationId])
        return fail('NOT_NATION', '국가에 소속되어야 합니다.');
      if (membership) return fail('IN_TROOP', '이미 부대에 소속되어 있습니다.');
      const name = troopName(input.name);
      if (!name) return fail('BAD_NAME', '부대 이름은 한글 9자 또는 영문 18자 이내로 입력하세요.');
      state.troops[actorId] = { leaderId: actorId, nationId: actor.nationId, name, members: [] };
      return success(state, [actorId]);
    }
    case 'join': {
      if (membership) return fail('IN_TROOP', '이미 부대에 소속되어 있습니다.');
      if (actor.nationId === null || !view.nations[actor.nationId])
        return fail('NOT_NATION', '국가에 소속되어야 합니다.');
      const row = state.troops[input.leaderId];
      if (!row || row.nationId !== actor.nationId) return fail('BAD_TROOP', '가입할 수 있는 부대가 아닙니다.');
      row.members.push(actorId);
      row.members.sort((a, b) => a - b);
      return success(state, [actorId]);
    }
    case 'leave': {
      if (!membership) return fail('NOT_IN_TROOP', '소속 부대가 없습니다.');
      if (leader) {
        delete state.troops[actorId];
        return success(state, [actorId, ...leader.members]);
      }
      const row = state.troops[membership.leaderId]!;
      row.members = row.members.filter((id) => id !== actorId);
      return success(state, [actorId]);
    }
    case 'kick':
      if (!leader) return fail('NOT_LEADER', '부대장이 아닙니다.');
      if (input.memberId === actorId) return fail('LEADER_TARGET', '부대장은 추방할 수 없습니다.');
      if (!leader.members.includes(input.memberId)) return fail('NOT_MEMBER', '부대원이 아닙니다.');
      leader.members = leader.members.filter((id) => id !== input.memberId);
      return success(state, [input.memberId]);
    case 'rename': {
      if (!leader) return fail('NOT_LEADER', '부대장이 아닙니다.');
      const name = troopName(input.name);
      if (!name) return fail('BAD_NAME', '부대 이름은 한글 9자 또는 영문 18자 이내로 입력하세요.');
      leader.name = name;
      return success(state, [actorId]);
    }
  }
}
