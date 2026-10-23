import { z } from 'zod';
import { commandRegistry } from '../commands/registry';
import type { DeepReadonly } from '../model/world';
import { appointOfficer, dismissOfficer } from './appointments';
import { closeInvalidOffers, respondAssignment } from './assignments';
import { syncOffices, type OfficeRevisions, type OfficeState, type OfficeView } from './offices';
import { canExecuteNationCommand, canUseNationTurns } from './permissions';
import {
  clonePersonnel,
  PersonnelInvariantError,
  type PersonnelChange,
  type PersonnelLog,
  type ClosedOffer,
} from './types';

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = natural.min(1);
const tickResult = { tick: natural };
const appointPayload = z.strictObject({ generalId: z.number().int().safe(), officerLevel: z.number().int().safe() });
const dismissPayload = z.strictObject({ generalId: z.number().int().safe() });
const respondPayload = z.strictObject({ offerId: z.string(), accept: z.boolean() });
const slot = z
  .strictObject({ commandKey: z.string(), args: z.unknown() })
  .refine((value) => Object.hasOwn(value, 'args'));
const turnsPayload = z.strictObject({
  office: z.strictObject({ nationId: positive, officerLevel: z.number().int().min(5).max(12), tenure: natural }),
  revision: natural,
  turns: z.array(slot).length(12),
});
const appointResult = z.strictObject({
  ...tickResult,
  generalId: positive,
  officerLevel: z.number().int().min(5).max(11),
  title: z.string().min(1),
});
const dismissResult = z.strictObject({
  ...tickResult,
  generalId: positive,
  officerLevel: z.literal(1),
  title: z.string().min(1),
});
const respondResult = z.strictObject({
  ...tickResult,
  offerStatus: z.enum(['ACCEPTED', 'REJECTED']),
  city: z.strictObject({ cityKey: positive, name: z.string() }),
  dedicationLost: natural,
});
const commonCodes = ['WORLD_CLOSED', 'ACTOR_INACTIVE', 'NO_GENERAL'] as const;
const appointCodes = [...commonCodes, 'NOT_NATION', 'NOT_RULER', 'BAD_ARGS', 'BAD_TARGET', 'BAD_STATE'] as const;
const dismissCodes = [...commonCodes, 'NOT_NATION', 'NOT_RULER', 'BAD_TARGET'] as const;
const respondCodes = [...commonCodes, 'OFFER_CLOSED'] as const;
export const PERSONNEL_INPUTS = Object.freeze({
  'personnel.appoint': Object.freeze({
    payloadSchema: appointPayload,
    appliedResultSchema: appointResult,
    rejectedCodes: Object.freeze(appointCodes),
  }),
  'personnel.dismiss': Object.freeze({
    payloadSchema: dismissPayload,
    appliedResultSchema: dismissResult,
    rejectedCodes: Object.freeze(dismissCodes),
  }),
  'offer.respond': Object.freeze({
    payloadSchema: respondPayload,
    appliedResultSchema: respondResult,
    rejectedCodes: Object.freeze(respondCodes),
  }),
  'nationTurns.set': Object.freeze({
    payloadSchema: turnsPayload,
    appliedResultSchema: z.strictObject({ revision: natural }),
    rejectedCodes: Object.freeze([]),
  }),
});
export type PersonnelInputKind = 'personnel.appoint' | 'personnel.dismiss' | 'offer.respond';
export type PersonnelRecordKind = keyof typeof PERSONNEL_INPUTS;
export type PersonnelRejectCode =
  (typeof appointCodes)[number] | (typeof dismissCodes)[number] | (typeof respondCodes)[number];
const envelope = { sequence: positive.max(2_147_483_647), generalId: positive };
const rejected = <T extends readonly [string, ...string[]]>(codes: T) =>
  z.strictObject({ ...tickResult, code: z.enum(codes), message: z.string().min(1) });
const recordSchema = z.union([
  z.strictObject({
    ...envelope,
    kind: z.literal('personnel.appoint'),
    status: z.literal('APPLIED'),
    payload: appointPayload,
    result: appointResult,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('personnel.appoint'),
    status: z.literal('REJECTED'),
    payload: appointPayload,
    result: rejected(appointCodes),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('personnel.dismiss'),
    status: z.literal('APPLIED'),
    payload: dismissPayload,
    result: dismissResult,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('personnel.dismiss'),
    status: z.literal('REJECTED'),
    payload: dismissPayload,
    result: rejected(dismissCodes),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('offer.respond'),
    status: z.literal('APPLIED'),
    payload: respondPayload,
    result: respondResult,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('offer.respond'),
    status: z.literal('REJECTED'),
    payload: respondPayload,
    result: rejected(respondCodes),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('nationTurns.set'),
    status: z.literal('APPLIED'),
    payload: turnsPayload,
    result: PERSONNEL_INPUTS['nationTurns.set'].appliedResultSchema,
  }),
]);
export type PersonnelRecordedInput = z.infer<typeof recordSchema>;
export type AppliedPersonnelInput = Extract<PersonnelRecordedInput, { kind: PersonnelInputKind; status: 'APPLIED' }>;
export type NationTurnsRecord = Extract<PersonnelRecordedInput, { kind: 'nationTurns.set' }>;
export type PendingPersonnelEvent = Readonly<{
  kind: string;
  userId: string;
  generalId: number | null;
  idempotencyKey: string;
  payload: unknown;
}>;
export type PersonnelInputContext = Readonly<{
  tick: number;
  worldStatus: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
  userActive: boolean;
}>;
export type PersonnelInputOutcome =
  | { status: 'APPLIED'; change: PersonnelChange & { state: OfficeState }; result: AppliedPersonnelInput['result'] }
  | { status: 'REJECTED'; result: { tick: number; code: PersonnelRejectCode; message: string } };
export type PersonnelStepResult = {
  state: OfficeState;
  offices: OfficeRevisions;
  closedOffers: ClosedOffer[];
  logs: PersonnelLog[];
};
export type PersonnelRecordContext = Readonly<{ monthlyTick: number; endTick?: number }>;
const pendingSchema = z.strictObject({
  kind: z.enum(['personnel.appoint', 'personnel.dismiss', 'offer.respond']),
  userId: z.string().min(1),
  generalId: positive,
  idempotencyKey: z
    .string()
    .refine((key) => key.startsWith('personnel:') && z.uuid().safeParse(key.slice('personnel:'.length)).success),
  payload: z.unknown(),
});
const contextSchema = z.strictObject({
  tick: natural,
  worldStatus: z.enum(['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED']),
  userActive: z.boolean(),
});

function invariant(message: string): never {
  throw new PersonnelInvariantError(message);
}
function applyDomain(view: OfficeView, generalId: number, kind: PersonnelInputKind, payload: unknown, tick: number) {
  switch (kind) {
    case 'personnel.appoint': {
      const args = appointPayload.parse(payload);
      return appointOfficer(view, generalId, args.generalId, args.officerLevel);
    }
    case 'personnel.dismiss':
      return dismissOfficer(view, generalId, dismissPayload.parse(payload).generalId);
    case 'offer.respond': {
      const args = respondPayload.parse(payload);
      return respondAssignment(view, generalId, args.offerId, args.accept, tick);
    }
  }
}

// 저장행의 월드·PENDING·빈 sequence/result와 잠금은 호출자가 먼저 확인한다.
export function applyPersonnelInput(
  view: OfficeView,
  event: PendingPersonnelEvent,
  context: PersonnelInputContext,
): PersonnelInputOutcome {
  const parsed = pendingSchema.parse(event);
  PERSONNEL_INPUTS[parsed.kind].payloadSchema.parse(parsed.payload);
  const current = contextSchema.parse(context);
  const reject = (code: PersonnelRejectCode, message: string): PersonnelInputOutcome => ({
    status: 'REJECTED',
    result: { tick: current.tick, code, message },
  });
  if (current.worldStatus !== 'RUNNING') return reject('WORLD_CLOSED', '진행 중인 월드가 아닙니다.');
  if (!current.userActive) return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  const actor = view.generals[parsed.generalId];
  if (!actor || actor.userId !== parsed.userId) return reject('NO_GENERAL', '내 장수가 아닙니다.');
  const outcome = applyDomain(view, parsed.generalId, parsed.kind, parsed.payload, current.tick);
  if (!outcome.ok) {
    // 행위자와 payload 구조는 위에서 검사했다. 나머지 실패는 기록 표에 있어야 한다.
    const result = rejected(PERSONNEL_INPUTS[parsed.kind].rejectedCodes).parse({
      tick: current.tick,
      code: outcome.code,
      message: outcome.message,
    });
    return { status: 'REJECTED', result };
  }
  return { status: 'APPLIED', change: outcome, result: { ...outcome.result, tick: current.tick } };
}

export function validatePersonnelRecord(value: unknown, context: PersonnelRecordContext): PersonnelRecordedInput {
  const record = recordSchema.parse(value);
  if (record.kind === 'nationTurns.set') {
    if (record.result.revision !== record.payload.revision + 1) invariant('직책 칸 revision 기록이 다릅니다.');
    return record;
  }
  const bounds = z.strictObject({ monthlyTick: natural, endTick: natural.optional() }).parse(context);
  if (record.result.tick < bounds.monthlyTick) invariant('인사 입력이 월간 정산보다 앞섭니다.');
  if (
    bounds.endTick !== undefined &&
    (record.status !== 'REJECTED' || record.result.code !== 'WORLD_CLOSED' || record.result.tick < bounds.endTick)
  )
    invariant('종료 뒤 인사 입력 기록이 올바르지 않습니다.');
  return record;
}

export function replayPersonnelInput(
  view: OfficeView,
  record: AppliedPersonnelInput,
): PersonnelChange & { state: OfficeState } {
  const outcome = applyDomain(view, record.generalId, record.kind, record.payload, record.result.tick);
  if (!outcome.ok) invariant('인사 입력을 재생할 수 없습니다.');
  const actual = { ...outcome.result, tick: record.result.tick };
  const schema = PERSONNEL_INPUTS[record.kind].appliedResultSchema;
  if (JSON.stringify(schema.parse(actual)) !== JSON.stringify(schema.parse(record.result)))
    invariant('인사 입력 결과가 기록과 다릅니다.');
  return outcome;
}

export function finishPersonnelStep(
  before: OfficeView,
  change: Readonly<{ state: OfficeView; closedOffers: readonly ClosedOffer[]; logs: readonly PersonnelLog[] }>,
  offices: DeepReadonly<OfficeRevisions>,
  tick: number,
): PersonnelStepResult {
  const synced = syncOffices(before, change.state, offices);
  const cancelled = closeInvalidOffers(synced.state, tick);
  const closedOffers = [...change.closedOffers, ...cancelled.closedOffers];
  const remaining = new Set(Object.values(cancelled.state.assignmentOffers ?? {}).map((offer) => offer.id));
  // 국가 발령 뒤 개인 탈국이 실행되면 같은 턴에 새 제안이 생겼다가 취소될 수 있다.
  const pending = new Set(
    [...Object.values(before.assignmentOffers ?? {}), ...Object.values(change.state.assignmentOffers ?? {})].map(
      (offer) => offer.id,
    ),
  );
  const removed = [...pending].filter((id) => !remaining.has(id)).sort();
  const closed = closedOffers.map((offer) => offer.id).sort();
  if (new Set(closed).size !== closed.length || JSON.stringify(removed) !== JSON.stringify(closed))
    invariant('발령 제안 종료 기록이 상태와 다릅니다.');
  return { state: cancelled.state, offices: synced.offices, closedOffers, logs: [...change.logs, ...cancelled.logs] };
}

export function applyNationTurnsRecord(
  view: OfficeView,
  offices: DeepReadonly<OfficeRevisions>,
  record: NationTurnsRecord,
): { state: OfficeState; offices: OfficeRevisions } {
  const parsed = validatePersonnelRecord(record, { monthlyTick: 0 });
  if (parsed.kind !== 'nationTurns.set') invariant('직책 칸 입력이 아닙니다.');
  const actor = view.generals[parsed.generalId];
  const { office, revision, turns } = parsed.payload;
  const old = offices[office.nationId]?.[office.officerLevel] ?? { revision: 0, tenure: 0 };
  if (
    !actor ||
    !view.nations[office.nationId] ||
    !canUseNationTurns(actor.officerLevel) ||
    actor.nationId !== office.nationId ||
    actor.officerLevel !== office.officerLevel ||
    old.tenure !== office.tenure ||
    old.revision !== revision
  )
    invariant('직책 칸의 장수·직책·revision이 다릅니다.');
  for (const turn of turns) {
    const command = commandRegistry.get(turn.commandKey);
    if (
      !command ||
      command.category !== 'nation' ||
      !canExecuteNationCommand(actor.officerLevel, turn.commandKey) ||
      !command.args.safeParse(turn.args).success
    )
      invariant('직책 칸 명령과 인자가 올바르지 않습니다.');
  }
  const state: OfficeState = clonePersonnel(view);
  const next: OfficeRevisions = structuredClone(offices);
  (state.officeTurns ??= {})[office.nationId] ??= {};
  state.officeTurns[office.nationId]![office.officerLevel] = structuredClone(turns);
  (next[office.nationId] ??= {})[office.officerLevel] = { revision: parsed.result.revision, tenure: old.tenure };
  return { state, offices: next };
}
