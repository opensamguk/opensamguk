import { expect, it } from 'vitest';
import { decideLineageAction } from './actions';
import { successionPreview } from './preview';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';
import { completePersonnelStep } from '../personnel/step';

function family() {
  const world = lineageFixture(),
    [from, heir, mother, issuer] = Object.keys(world.generals).map(Number);
  Object.assign(world.generals[from!]!, { userId: 'lineage-player', officerLevel: 1, gold: 100, rice: 200, crew: 0 });
  Object.assign(world.generals[heir!]!, {
    userId: null,
    officerLevel: 12,
    nationId: world.generals[from!]!.nationId,
    cityKey: world.generals[from!]!.cityKey,
    gold: 40,
    rice: 50,
    crew: 0,
  });
  world.generals[mother!]!.sex = 'FEMALE';
  world.lineage!.persons[String(heir)] = { ...emptyLineagePerson(), parents: [from!, mother!] };
  world.lineage!.persons[String(from)] = { ...emptyLineagePerson(), heirId: heir! };
  return { world, from: from!, heir: heir!, mother: mother!, issuer: issuer! };
}

it('AC-P2-32 더 높은 후계자의 군주·황제 자리를 지키며 동의한 미리보기와 실제 계승 결과가 같다', () => {
  const { world, from, heir } = family();
  world.nations[1]!.isNpc = true;
  world.governance!.throne = { emperorGeneralId: heir, emperorNationId: 1, sinceTick: 0 };
  const before = structuredClone(world),
    preview = successionPreview(world, from, heir, 100);
  expect(preview).toMatchObject({ ok: true });
  if (!preview.ok) throw Error(preview.message);
  expect(world).toEqual(before);
  expect(preview.value).toMatchObject({
    heirId: heir,
    officerLevel: 12,
    gold: 140,
    rice: 250,
    governance: { throne: false },
  });
  const confirmed = decideLineageAction(
    world,
    from,
    { type: 'succession.confirm', heirGeneralId: heir, expected: preview.value },
    100,
  );
  expect(confirmed.ok).toBe(true);
  if (!confirmed.ok) throw Error(confirmed.message);
  expect(confirmed.world.generals[heir]).toMatchObject({
    officerLevel: preview.value.officerLevel,
    gold: preview.value.gold,
    rice: preview.value.rice,
    userId: 'lineage-player',
  });
  expect(confirmed.world.nations[1]!.isNpc).toBe(false);
  expect(confirmed.world.governance!.throne.emperorGeneralId).toBe(heir);
  const step = completePersonnelStep(
    world,
    { 1: { 12: { revision: 8, tenure: 3 } } },
    { state: confirmed.world, offices: { 1: { 12: { revision: 8, tenure: 3 } } }, closedOffers: [], logs: [] },
    100,
  );
  expect(step.offices[1]?.[12]).toEqual({ revision: 9, tenure: 4 });
  expect(step.state.officeTurns?.[1]?.[12]).toHaveLength(12);
  expect(step.state.officeTurns?.[1]?.[12]?.every((slot) => slot.commandKey === 'nation_rest')).toBe(true);
  world.generals[from]!.gold++;
  expect(
    decideLineageAction(world, from, { type: 'succession.confirm', heirGeneralId: heir, expected: preview.value }, 100),
  ).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
  expect(world.generals[from]!.userId).toBe('lineage-player');
});

it('AC-P2-32 미리보기는 퇴장자를 대상으로 한 발령 취소도 포함하고 이미 무효인 무관한 제안은 섞지 않는다', () => {
  const { world, from, heir, mother, issuer } = family();
  world.generals[heir]!.officerLevel = 0;
  Object.assign(world.generals[issuer]!, { nationId: 1, officerLevel: 12 });
  world.assignmentOffers = {
    [from]: {
      id: 'target-left',
      nationId: 1,
      issuerGeneralId: issuer,
      cityKey: 1,
      createdTick: 0,
      expiresTick: 10_000,
    },
    [mother]: {
      id: 'unrelated-invalid',
      nationId: 3,
      issuerGeneralId: issuer,
      cityKey: 3,
      createdTick: 0,
      expiresTick: 10_000,
    },
  };
  const preview = successionPreview(world, from, heir, 0);
  expect(preview).toMatchObject({ ok: true });
  if (!preview.ok) throw Error(preview.message);
  expect(preview.value.cancelledOffers).toEqual([{ kind: 'ASSIGNMENT', id: 'target-left' }]);
  const confirmed = decideLineageAction(
    world,
    from,
    { type: 'succession.confirm', heirGeneralId: heir, expected: preview.value },
    0,
  );
  if (!confirmed.ok) throw Error(confirmed.message);
  const step = completePersonnelStep(world, {}, { state: confirmed.world, offices: {}, closedOffers: [], logs: [] }, 0);
  expect(step.assignment.closedOffers).toContainEqual(
    expect.objectContaining({ id: 'target-left', status: 'CANCELLED', cancelReason: 'TARGET_LEFT' }),
  );
});
