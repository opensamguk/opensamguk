import { expect, it } from 'vitest';
import { lineageFixture } from '../lineage/testFixture';
import { emptyLineagePerson } from '../lineage/state';
import { applySuccession, retireNpcWithoutHeir } from '../lineage/succession';
import { successionPreview } from '../lineage/preview';
import { decideLineageAction } from '../lineage/actions';
import { initialEquipment, readEquipmentState } from './state';
import { STANDARD_EQUIPMENT_CONFIG } from './catalog';

function family() {
  const world = lineageFixture(),
    [from, heir, mother] = Object.keys(world.generals).map(Number);
  world.ruleFeatures!.push('equipment-v1');
  Object.assign(world.generals[from!]!, { userId: 'lineage-player', officerLevel: 1, gold: 100, rice: 200, crew: 0 });
  Object.assign(world.generals[heir!]!, {
    userId: null,
    officerLevel: 1,
    nationId: world.generals[from!]!.nationId,
    cityKey: world.generals[from!]!.cityKey,
    gold: 40,
    rice: 50,
    crew: 0,
  });
  world.generals[mother!]!.sex = 'FEMALE';
  world.lineage!.persons[String(heir)] = { ...emptyLineagePerson(), parents: [from!, mother!] };
  world.lineage!.persons[String(from)] = { ...emptyLineagePerson(), heirId: heir! };
  world.equipment = initialEquipment(STANDARD_EQUIPMENT_CONFIG);
  world.equipment.generals[String(from)] = { weapon: 'weapon_06', book: 'book_03' };
  return { world, from: from!, heir: heir! };
}
it('AC-P2-12·32 사람의 같은 칸 장비는 미리보기·직접 계승 모두 판매 안내와 함께 보류한다', () => {
  const { world, from, heir } = family();
  world.equipment!.generals[String(heir)] = { weapon: 'weapon_01' };
  const before = structuredClone(world);
  expect(successionPreview(world, from, heir, 100)).toMatchObject({ ok: false, code: 'EQUIPMENT_CONFLICT' });
  expect(applySuccession(world, from, heir, 'HUMAN', 100)).toMatchObject({ ok: false, code: 'EQUIPMENT_CONFLICT' });
  expect(world).toEqual(before);
});
it('AC-P2-12·32 사람 계승은 겹치지 않는 장비만 합치고 기본 능력치는 그대로 둔다', () => {
  const { world, from, heir } = family();
  world.equipment!.generals[String(heir)] = { horse: 'horse_02' };
  const base = structuredClone(world.generals[heir]),
    result = applySuccession(world, from, heir, 'HUMAN', 100);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.world.equipment!.generals).toEqual({
    [heir]: { horse: 'horse_02', weapon: 'weapon_06', book: 'book_03' },
  });
  expect(result.world.generals[heir]).toMatchObject({
    leadership: base!.leadership,
    strength: base!.strength,
    intel: base!.intel,
  });
  expect(readEquipmentState(result.world.equipment, result.world)).toEqual(result.world.equipment);
});
it('AC-P2-12·32 NPC는 후계자의 겹치는 장비를 지키며 부모의 나머지만 승계한다', () => {
  const { world, from, heir } = family();
  world.generals[from]!.userId = null;
  world.equipment!.generals[String(heir)] = { weapon: 'weapon_01' };
  const result = applySuccession(world, from, heir, 'NPC_DEATH', 100);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.world.equipment!.generals).toEqual({ [heir]: { weapon: 'weapon_01', book: 'book_03' } });
  expect(readEquipmentState(result.world.equipment, result.world)).toEqual(result.world.equipment);
});
it('AC-P2-12·32 후계자 없는 NPC가 퇴장하면 장비 원장을 남기지 않는다', () => {
  const { world, from } = family();
  world.generals[from]!.userId = null;
  const result = retireNpcWithoutHeir(world, from, 100);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.world.equipment!.generals).toEqual({});
  expect(readEquipmentState(result.world.equipment, result.world)).toEqual(result.world.equipment);
});
it('AC-P2-12·32 미리보기 뒤 장착을 바꾸면 계승 동의를 다시 받는다', () => {
  const { world, from, heir } = family(),
    preview = successionPreview(world, from, heir, 100);
  if (!preview.ok) throw new Error(preview.message);
  expect(preview.value.equipment).toMatchObject({ from: { weapon: 'weapon_06' }, heir: null });
  world.equipment!.generals[String(from)]!.weapon = 'weapon_05';
  expect(
    decideLineageAction(world, from, { type: 'succession.confirm', heirGeneralId: heir, expected: preview.value }, 100),
  ).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
});
