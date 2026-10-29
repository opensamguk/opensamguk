import { z } from 'zod';
import type { RecordedInput, ReplayState } from '../replay';
import type { ReplayOriginV1, ReplayOriginV3 } from '../ruleRegistry';
import { adminClockPayloadSchema } from './admin';

export const ADMIN_END_KIND = 'admin.world.end' as const;
const counter = z.number().int().min(0).max(2_147_483_647);
export const adminEndPayloadSchema = z.strictObject({
  version: z.literal(1),
  confirmName: z.string().min(1),
  expectedRevision: counter.max(2_147_483_646),
  reason: adminClockPayloadSchema.shape.reason,
});
export const adminEndAppliedSchema = z.strictObject({
  version: z.literal(1),
  before: z.strictObject({ status: z.literal('PAUSED'), tick: counter, revision: counter }),
  after: z.strictObject({ status: z.literal('ENDED'), tick: counter, revision: counter }),
  at: z.iso.datetime(),
  finalStateHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const adminEndRejectMessages = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  WORLD_STATE_CHANGED: '월드 상태가 바뀌어 종료하지 않았습니다.',
  WORLD_NAME_CHANGED: '확인한 월드 이름이 달라 종료하지 않았습니다.',
  WORLD_REVISION_CHANGED: '월드 시계가 바뀌어 종료하지 않았습니다.',
  UNSUPPORTED_FORMAT: '이 월드의 재생 형식에서는 사용할 수 없습니다.',
  WORLD_RESULT_EXISTS: '종료 기록이 있어 요청을 적용하지 않았습니다.',
} as const;
export type AdminEndRejectCode = keyof typeof adminEndRejectMessages;
export const adminEndRejectedSchema = z
  .strictObject({
    code: z.enum(Object.keys(adminEndRejectMessages) as [AdminEndRejectCode, ...AdminEndRejectCode[]]),
    message: z.string(),
  })
  .refine((value) => adminEndRejectMessages[value.code] === value.message);

export function checkAdminEndOrigin(
  world: { replayFormat: number; replayOrigin: unknown; ruleFeatures: string[] },
  checkOrigin: (value: unknown) => asserts value is ReplayOriginV1 | ReplayOriginV3,
  hash: (value: unknown) => string,
): void {
  const origin = world.replayOrigin;
  checkOrigin(origin);
  if (
    world.replayFormat !== 3 ||
    origin.version !== 3 ||
    JSON.stringify(origin.initial.ruleFeatures ?? []) !== JSON.stringify(world.ruleFeatures)
  )
    throw new Error('원생성 형식3 월드가 필요합니다.');
  const initial = origin.initial;
  const resources = {
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    ...(initial.operationalMap ? { operationalMap: initial.operationalMap } : {}),
    ...(origin.featureData ? { featureData: origin.featureData } : {}),
  };
  if (origin.initialStateHash !== hash(initial) || origin.resourceHash !== hash(resources))
    throw new Error('원생성 상태·자원 해시가 다릅니다.');
}

export function validateAdminEndRecord(input: RecordedInput): void {
  const keys = ['sequence', 'tick', 'generalId', 'kind', 'status', 'payload', 'result'];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    input.kind !== ADMIN_END_KIND ||
    input.generalId !== null ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > 2_147_483_647
  )
    throw new Error('월드 종료 입력 기록을 확인하세요.');
  const payload = adminEndPayloadSchema.parse(input.payload);
  counter.parse(input.tick);
  if (input.status === 'REJECTED') {
    adminEndRejectedSchema.parse(input.result);
    return;
  }
  if (input.status !== 'APPLIED') throw new Error('완료된 월드 종료 입력이 필요합니다.');
  const result = adminEndAppliedSchema.parse(input.result);
  if (
    result.before.revision !== payload.expectedRevision ||
    result.after.revision !== result.before.revision + 1 ||
    result.before.tick !== result.after.tick ||
    result.after.tick !== input.tick
  )
    throw new Error('월드 종료 적용 결과가 다릅니다.');
}

export function applyAdminEndRecord(replay: ReplayState, input: RecordedInput): ReplayState {
  validateAdminEndRecord(input);
  return replay;
}
