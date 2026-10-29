import { z } from 'zod';
import type { RecordedInput, ReplayState } from '../replay';

export const ADMIN_CLOCK_KINDS = ['admin.world.start', 'admin.world.pause', 'admin.world.resume'] as const;
export const adminClockActionSchema = z.enum(['start', 'pause', 'resume']);
export type AdminClockAction = z.infer<typeof adminClockActionSchema>;
export const adminClockPayloadSchema = z.strictObject({
  version: z.literal(1),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
});
export const adminClockExpectedStatus = { start: 'PREOPEN', pause: 'RUNNING', resume: 'PAUSED' } as const;
export const adminClockRejectMessages = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  WORLD_STATE_CHANGED: '월드 상태가 바뀌어 요청을 적용하지 않았습니다.',
  UNSUPPORTED_FORMAT: '이 월드의 재생 형식에서는 사용할 수 없습니다.',
} as const;
export type AdminClockRejectCode = keyof typeof adminClockRejectMessages;
const tick = z.number().int().min(0).max(2_147_483_647);
const revision = z.number().int().min(0).max(2_147_483_647);
const snapshot = z.strictObject({ status: z.enum(['PREOPEN', 'RUNNING', 'PAUSED', 'ENDED']), tick, revision });
export const adminClockAppliedSchema = z.strictObject({
  version: z.literal(1),
  before: snapshot,
  after: snapshot,
  at: z.iso.datetime(),
});
export const adminClockRejectedSchema = z
  .strictObject({
    code: z.enum(['ACTOR_INACTIVE', 'ADMIN_REQUIRED', 'ACTOR_SANCTIONED', 'WORLD_STATE_CHANGED', 'UNSUPPORTED_FORMAT']),
    message: z.string(),
  })
  .refine((result) => adminClockRejectMessages[result.code] === result.message);
export function isAdminClockKind(kind: string): kind is (typeof ADMIN_CLOCK_KINDS)[number] {
  return (ADMIN_CLOCK_KINDS as readonly string[]).includes(kind);
}
export function validateAdminClockRecord(input: RecordedInput): void {
  const keys = ['sequence', 'tick', 'generalId', 'kind', 'status', 'payload', 'result'];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    !isAdminClockKind(input.kind) ||
    input.generalId !== null ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > 2_147_483_647
  )
    throw new Error('월드 시계 입력 기록을 확인하세요.');
  adminClockPayloadSchema.parse(input.payload);
  tick.parse(input.tick);
  if (input.status === 'REJECTED') {
    adminClockRejectedSchema.parse(input.result);
    return;
  }
  if (input.status !== 'APPLIED') throw new Error('완료된 월드 시계 입력이 필요합니다.');
  const result = adminClockAppliedSchema.parse(input.result),
    action = input.kind.slice('admin.world.'.length) as AdminClockAction;
  if (
    result.before.status !== adminClockExpectedStatus[action] ||
    result.after.status !== (action === 'pause' ? 'PAUSED' : 'RUNNING') ||
    result.after.revision !== result.before.revision + 1 ||
    result.after.tick < result.before.tick ||
    result.after.tick !== input.tick ||
    (action !== 'pause' && result.after.tick !== result.before.tick)
  )
    throw new Error('월드 시계 적용 결과가 다릅니다.');
}
// 시계 조치는 게임 상태·난수·예턴을 바꾸지 않는다. 외부 시계 기록 자체는 엄격히 검증한다.
export function applyAdminClockRecord(replay: ReplayState, input: RecordedInput): ReplayState {
  validateAdminClockRecord(input);
  return replay;
}
