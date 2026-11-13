import { hashState } from '@opensamguk/shared/node';
import { TRPCError } from '@trpc/server';
import { isDeepStrictEqual } from 'node:util';
import { readWorldExtRows, type Prisma } from '@opensamguk/db';
import {
  toWorldState,
  effectiveWorldOptions,
  restoreExtState,
  selectWorldCapabilities,
  projectTreatyRows,
  treatyOptions,
  validateBrokenTreatyRow,
  validateClosedTreatyRow,
  type WorldInit,
  readOperationalMap,
  attachOperationalKinds,
  readCampaignState,
  readCityResourcesState,
  readCityRuins,
  checkReplayOrigin,
  campaignArmyTypes,
  readLogisticsOriginConfig,
  readLogisticsState,
  readStoredGovernance,
  storedGeneralSex,
  storedStatExperience,
  storedFinanceRates,
  storedCityConflict,
  storedGeneralRemoval,
  readStoredLineage,
  readStoredEquipment,
  readStoredStratagemCards,
  readStoredNationStrategy,
  readStoredPreparedTurns,
  readStoredNationResearch,
  readStoredNationLifecycle,
  readStoredRelations,
  assertNationLifecycle,
  OFFICE_EFFECTS_FEATURE,
  officeEffectsSchema,
  readCityOfficeVolunteers,
  HERITAGE_SPECIALTY_FEATURE,
  storedHeritageSpecialty,
  storedCitySeasonalEvent,
  storedDefenseStance,
  storedGeneralProficiency,
  storedHeritageBenefits,
  HERITAGE_BENEFITS_FEATURE,
  GENERAL_PROFICIENCY_FEATURE,
  storedNpcNationPolicy,
  storedNationRestrictions,
  NATION_RESTRICTIONS_FEATURE,
  NPC_NATION_POLICY_FEATURE,
  DEFENSE_STANCE_FEATURE,
} from '@opensamguk/rules';
import { z } from 'zod';
import { worldResolver } from './resolver';
export const worldInput = z.strictObject({ worldId: z.string().min(1).max(64) });
export async function requireWorld(tx: Prisma.TransactionClient, worldId: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
  const world = await tx.world.findUnique({ where: { id: worldId } });
  if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드가 없습니다.' });
  return world;
}
export function requireRuleFeature(world: { ruleFeatures: readonly string[] }, key: string): void {
  if (!world.ruleFeatures.includes(key))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '이 월드에서 켜지 않은 기능입니다.' });
}
export async function requireGeneral(tx: Prisma.TransactionClient, worldId: string, userId: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND "userId" = ${userId} FOR UPDATE`;
  const general = await tx.general.findUnique({ where: { worldId_userId: { worldId, userId } } });
  if (!general) throw new TRPCError({ code: 'NOT_FOUND', message: '장수가 없습니다.' });
  return general;
}
export async function readView(tx: Prisma.TransactionClient, worldId: string) {
  const world = await requireWorld(tx, worldId);
  const { preset, commands } = worldResolver(world);
  const { presetRules: rules, recruitmentLocation } = effectiveWorldOptions(preset, world.runtimeOptions);
  const capabilities = world.replayFormat === 3 ? null : selectWorldCapabilities(world);
  const treatyRows = await tx.treaty.findMany({
    where: { worldId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      fromNationId: true,
      toNationId: true,
      clauses: true,
      status: true,
      proposedTick: true,
      respondByTick: true,
      startTick: true,
      endTick: true,
      costFrom: true,
      costTo: true,
      closedSequence: true,
    },
  });
  const treatyEnabled =
    world.replayFormat === 3
      ? world.ruleFeatures.includes('treaty')
      : capabilities?.kind === 'caps' && 'treaty' in capabilities.selection;
  if (!treatyEnabled && treatyRows.length) throw new Error('조약을 끈 월드에 조약 저장 행이 있습니다.');
  const breakEnabled = world.replayFormat === 3 && world.ruleFeatures.includes('treaty-break');
  const clauses = treatyOptions(world.replayFormat === 3 ? world.ruleFeatures : []);
  if (world.replayFormat === 3)
    for (const row of treatyRows)
      if (!['PROPOSED', 'ACTIVE', 'BROKEN'].includes(row.status)) validateClosedTreatyRow(row, clauses);
  if (breakEnabled) for (const row of treatyRows) if (row.status === 'BROKEN') validateBrokenTreatyRow(row, clauses);
  const treaties = treatyEnabled
    ? projectTreatyRows(breakEnabled ? treatyRows.filter((row) => row.status !== 'BROKEN') : treatyRows, clauses)
    : undefined;
  const ext = restoreExtState(commands, await readWorldExtRows(tx, worldId), world.ruleFeatures);
  const cities = await tx.city.findMany({ where: { worldId }, omit: { conflictTick: true, stratagemTick: true } });
  const nations = await tx.nation.findMany({
    where: { worldId },
    omit: { noticeDirective: true, recruitmentNotice: true },
  });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: {
      defaultPolicy: true,
      lastActiveTick: true,
      lastActiveAt: true,
      residenceTick: true,
      nationJoinedTick: true,
    },
  });
  const diplomacies = await tx.diplomacy.findMany({ where: { worldId } });
  const state = toWorldState({
    ...(rules ? { presetRules: rules } : {}),
    ...(recruitmentLocation === 'city' ? { recruitmentLocation } : {}),
    ...(world.ruleFeatures?.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
    ...(ext ? { ext } : {}),
    startYear: world.startYear,
    cities: attachOperationalKinds(
      cities.map(({ seasonalEvent, conflict, conflictOrder, warCasualties, ...city }) => ({
        ...city,
        ...storedCitySeasonalEvent(seasonalEvent),
        ...storedCityConflict(conflict, conflictOrder),
        ...(warCasualties == null ? {} : { warCasualties }),
      })),
      readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin),
    ),
    nations: nations.map(({ diplomaticAidUntilMonth, npcSettings, restrictions, financeRates, ...nation }) => ({
      ...nation,
      ...storedNpcNationPolicy(world.ruleFeatures.includes(NPC_NATION_POLICY_FEATURE), npcSettings),
      ...storedNationRestrictions(world.ruleFeatures.includes(NATION_RESTRICTIONS_FEATURE), restrictions),
      ...(financeRates === null ? {} : { financeRates: storedFinanceRates(financeRates) }),
      ...(diplomaticAidUntilMonth != null ? { diplomaticAidUntilMonth } : {}),
    })),
    generals: generals.map(
      ({
        defenseThreshold,
        proficiency,
        heritageBenefits,
        heritageSpecialty,
        combatSpecial,
        statExperience,
        ...general
      }) =>
        storedGeneralRemoval(
          storedGeneralSex(
            {
              ...general,
              ...storedDefenseStance(world.ruleFeatures.includes(DEFENSE_STANCE_FEATURE), defenseThreshold),
              ...storedHeritageSpecialty(world.ruleFeatures.includes(HERITAGE_SPECIALTY_FEATURE), heritageSpecialty),
              ...(heritageSpecialty == null ? {} : { combatSpecial }),
              ...storedHeritageBenefits(world.ruleFeatures.includes(HERITAGE_BENEFITS_FEATURE), heritageBenefits),
              ...storedGeneralProficiency(world.ruleFeatures.includes(GENERAL_PROFICIENCY_FEATURE), proficiency),
              ...storedStatExperience(statExperience),
            },
            world.ruleFeatures.includes('lineage-v1'),
          ),
          world.replayFormat,
        ),
    ),
    diplomacies,
    ...(world.commandMeta ? { commandMeta: world.commandMeta } : {}),
  } as unknown as WorldInit);
  if (world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE)) {
    state.officeEffects = officeEffectsSchema.parse(world.officeEffects);
    const volunteers = readCityOfficeVolunteers(world.ruleFeatures, world.cityOfficeVolunteers);
    if (volunteers) state.cityOfficeVolunteers = volunteers;
  }
  if (world.ruleFeatures.includes('campaign-v1')) {
    if (Object.values(state.generals).some((general) => general.crew !== 0))
      throw new Error('부곡 월드에 중복 병력이 있습니다.');
    state.campaign = readCampaignState(world.campaignState, state, world.seed);
  } else if (world.campaignState != null) throw new Error('휘하 기능을 끈 월드에 저장 상태가 있습니다.');
  if (world.ruleFeatures.includes('city-resources-v1')) {
    if (
      world.replayFormat !== 3 ||
      !world.ruleFeatures.includes('campaign-v1') ||
      !world.ruleFeatures.includes('campaign-assignment-v2')
    )
      throw new Error('도시 자원의 재생 형식과 휘하 기능 의존 관계가 다릅니다.');
    const origin: unknown = world.replayOrigin;
    checkReplayOrigin(origin);
    if (
      origin.version !== 3 ||
      !origin.initial.ruleFeatures?.includes('city-resources-v1') ||
      !isDeepStrictEqual(world.unitSet, origin.initial.unitSet)
    )
      throw new Error('도시 자원의 생성 기록과 운영 병종이 다릅니다.');
    state.cityResources = readCityResourcesState(world.cityResourcesState, state, campaignArmyTypes(origin.initial));
  } else if (world.cityResourcesState != null) throw new Error('도시 자원 기능을 끈 월드에 저장 상태가 있습니다.');
  const nationStrategy = readStoredNationStrategy(world);
  if (nationStrategy) state.nationStrategy = nationStrategy;
  const preparedTurns = readStoredPreparedTurns(world);
  if (preparedTurns) state.preparedTurns = preparedTurns;
  const nationResearch = readStoredNationResearch(world);
  if (nationResearch) state.nationResearch = nationResearch;
  const relations = readStoredRelations(world, hashState);
  if (relations) state.relations = relations;
  const nationLifecycle = readStoredNationLifecycle(world);
  if (nationLifecycle) state.nationLifecycle = nationLifecycle;
  assertNationLifecycle(state);
  if (world.ruleFeatures.includes('city-scale-v1')) {
    const origin: unknown = world.replayOrigin;
    checkReplayOrigin(origin);
    if (world.replayFormat !== 3 || origin.version !== 3 || !origin.initial.ruleFeatures?.includes('city-scale-v1'))
      throw new Error('폐허의 재생 형식이나 생성 원장이 다릅니다.');
    const cityRuins = readCityRuins(world.cityRuinsState, state, origin.initial.cityScale);
    if (!cityRuins) throw new Error('폐허 복구 상태가 없습니다.');
    state.cityRuins = cityRuins;
  } else if (world.cityRuinsState != null) throw new Error('도시 규모 기능을 끈 월드에 폐허 상태가 있습니다.');
  if (world.ruleFeatures.includes('logistics-v1')) {
    const config = readLogisticsOriginConfig(world, state);
    state.logistics = readLogisticsState(world.logisticsState, state);
    if (!isDeepStrictEqual(state.logistics.config, config) || state.logistics.monthlyTick !== world.monthlyTick)
      throw new Error('물류 설정·월 정산 tick이 원생성·저장 월드와 다릅니다.');
  } else if (world.logisticsState != null) throw new Error('물류 기능을 끈 월드에 저장 상태가 있습니다.');
  const governance = readStoredGovernance(world, state);
  if (governance) state.governance = governance;
  const lineage = readStoredLineage(world, state);
  if (lineage) state.lineage = lineage;
  const equipment = readStoredEquipment(world, state);
  if (equipment) state.equipment = equipment;
  const cards = readStoredStratagemCards(world, state);
  if (cards) state.stratagemCards = cards;
  return { ...state, ...(treaties ? { treaties } : {}) };
}
