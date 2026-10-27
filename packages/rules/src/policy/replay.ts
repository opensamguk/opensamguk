import { z } from 'zod';
import type { ReplayState, RecordedInput } from '../replay';
import { emptyQueue, POLICY_KEYS, type PolicyKey } from './index';
import { fiveStatsSchema } from '../general/fiveStats';

export const policyKeySchema = z.enum(POLICY_KEYS);
export const setPolicyPayloadSchema = z.strictObject({ policy: policyKeySchema });
export const activityPayloadSchema = z.strictObject({});
export const policyTickSchema = z.number().int().min(0).max(2_147_483_647);
const positive = policyTickSchema.min(1);
export const emptyGeneralIdsSchema = z
  .array(positive)
  .refine((ids) => ids.every((id, i) => i === 0 || ids[i - 1]! < id));
export const policyFormatSchema = z.strictObject({
  version: z.literal(1),
  fromSequence: policyTickSchema,
  turnTermMinutes: positive,
});
export type PolicyFormat = z.infer<typeof policyFormatSchema>;
export const policyMarkerPayloadSchema = z.strictObject({ version: z.literal(5), emptySlots: emptyGeneralIdsSchema });
export const policyMarkerResultSchema = z
  .strictObject({
    fromSequence: positive,
    emptySlots: emptyGeneralIdsSchema,
    clockTick: policyTickSchema,
    turnTermMinutes: positive,
    baselineActiveTick: policyTickSchema.nullable(),
  })
  .refine((value) => value.baselineActiveTick === null || value.baselineActiveTick <= value.clockTick);
export const policySlotSchema = z
  .strictObject({ commandKey: z.string().min(1), args: z.unknown(), explicit: z.boolean() })
  .refine(
    (slot) =>
      Object.hasOwn(slot, 'args') &&
      (slot.explicit ||
        (slot.commandKey === 'rest' &&
          slot.args !== null &&
          typeof slot.args === 'object' &&
          !Array.isArray(slot.args) &&
          Object.keys(slot.args).length === 0)),
  );
export const POLICY_INPUT_KINDS = [
  'turns.set',
  'general.create',
  'general.setPolicy',
  'general.active',
  'system.policy.enable',
] as const;
const envelopeSchema = z.strictObject({
  sequence: positive,
  generalId: positive.nullable(),
  kind: z.enum(POLICY_INPUT_KINDS),
  status: z.enum(['APPLIED', 'REJECTED']),
  payload: z.unknown(),
  result: z.unknown(),
});
const rejectionSchema = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });
const generalNumericKeys = [
  'affinity',
  'cityKey',
  'leadership',
  'strength',
  'intel',
  'officerLevel',
  'birthYear',
  'deathYear',
  'activeFromYear',
  'gold',
  'rice',
  'crew',
  'crewType',
  'train',
  'atmos',
  'experience',
  'dedication',
  'age',
  'injury',
] as const;
const recordedGeneralSchema = z.strictObject({
  ...Object.fromEntries(generalNumericKeys.map((key) => [key, z.number().finite()])),
  id: positive,
  nextTurnTick: policyTickSchema,
  userId: z.string().min(1),
  name: z.string(),
  portraitId: z.number().nullable(),
  nationId: z.number().nullable(),
  personality: z.string().nullable(),
  special: z.string().nullable(),
});

// archive 5와 형식3 정책 기능 검사. 5능력치는 명시한 새 판에서만 받는다.
export function validatePolicyRecordedInput(
  value: unknown,
  modern: boolean,
  five = false,
): asserts value is RecordedInput {
  const input = envelopeSchema.parse(value);
  if (!modern && input.kind !== 'turns.set' && input.kind !== 'general.create')
    throw new Error('전환 전 방침 입력입니다.');
  if (input.status === 'REJECTED') {
    if (input.kind === 'system.policy.enable') throw new Error('전환 표지는 거절 상태일 수 없습니다.');
    rejectionSchema.parse(input.result);
    return;
  }
  if (input.kind === 'system.policy.enable') {
    if (!modern || input.generalId !== null) throw new Error('전환 표지의 순서나 장수가 올바르지 않습니다.');
    policyMarkerPayloadSchema.parse(input.payload);
    policyMarkerResultSchema.parse(input.result);
    return;
  }
  if (input.generalId === null) throw new Error('적용된 입력에 장수가 없습니다.');
  if (input.kind === 'turns.set') {
    const slot = modern ? policySlotSchema : z.strictObject({ commandKey: z.string(), args: z.unknown() });
    z.strictObject({ turns: z.array(slot).length(30), revision: policyTickSchema }).parse(input.payload);
    (modern
      ? z.strictObject({ revision: positive, activeTick: policyTickSchema })
      : z.strictObject({ revision: positive })
    ).parse(input.result);
  } else if (input.kind === 'general.create') {
    const general = five ? recordedGeneralSchema.extend(fiveStatsSchema.shape) : recordedGeneralSchema;
    (modern ? z.strictObject({ general, activeTick: policyTickSchema }) : z.strictObject({ general })).parse(
      input.result,
    );
  } else {
    if (!modern) throw new Error('전환 전 방침 입력입니다.');
    if (input.kind === 'general.setPolicy') {
      const payload = setPolicyPayloadSchema.parse(input.payload);
      const result = z.strictObject({ policy: policyKeySchema, activeTick: policyTickSchema }).parse(input.result);
      if (payload.policy !== result.policy) throw new Error('방침 접수와 집행 값이 다릅니다.');
    } else {
      activityPayloadSchema.parse(input.payload);
      z.strictObject({ activeTick: policyTickSchema }).parse(input.result);
    }
  }
}

export interface ReplayPolicy {
  turnTermMinutes: number;
  policies: Record<number, PolicyKey>;
  lastActiveTicks: Record<number, number>;
}

export function enableReplayPolicy(
  replay: ReplayState,
  turnTermMinutes: number,
  baselineActiveTick: number | null,
  emptyIds?: readonly number[],
): ReplayState {
  const next = structuredClone(replay);
  const ids = Object.keys(next.state.generals).map(Number);
  const empty = new Set(emptyIds ?? ids);
  const humans = ids.filter((id) => next.state.generals[id]!.userId !== null);
  const lastActiveTicks: Record<number, number> = {};
  if (baselineActiveTick === null) {
    if (humans.length) throw new Error('사람 장수의 활동 기준이 없습니다.');
  } else for (const id of humans) lastActiveTicks[id] = baselineActiveTick;
  next.policy = {
    turnTermMinutes,
    policies: Object.fromEntries(ids.map((id) => [id, 'none' as const])),
    lastActiveTicks,
  };
  for (const id of ids)
    next.turns[id] = empty.has(id) ? emptyQueue() : next.turns[id]!.map((slot) => ({ ...slot, explicit: true }));
  return next;
}

export function assertReplayPolicy(replay: ReplayState): void {
  if (!replay.policy) return;
  const generals = Object.keys(replay.state.generals).sort();
  const humans = generals.filter((id) => replay.state.generals[Number(id)]!.userId !== null);
  if (
    JSON.stringify(Object.keys(replay.policy.policies).sort()) !== JSON.stringify(generals) ||
    JSON.stringify(Object.keys(replay.policy.lastActiveTicks).sort()) !== JSON.stringify(humans)
  )
    throw new Error('방침·활동 지도의 장수가 상태와 다릅니다.');
  for (const id of generals) {
    policyKeySchema.parse(replay.policy.policies[Number(id)]);
    z.array(policySlotSchema).length(30).parse(replay.turns[Number(id)]);
  }
  for (const id of humans) policyTickSchema.parse(replay.policy.lastActiveTicks[Number(id)]);
}
