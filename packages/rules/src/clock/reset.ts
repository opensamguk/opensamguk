import { z } from 'zod';
import type { RecordedInput, ReplayState } from '../replay';
import { adminClockPayloadSchema } from './admin';

export const ADMIN_RESET_KIND = 'admin.world.reset' as const;
const storedString = z
  .string()
  .refine(
    (value) =>
      !value.includes('\u0000') &&
      Array.from(value).every((c) => c.length === 2 || c.charCodeAt(0) < 0xd800 || c.charCodeAt(0) > 0xdfff),
  );
const seed = storedString.min(1),
  name = storedString.min(1),
  key = z.string().regex(/^[A-Za-z0-9_-]+$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(2147483647);
const reason = storedString
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && adminClockPayloadSchema.shape.reason.safeParse(value).success);
export const worldResetRequestInput = z.strictObject({
  expectedUserId: z.uuid(),
  worldId: z.uuid(),
  idempotencyKey: z.uuid(),
});
export const requestWorldResetInput = worldResetRequestInput.extend({
  confirmName: name,
  expectedRevision: counter.max(2147483646),
  reason: adminClockPayloadSchema.shape.reason.pipe(reason),
  seed: seed.optional(),
});
export const adminResetIntentSchema = z.strictObject({
  confirmName: name,
  expectedRevision: counter.max(2147483646),
  reason,
  requestedSeed: seed.nullable(),
});
export function adminResetIntent(input: z.infer<typeof requestWorldResetInput>) {
  return adminResetIntentSchema.parse({
    confirmName: input.confirmName,
    expectedRevision: input.expectedRevision,
    reason: input.reason,
    requestedSeed: input.seed ?? null,
  });
}
export const adminResetPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    sourceWorldId: z.uuid(),
    intent: adminResetIntentSchema,
    plannedNewWorldId: z.uuid(),
    effectiveSeed: seed,
  })
  .superRefine((value, ctx) => {
    if (
      value.sourceWorldId === value.plannedNewWorldId ||
      (value.intent.requestedSeed !== null && value.intent.requestedSeed !== value.effectiveSeed)
    )
      ctx.addIssue({ code: 'custom', message: '초기화 요청의 원본·새 월드·시드를 확인하세요.' });
  });
export const adminResetResourceSchema = z.strictObject({
  kind: z.enum(['MAP', 'SCENARIO', 'UNIT_SET', 'STAT_RULES', 'PORTRAIT_MAP']),
  name: key,
  version: z.literal(1),
  contentHash: hash,
});
export const adminResetResourcesSchema = z
  .array(adminResetResourceSchema)
  .length(5)
  .superRefine((rows, ctx) => {
    if (
      new Set(rows.map((row) => row.kind)).size !== 5 ||
      rows.some((row, index) => index > 0 && rows[index - 1]!.kind >= row.kind)
    )
      ctx.addIssue({ code: 'custom', message: '다섯 생성 자원을 종류순으로 확인하세요.' });
  });
export const adminResetSettingsSchema = z
  .strictObject({
    name,
    scenarioKey: key,
    mapKey: key,
    unitSetKey: key,
    presetKey: key.nullable(),
    presetHash: hash.nullable(),
    turnTermMinutes: z.number().int().min(1).max(2147483647),
    endYear: z.number().int().min(1).max(10000).nullable(),
    ruleFeatures: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
      .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value)),
    featureDataHash: hash,
  })
  .refine((value) => (value.presetKey === null) === (value.presetHash === null));
export const adminResetAppliedSchema = z
  .strictObject({
    version: z.literal(1),
    sourceWorldId: z.uuid(),
    newWorldId: z.uuid(),
    effectiveSeed: seed,
    before: z.strictObject({ status: z.literal('PAUSED'), tick: counter, revision: counter.max(2147483646) }),
    after: z.strictObject({ status: z.literal('ENDED'), tick: counter, revision: counter }),
    at: z.iso.datetime(),
    finalStateHash: hash,
    sourceInitialHash: hash,
    sourceResourceHash: hash,
    sourceSettingsHash: hash,
    newInitialHash: hash,
    newResourceHash: hash,
    newSettingsHash: hash,
    resources: adminResetResourcesSchema,
    settings: adminResetSettingsSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.sourceWorldId === value.newWorldId ||
      value.before.tick !== value.after.tick ||
      value.after.revision !== value.before.revision + 1 ||
      value.sourceResourceHash !== value.newResourceHash
    )
      ctx.addIssue({ code: 'custom', message: '초기화 적용 결과가 다릅니다.' });
    for (const [kind, selected] of [
      ['MAP', value.settings.mapKey],
      ['SCENARIO', value.settings.scenarioKey],
      ['UNIT_SET', value.settings.unitSetKey],
    ] as const)
      if (value.resources.find((row) => row.kind === kind)?.name !== selected)
        ctx.addIssue({ code: 'custom', message: '초기화 자원과 설정이 다릅니다.' });
  });
export const adminResetRejectMessages = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  WORLD_STATE_CHANGED: '월드 상태가 바뀌어 초기화하지 않았습니다.',
  WORLD_NAME_CHANGED: '확인한 월드 이름이 달라 초기화하지 않았습니다.',
  WORLD_REVISION_CHANGED: '월드 시계가 바뀌어 초기화하지 않았습니다.',
  UNSUPPORTED_FORMAT: '이 월드의 재생 형식에서는 사용할 수 없습니다.',
  WORLD_RESULT_EXISTS: '종료 기록이 있어 요청을 적용하지 않았습니다.',
  RESOURCE_INVALID: '원본 생성 자료를 확인하지 못해 초기화하지 않았습니다.',
  TARGET_EXISTS: '새 월드 번호가 이미 사용돼 초기화하지 않았습니다.',
} as const;
export type AdminResetRejectCode = keyof typeof adminResetRejectMessages;
export const adminResetRejectedSchema = z
  .strictObject({
    code: z.enum(Object.keys(adminResetRejectMessages) as [AdminResetRejectCode, ...AdminResetRejectCode[]]),
    message: z.string(),
  })
  .refine((value) => value.message === adminResetRejectMessages[value.code]);
export function validateAdminResetRecord(input: RecordedInput, sourceWorldId?: string): void {
  const keys = ['sequence', 'tick', 'generalId', 'kind', 'status', 'payload', 'result'];
  if (
    Object.keys(input).length !== 7 ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    input.kind !== ADMIN_RESET_KIND ||
    input.generalId !== null ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > 2147483647
  )
    throw new Error('월드 초기화 입력 기록을 확인하세요.');
  counter.parse(input.tick);
  const payload = adminResetPayloadSchema.parse(input.payload);
  if (sourceWorldId !== undefined && payload.sourceWorldId !== sourceWorldId)
    throw new Error('초기화 원본 월드가 다릅니다.');
  if (input.status === 'REJECTED') {
    adminResetRejectedSchema.parse(input.result);
    return;
  }
  if (input.status !== 'APPLIED') throw new Error('완료된 월드 초기화 입력이 필요합니다.');
  const result = adminResetAppliedSchema.parse(input.result);
  if (
    result.sourceWorldId !== payload.sourceWorldId ||
    result.newWorldId !== payload.plannedNewWorldId ||
    result.effectiveSeed !== payload.effectiveSeed ||
    result.before.revision !== payload.intent.expectedRevision ||
    result.after.tick !== input.tick ||
    result.settings.name !== payload.intent.confirmName
  )
    throw new Error('초기화 요청과 적용 결과가 다릅니다.');
}
export function applyAdminResetRecord(replay: ReplayState, input: RecordedInput): ReplayState {
  validateAdminResetRecord(input);
  return replay;
}
