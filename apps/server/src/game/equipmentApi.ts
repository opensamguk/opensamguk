import { TRPCError } from '@trpc/server';
import {
  equipmentSlotSchema,
  TREATMENT_TOOL,
  MORALE_TOOL,
  hasMoraleTool,
  equipmentTools,
  toolSaleProceeds,
  hasTreatmentTool,
  equipmentBonus,
  fiveStatsSchema,
  withEquipmentBonus,
} from '@opensamguk/rules';
import { requirePersonnelSession } from './personnelAdmission';
import { personnelIdentity, type PersonnelActorContext } from './personnelApi';
import { requireWorld, requireGeneral, requireRuleFeature, readView } from './queries';
import { worldResolver } from './resolver';

export function readEquipmentBoard(ctx: PersonnelActorContext, worldId: string, started = performance.now()) {
  return ctx.db.$transaction(
    async (tx) => {
      await requirePersonnelSession(tx, personnelIdentity(ctx, started));
      const world = await requireWorld(tx, worldId);
      const general = await requireGeneral(tx, worldId, ctx.user.id);
      requireRuleFeature(world, 'equipment-v1');
      const state = await readView(tx, worldId),
        equipment = state.equipment!;
      const command = worldResolver(world)
        .resolver.list('general')
        .find((entry) => entry.key === 'equipment_trade');
      if (!command) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '장비 명령을 준비하지 못했습니다.' });
      const slots = equipment.generals[String(general.id)] ?? {};
      const actor = { generalId: general.id };
      const { leadership, strength, intel, politics, charm } = state.generals[general.id]!;
      const baseStats = fiveStatsSchema.parse({ leadership, strength, intel, politics, charm });
      const toolEntry = (tool: (typeof equipmentTools)[keyof typeof equipmentTools]) => ({
        ...tool,
        remainingCharges: slots.tool?.key === tool.key ? slots.tool.charges : 0,
        failure: command.check(state, actor, { slot: 'tool', itemKey: tool.key }),
        sale: {
          proceeds: slots.tool ? toolSaleProceeds(slots.tool, equipment.config.sellRateBp) : 0,
          failure: command.check(state, actor, { slot: 'tool', itemKey: 'none' }),
        },
      });
      return {
        generalId: general.id,
        slots,
        ...(hasTreatmentTool(equipment.config)
          ? { tool: toolEntry(slots.tool ? equipmentTools[slots.tool.key] : TREATMENT_TOOL) }
          : {}),
        ...(hasMoraleTool(equipment.config) ? { tools: [toolEntry(TREATMENT_TOOL), toolEntry(MORALE_TOOL)] } : {}),
        baseStats,
        stats: withEquipmentBonus(state, general.id, baseStats),
        bonus: equipmentBonus(state, general.id),
        sellRateBp: equipment.config.sellRateBp,
        tradeExperience: equipment.config.tradeExperience,
        // 게임 내 조건이다. 예턴 편집·실행의 세션·제재·진행 상태 검사는 기존 경로가 맡는다.
        items: equipment.config.items.map((item) => ({
          ...item,
          failure: command.check(state, actor, { slot: item.slot, itemKey: item.key }),
        })),
        sales: equipmentSlotSchema.options.map((slot) => {
          const held = equipment.config.items.find((item) => item.key === slots[slot]);
          return {
            slot,
            proceeds: held ? Math.floor((held.cost * equipment.config.sellRateBp) / 10_000) : 0,
            failure: command.check(state, actor, { slot, itemKey: 'none' }),
          };
        }),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
