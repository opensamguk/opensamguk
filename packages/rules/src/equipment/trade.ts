import { z } from 'zod';
import { defineCommand, fail, ownCity, success } from '../commands/support';
import { checkCityGoods, consumeCityGoods } from '../logistics/consumption';
import { LINEAGE_EXITED_YEAR } from '../lineage/config';
import {
  EQUIPMENT_MAX,
  MORALE_TOOL,
  TREATMENT_TOOL,
  availableEquipmentTools,
  hasTreatmentTool,
  equipmentKeySchema,
  equipmentSlotSchema,
  equipmentTools,
  buyableEquipmentToolKeySchema,
  availableRareEquipmentTools,
  rareEquipmentKeySchema,
  toolSaleProceeds,
} from './config';
import { readEquipmentState } from './state';

const argsSchema = z.union([
  z.strictObject({ slot: equipmentSlotSchema, itemKey: z.union([z.literal('none'), equipmentKeySchema]) }),
  z.strictObject({ slot: z.literal('tool'), itemKey: z.union([z.literal('none'), buyableEquipmentToolKeySchema]) }),
]);
const proceeds = (cost: number, rate: number) => Math.floor((cost * rate) / 10_000);

// D-070: 기존 예턴 한 칸에서 개인 금·장착·도시 재료를 함께 바꾼다.
export const equipmentTrade = defineCommand({
  key: 'equipment_trade',
  name: '장비매매',
  category: 'personal',
  args: argsSchema,
  check(view, actor, args) {
    if (!view.ruleFeatures?.includes('equipment-v1')) return fail('COMMAND_DISABLED', '장비 판이 아닙니다.');
    if (!view.ruleFeatures.includes('logistics-v1'))
      return fail('COMMAND_DISABLED', '장비매매에 물류 판이 필요합니다.');
    const location = ownCity(view, actor);
    if (location) return location;
    const general = view.generals[actor.generalId]!,
      key = String(actor.generalId);
    if (general.activeFromYear === LINEAGE_EXITED_YEAR || view.lineage?.persons[key]?.exit)
      return fail('BAD_STATE', '퇴장한 장수는 장비를 거래할 수 없습니다.');
    const equipment = readEquipmentState(view.equipment, view);
    const slots = equipment.generals[key];
    if (general.experience > EQUIPMENT_MAX - equipment.config.tradeExperience)
      return fail('BAD_STATE', '경험의 한도에 도달했습니다.');
    if (args.slot === 'tool') {
      if (!hasTreatmentTool(equipment.config)) return fail('COMMAND_DISABLED', '도구를 사용할 수 없는 월드입니다.');
      if (availableRareEquipmentTools(equipment.config).some(({ key }) => key === slots?.tool?.key))
        return fail('BAD_STATE', '명품 도구는 거래할 수 없습니다.');
      if (args.itemKey === 'none') {
        if (!slots?.tool) return fail('BAD_STATE', '판매할 도구가 없습니다.');
        return general.gold > EQUIPMENT_MAX - toolSaleProceeds(slots.tool, equipment.config.sellRateBp)
          ? fail('BAD_STATE', '금의 한도에 도달했습니다.')
          : null;
      }
      const tool = equipmentTools[args.itemKey];
      if (!availableEquipmentTools(equipment.config).some(({ key }) => key === tool.key))
        return fail(
          'COMMAND_DISABLED',
          tool.key === MORALE_TOOL.key ? '탁주를 사용할 수 없는 월드입니다.' : '이 도구를 사용할 수 없는 월드입니다.',
        );
      if ('requiredSecurity' in tool && view.cities[general.cityKey]!.security < tool.requiredSecurity)
        return fail('BAD_STATE', '도시의 치안이 부족합니다.');
      if (slots?.tool?.key === tool.key && slots.tool.charges === tool.charges)
        return fail(
          'BAD_STATE',
          tool.key === TREATMENT_TOOL.key
            ? '환약이 충분히 남았습니다.'
            : tool.key === MORALE_TOOL.key
              ? '탁주가 충분히 남았습니다.'
              : '같은 도구가 충분히 남았습니다.',
        );
      return general.gold < tool.cost ? fail('NO_GOLD', '금이 부족합니다.') : null;
    }
    const held = slots?.[args.slot];
    if (held && rareEquipmentKeySchema.safeParse(held).success)
      return fail('BAD_STATE', '명품 장비는 거래할 수 없습니다.');
    if (args.itemKey === 'none') {
      if (!held) return fail('BAD_STATE', '판매할 장비가 없습니다.');
      const item = equipment.config.items.find((entry) => entry.key === held)!;
      return general.gold > EQUIPMENT_MAX - proceeds(item.cost, equipment.config.sellRateBp)
        ? fail('BAD_STATE', '금의 한도에 도달했습니다.')
        : null;
    }
    const item = equipment.config.items.find((entry) => entry.key === args.itemKey);
    if (!item || item.slot !== args.slot) return fail('BAD_ARGS', '장비 번호와 칸이 맞지 않습니다.');
    if (view.cities[general.cityKey]!.security < item.requiredSecurity)
      return fail('BAD_STATE', '도시의 치안이 부족합니다.');
    if (general.gold < item.cost) return fail('NO_GOLD', '금이 부족합니다.');
    if (held === item.key) return fail('BAD_STATE', '같은 장비를 이미 장착했습니다.');
    return checkCityGoods(view, general.cityKey, item.goods);
  },
  change(state, actor, args) {
    const general = state.generals[actor.generalId]!,
      key = String(actor.generalId),
      equipment = readEquipmentState(state.equipment, state);
    if (args.slot === 'tool') {
      if (args.itemKey === 'none') {
        const slots = equipment.generals[key]!;
        general.gold += toolSaleProceeds(slots.tool!, equipment.config.sellRateBp);
        delete slots.tool;
        if (Object.keys(slots).length === 0) delete equipment.generals[key];
      } else {
        const tool = equipmentTools[args.itemKey];
        general.gold -= tool.cost;
        equipment.generals[key] = {
          ...equipment.generals[key],
          tool: { key: tool.key, charges: tool.charges },
        };
      }
    } else if (args.itemKey === 'none') {
      const slots = equipment.generals[key]!,
        item = equipment.config.items.find((entry) => entry.key === slots[args.slot])!;
      general.gold += proceeds(item.cost, equipment.config.sellRateBp);
      delete slots[args.slot];
      if (Object.keys(slots).length === 0) delete equipment.generals[key];
    } else {
      const item = equipment.config.items.find((entry) => entry.key === args.itemKey)!;
      const spent = consumeCityGoods(state, general.cityKey, item.goods);
      if (!spent.ok) throw new Error(spent.message);
      state.logistics = spent.logistics;
      general.gold -= item.cost;
      equipment.generals[key] = { ...equipment.generals[key], [args.slot]: item.key };
    }
    general.experience += equipment.config.tradeExperience;
    state.equipment = equipment;
    return success(args.itemKey === 'none' ? '장비를 판매했습니다.' : '장비를 구매해 장착했습니다.');
  },
});
