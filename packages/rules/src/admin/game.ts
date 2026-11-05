import { z } from 'zod';
import { BALANCE } from '../balance';
import { adminClockPayloadSchema, adminClockRejectMessages } from '../clock/admin';
import { generalCreationSchema } from '../general/create';

const quantity = z.number().int().min(0).max(2_147_483_647);
const id = quantity.min(1);
const change = <T extends z.ZodType<number>>(value: T) => z.strictObject({ expected: value, value });

export const adminGeneralChangesSchema = z
  .strictObject({
    gold: change(quantity).optional(),
    rice: change(quantity).optional(),
    cityKey: change(id).optional(),
    crew: change(quantity).optional(),
    crewType: change(id).optional(),
    train: change(quantity.max(100)).optional(),
    atmos: change(quantity.max(100)).optional(),
  })
  .refine((values) => Object.values(values).some((value) => value !== undefined), '바꿀 칸을 고르세요.');
export const adminCityChangesSchema = z
  .strictObject({
    population: change(quantity).optional(),
    agriculture: change(quantity).optional(),
    commerce: change(quantity).optional(),
    security: change(quantity).optional(),
    defence: change(quantity).optional(),
    wall: change(quantity).optional(),
    trust: change(z.number().min(0).max(BALANCE.MAX_TRUST)).optional(),
  })
  .refine((values) => Object.values(values).some((value) => value !== undefined), '바꿀 칸을 고르세요.');
export const adminNationChangesSchema = z
  .strictObject({
    gold: change(quantity).optional(),
    rice: change(quantity).optional(),
    tech: change(z.number().min(0).max(BALANCE.MAX_TECH)).optional(),
  })
  .refine((values) => Object.values(values).some((value) => value !== undefined), '바꿀 칸을 고르세요.');

// 군주 교체·해산은 공통 상태 전이가 나온 뒤 붙인다.
export const ADMIN_GAME_KINDS = [
  'admin.general.rename',
  'admin.general.release',
  'admin.general.clearTurns',
  'admin.general.remove',
  'admin.general.adjust',
  'admin.city.adjust',
  'admin.nation.adjust',
  'admin.nation.rename',
  'admin.nation.dismissOffice',
  'admin.message.send',
] as const;
export const adminGameActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('admin.general.rename'), generalId: id, name: generalCreationSchema.shape.name }),
  z.strictObject({ kind: z.literal('admin.general.release'), generalId: id }),
  z.strictObject({ kind: z.literal('admin.general.clearTurns'), generalId: id }),
  z.strictObject({ kind: z.literal('admin.general.remove'), generalId: id }),
  z.strictObject({ kind: z.literal('admin.general.adjust'), generalId: id, changes: adminGeneralChangesSchema }),
  z.strictObject({ kind: z.literal('admin.city.adjust'), cityKey: id, changes: adminCityChangesSchema }),
  z.strictObject({ kind: z.literal('admin.nation.adjust'), nationId: id, changes: adminNationChangesSchema }),
  z.strictObject({ kind: z.literal('admin.nation.rename'), nationId: id, name: z.string().trim().min(1).max(30) }),
  z.strictObject({ kind: z.literal('admin.nation.dismissOffice'), nationId: id, generalId: id }),
  z
    .strictObject({
      kind: z.literal('admin.message.send'),
      scope: z.enum(['WORLD', 'PRIVATE']),
      generalId: id.optional(),
      body: z.string().refine((value) => value.trim().length > 0 && [...value].length <= 1000),
    })
    .refine((action) => (action.scope === 'PRIVATE') === (action.generalId !== undefined)),
]);
export const adminGamePayloadSchema = z.strictObject({
  version: z.literal(1),
  reason: adminClockPayloadSchema.shape.reason,
  action: adminGameActionSchema,
});
export const adminGameRejectMessages = {
  ...adminClockRejectMessages,
  TARGET_MISSING: '조치 대상이 없거나 이미 퇴장했습니다.',
  TARGET_CHANGED: '대상의 값이 바뀌어 요청을 적용하지 않았습니다.',
  CAMPAIGN_FIELD: '부곡을 쓰는 월드에서는 장수의 병력 칸을 고칠 수 없습니다.',
  INVALID_VALUE: '변경할 값이나 대상 조건을 확인하세요.',
} as const;
export type AdminGameAction = z.infer<typeof adminGameActionSchema>;
export type AdminGamePayload = z.infer<typeof adminGamePayloadSchema>;
export type AdminGameRejectCode = keyof typeof adminGameRejectMessages;

export function isAdminGameKind(kind: string): kind is (typeof ADMIN_GAME_KINDS)[number] {
  return (ADMIN_GAME_KINDS as readonly string[]).includes(kind);
}
