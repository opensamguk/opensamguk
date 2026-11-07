import { z } from 'zod';
import { LEGACY_CHE_REGION_NAMES, legacyCheCityRegions } from '../../packages/rules/src/world/crewRegions';
import { mapSchema, unitSetSchema, type UnitSetResource } from '../../packages/rules/src/world/resources';
import { validateUnitSet } from '../../packages/rules/src/world/validate/unitSet';

type Requirement = NonNullable<UnitSetResource['crewTypes'][number]['requirements']>[number];
type Effects = NonNullable<UnitSetResource['crewTypes'][number]['effects']>;
const originalRequirement = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Impossible') }),
  z.strictObject({ type: z.literal('ReqTech'), tech: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('ReqRegions'), regions: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ type: z.literal('ReqCities'), cities: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ type: z.literal('ReqMinRelYear'), year: z.number().int().nonnegative() }),
]);
const triggerList = z.array(z.string().min(1)).nullable();
const originalSet = z.looseObject({
  id: z.enum(['che', 'che_except_siege', 'cr', 'siegetank']),
  crewTypes: z.array(
    z.looseObject({
      id: z.number().int().positive(),
      attackCoef: z.union([z.record(z.string(), z.number().nonnegative()), z.array(z.number().nonnegative()).max(1)]),
      requirements: z.array(originalRequirement),
      initSkillTrigger: triggerList,
      phaseSkillTrigger: triggerList,
      iActionList: triggerList,
    }),
  ),
});
export const MINICHE_MAP_IDS = ['miniche', 'miniche_b', 'miniche_clean'] as const;

export function projectCheUnitSet(source: unknown, mapInput: unknown) {
  const original = originalSet.parse(source);
  const map = mapSchema.parse(mapInput);
  const miniche = MINICHE_MAP_IDS.some((id) => id === map.id);
  const allowedMaps = {
    che: ['che', ...MINICHE_MAP_IDS],
    che_except_siege: MINICHE_MAP_IDS,
    cr: ['cr'],
    siegetank: ['che'],
  }[original.id];
  if (!allowedMaps.includes(map.id))
    throw Error(`원작 병종에 맞는 ${original.id === 'cr' ? 'cr' : 'che'} 지도가 필요합니다.`);
  const boundMaps = miniche ? MINICHE_MAP_IDS : original.id === 'cr' ? allowedMaps : undefined;
  const regionIds = new Set(map.cities.map(({ region }) => region));

  function project(req: z.infer<typeof originalRequirement>): Requirement {
    switch (req.type) {
      case 'Impossible':
        return { kind: 'impossible' };
      case 'ReqTech':
        return { kind: 'tech', min: req.tech };
      case 'ReqMinRelYear':
        return { kind: 'minRelYear', min: req.year };
      case 'ReqRegions':
        return {
          kind: 'legacyCheRegions',
          regions: req.regions.map((name) => {
            const region = LEGACY_CHE_REGION_NAMES.findIndex((candidate) => candidate === name);
            if (region <= 0 || !regionIds.has(region)) throw Error(`원작 병종의 지역 대응을 확인하세요. ${name}`);
            return region;
          }),
        };
      case 'ReqCities':
        return {
          kind: 'cities',
          cityKeys: req.cities.map((name) => {
            const found = map.cities.filter((city) => city.name === name);
            if (found.length !== 1) throw Error(`원작 병종의 거점 대응을 확인하세요. ${name}`);
            return found[0]!.id;
          }),
        };
    }
  }

  const unitSet = unitSetSchema.parse({
    ...original,
    ...(boundMaps ? { legacyCheMapIds: boundMaps } : {}),
    ...(miniche && original.id === 'che' ? { id: 'che-miniche', name: 'che-miniche' } : {}),
    coefMode: 'multiply',
    firstVolleyScope: 'sortie',
    legacyCheCityRegions: legacyCheCityRegions(map),
    crewTypes: original.crewTypes.map((row) => {
      const effects: Effects = [];
      if (row.phaseSkillTrigger?.includes('che_선제사격발동')) effects.push('firstVolley');
      if (row.phaseSkillTrigger?.includes('che_방어력증가5p')) effects.push('guard5');
      if (row.phaseSkillTrigger?.includes('che_기병병종전투')) effects.push('cavalryClash');
      if (row.phaseSkillTrigger?.includes('che_저지발동')) effects.push('hold');
      if (row.iActionList?.includes('che_성벽선제')) effects.push('wallFirst');
      // 원작은 배열의 0번 값을 성벽 병과(0)의 상성으로 읽는다.
      const attackCoef =
        Array.isArray(row.attackCoef) && row.attackCoef.length ? { 0: row.attackCoef[0] } : row.attackCoef;
      return {
        ...row,
        attackCoef,
        requirements: row.requirements.map(project),
        effects: effects.length ? effects : undefined,
      };
    }),
  });
  if (validateUnitSet(unitSet).status !== 'pass') throw Error('원작 병종의 계수와 병과를 확인하세요.');
  const specials = original.crewTypes.map(({ id, initSkillTrigger, phaseSkillTrigger, iActionList }) => ({
    id,
    initSkillTrigger,
    phaseSkillTrigger,
    iActionList,
  }));
  return { unitSet, specials };
}
