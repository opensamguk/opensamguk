import { hashState } from '@opensamguk/shared/node';
import type { Prisma } from '@opensamguk/db';
import {
  effectiveWorldOptions,
  OFFICE_EFFECTS_FEATURE,
  officeEffectsSchema,
  readCityOfficeVolunteers,
  HERITAGE_SPECIALTY_FEATURE,
  storedHeritageSpecialty,
  storedHeritageTurnTime,
  readOperationalMap,
  attachOperationalKinds,
  readStoredGovernance,
  storedGeneralSex,
  storedGeneralRemoval,
  readStoredLineage,
  readStoredStratagemCards,
  readStoredEquipment,
  readStoredNationLifecycle,
  readStoredRelations,
  assertNationLifecycle,
  storedCitySeasonalEvent,
  storedCityConflict,
  storedStatExperience,
  storedDefenseStance,
  storedGeneralProficiency,
  storedHeritageBenefits,
  HERITAGE_BENEFITS_FEATURE,
  GENERAL_PROFICIENCY_FEATURE,
  storedNpcNationPolicy,
  storedFinanceRates,
  NATION_FINANCE_FEATURE,
  storedNationRestrictions,
  NATION_RESTRICTIONS_FEATURE,
  NPC_NATION_POLICY_FEATURE,
  DEFENSE_STANCE_FEATURE,
  type WorldState,
} from '@opensamguk/rules';
import { engineFeatures } from './features';
import { loadCommandState } from './commandPersistence';
import { engineResolver, loadExt } from './extState';
import { readStoredNationStrategy } from '@opensamguk/rules';
import { readStoredPreparedTurns, readStoredNationResearch } from '@opensamguk/rules';
import { assertWorldCapabilities } from './capsGate';
import { loadTreaties } from './treatyState';
import { assertPersonnelStorage } from './personnelState';
import { assertNoResidenceAnchorsInRows } from './residenceState';
import { storedGeneralStats } from './generalStats';
import { readCampaignArmyTypes, readStoredCampaign } from './campaignState';
import { readStoredCityResources } from './cityResourcesState';
import { readStoredCityRuins } from './cityScaleState';
import { readStoredLogistics, readLogisticsOriginConfig } from './logisticsState';

export async function loadWorld(tx: Prisma.TransactionClient, worldId: string): Promise<WorldState> {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const capabilities = await assertWorldCapabilities(tx, world);
  return loadWorldAfterCapabilityCheck(tx, world, capabilities);
}

// 호출자는 같은 트랜잭션의 World 행을 잠그고 바로 앞에서 capability 검사를 마쳐야 한다.
// 입력을 처리하지 않은 일반 턴에서만 같은 사본을 재사용하며 다음 턴에는 다시 DB에서 검사한다.
export async function loadWorldAfterCapabilityCheck(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  capabilities: Awaited<ReturnType<typeof assertWorldCapabilities>>,
): Promise<WorldState> {
  const worldId = world.id;
  const armyTypes = world.ruleFeatures.includes('campaign-v1')
    ? ((capabilities.kind === 'registry' ? capabilities.armyTypes : undefined) ?? readCampaignArmyTypes(world))
    : [];
  const { preset, commands } = engineResolver(world);
  const { presetRules: rules, recruitmentLocation } = effectiveWorldOptions(preset, world.runtimeOptions);
  if (world.replayFormat === 3) await assertPersonnelStorage(tx, worldId, world.ruleFeatures.includes('personnel'));
  const ext = await loadExt(tx, worldId, commands, world.ruleFeatures);
  const cities = await tx.city.findMany({ where: { worldId }, omit: { conflictTick: true, stratagemTick: true } });
  const operationalMap = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
  const nations = await tx.nation.findMany({
    where: { worldId },
    omit: {
      notice: true,
      recruitmentNotice: true,
      noticeDirective: true,
      noticeRevision: true,
      noticeUpdatedAt: true,
      noticeUpdatedBy: true,
    },
  });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: { noticeSeen: true, defaultPolicy: true, lastActiveTick: true, lastActiveAt: true, nationJoinedTick: true },
  });
  if (world.replayFormat === 3 && !world.ruleFeatures.includes('personnel')) assertNoResidenceAnchorsInRows(generals);
  const diplomacies = await tx.diplomacy.findMany({
    where: { worldId },
    orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
  });
  const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
    void ignored;
    return value;
  };
  const officeEnabled = world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE);
  const officeEffects = officeEnabled ? officeEffectsSchema.parse(world.officeEffects) : undefined;
  if (officeEffects) {
    const origin = world.replayOrigin as { featureData?: Record<string, unknown> } | null;
    if (
      hashState(officeEffects) !== hashState(officeEffectsSchema.parse(origin?.featureData?.[OFFICE_EFFECTS_FEATURE]))
    )
      throw new Error('저장된 주재 효과와 월드 생성 기록이 다릅니다.');
  } else if (world.officeEffects != null || generals.some((general) => general.officerCityKey != null)) {
    throw new Error('주재 효과를 사용하지 않는 월드에 도시 관직 자료가 있습니다.');
  }
  let state: WorldState = {
    ...(officeEffects ? { officeEffects } : {}),
    ...(rules ? { presetRules: rules } : {}),
    ...(recruitmentLocation === 'city' ? { recruitmentLocation } : {}),
    ...(world.ruleFeatures?.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
    ...(ext ? { ext } : {}),
    startYear: world.startYear,
    cities: Object.fromEntries(
      attachOperationalKinds(
        cities.map(({ seasonalEvent, warCasualties, conflict, conflictOrder, ...city }) => ({
          ...stripWorldId(city),
          ...storedCitySeasonalEvent(seasonalEvent),
          ...storedCityConflict(conflict, conflictOrder),
          ...(warCasualties == null ? {} : { warCasualties }),
        })),
        operationalMap,
      ).map((city) => [city.cityKey, city]),
    ),
    nations: Object.fromEntries(
      nations.map(({ diplomaticAidUntilMonth, npcSettings, restrictions, financeRates, ...nation }) => {
        const rates = world.ruleFeatures.includes(NATION_FINANCE_FEATURE)
          ? storedFinanceRates(financeRates)
          : undefined;
        return [
          nation.id,
          {
            ...stripWorldId(nation),
            ...(diplomaticAidUntilMonth != null ? { diplomaticAidUntilMonth } : {}),
            ...storedNpcNationPolicy(world.ruleFeatures.includes(NPC_NATION_POLICY_FEATURE), npcSettings),
            ...(rates === undefined ? {} : { financeRates: rates }),
            ...storedNationRestrictions(world.ruleFeatures.includes(NATION_RESTRICTIONS_FEATURE), restrictions),
          },
        ];
      }),
    ),
    generals: Object.fromEntries(
      generals.map(
        ({
          turnRevision,
          battleWins,
          captures,
          stratagemSuccesses,
          residenceTick,
          officerCityKey,
          defenseThreshold,
          proficiency,
          statExperience,
          heritageBenefits,
          heritageSpecialty,
          heritageTurnTime,
          heritageStatReset,
          combatSpecial,
          ...general
        }) => {
          void turnRevision;
          void residenceTick;
          // 순위용 누계는 게임 규칙 입력이 아니다. 기존 재생 해시에 섞지 않는다.
          void battleWins;
          void captures;
          void stratagemSuccesses;
          return [
            general.id,
            storedGeneralStats(
              storedGeneralRemoval(
                storedGeneralSex(
                  {
                    ...stripWorldId(general),
                    ...(officerCityKey == null ? {} : { officerCityKey }),
                    ...storedHeritageSpecialty(
                      world.ruleFeatures.includes(HERITAGE_SPECIALTY_FEATURE),
                      heritageSpecialty,
                    ),
                    ...(heritageSpecialty == null ? {} : { combatSpecial }),
                    ...storedHeritageTurnTime(heritageTurnTime),
                    ...(heritageStatReset === true ? { heritageStatReset: true as const } : {}),
                    ...storedHeritageBenefits(world.ruleFeatures.includes(HERITAGE_BENEFITS_FEATURE), heritageBenefits),
                    ...storedGeneralProficiency(world.ruleFeatures.includes(GENERAL_PROFICIENCY_FEATURE), proficiency),
                    ...storedStatExperience(statExperience),
                    ...storedDefenseStance(world.ruleFeatures.includes(DEFENSE_STANCE_FEATURE), defenseThreshold),
                  },
                  world.ruleFeatures.includes('lineage-v1'),
                ),
                world.replayFormat,
              ),
              world.ruleFeatures?.includes('five-stats') ?? false,
            ),
          ];
        },
      ),
    ),
    diplomacies: diplomacies.map(stripWorldId),
    ...(await loadCommandState(tx, worldId, world)),
    ...(capabilities.kind === 'caps' && 'treaty' in capabilities.selection ? await loadTreaties(tx, worldId) : {}),
  };
  const volunteers = readCityOfficeVolunteers(world.ruleFeatures, world.cityOfficeVolunteers);
  if (volunteers) state.cityOfficeVolunteers = volunteers;
  const campaign = readStoredCampaign(world.campaignState, state, world.seed);
  if (campaign) state.campaign = campaign;
  const cityResources = readStoredCityResources(world.cityResourcesState, state, armyTypes);
  if (cityResources) state.cityResources = cityResources;
  const cityRuins = readStoredCityRuins(world, state);
  if (cityRuins) state.cityRuins = cityRuins;
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
  const logistics = readStoredLogistics(world.logisticsState, state, readLogisticsOriginConfig(world, state));
  if (logistics && logistics.monthlyTick !== world.monthlyTick)
    throw new Error('저장된 물류와 월 정산 tick이 다릅니다.');
  if (logistics) state.logistics = logistics;
  const governance = readStoredGovernance(world, state);
  if (governance) state.governance = governance;
  const lineage = readStoredLineage(world, state);
  if (lineage) state.lineage = lineage;
  const equipment = readStoredEquipment(world, state);
  if (equipment) state.equipment = equipment;
  const cards = readStoredStratagemCards(world, state);
  if (cards) state.stratagemCards = cards;
  for (const feature of engineFeatures
    .filter((feature) => world.ruleFeatures?.includes(feature.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    state = (await feature.loadWorld?.(tx, worldId, state)) ?? state;
  return state;
}
