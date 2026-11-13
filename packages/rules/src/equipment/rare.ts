import type { Rng } from '@opensamguk/shared';
import type { WorldState } from '../model/world';
import { hasRareEquipment, rareEquipment } from './config';

// One 10% discovery roll per month across the whole world, with a single rare item per general.
export function discoverRareEquipment(state: WorldState, year: number, rng: Rng) {
  const equipment = state.equipment;
  if (!equipment || !hasRareEquipment(equipment.config)) return [];
  const found = new Set(Object.values(equipment.generals).flatMap((slots) => Object.values(slots)));
  const available = rareEquipment.filter(({ key }) => !found.has(key));
  if (!available.length || rng.next() >= 0.1) return [];
  const candidates = Object.values(state.generals)
    .filter(
      ({ userId, activeFromYear, removedAt }) => userId !== null && activeFromYear <= year && removedAt === undefined,
    )
    .sort((a, b) => a.id - b.id);
  const options = candidates.flatMap(({ id }) => {
    const slots = equipment.generals[id];
    if (slots && rareEquipment.some(({ key, slot }) => slots[slot] === key)) return [];
    return available.filter(({ slot }) => !slots?.[slot]).map((item) => ({ generalId: id, item }));
  });
  if (!options.length) return [];
  const { generalId, item } = rng.pick(options);
  equipment.generals[generalId] = { ...equipment.generals[generalId], [item.slot]: item.key };
  return [{ generalId, text: `명품 ${item.name}을 발견했습니다. ${item.description}` }];
}
