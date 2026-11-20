import { loadWorldReadRows } from './worldReadRows';
import { verifySupplyLedger } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import type { Prisma } from '@opensamguk/db';
import {
  effectiveWorldOptions,
  OFFICE_EFFECTS_FEATURE,
  officeEffectsSchema,
  statRulesSchema,
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
  type WorldState,
} from '@opensamguk/rules';
import { engineFeatures, type WorldLoadContext } from './features';
import { loadCommandState } from './commandPersistence';
import { engineResolver, loadExt } from './extState';
import { readStoredNationStrategy } from '@opensamguk/rules';
import { readStoredPreparedTurns, readStoredNationResearch } from '@opensamguk/rules';
import { assertWorldCapabilities } from './capsGate';
import { loadTreaties } from './treatyState';
import { assertPersonnelStorage } from './personnelState';
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
// 그 뒤 입력 쓰기가 없을 때만 같은 사본을 재사용하며 다음 트랜잭션에서는 다시 DB에서 검사한다.
export async function loadWorldAfterCapabilityCheck(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  capabilities: Awaited<ReturnType<typeof assertWorldCapabilities>>,
  context?: WorldLoadContext,
): Promise<WorldState> {
  const worldId = world.id;
  if (context) context.rows ??= await loadWorldReadRows(tx, worldId);
  if (context && capabilities.kind === 'registry') context.treaties = capabilities.treaties;
  const checkedOrigin = capabilities.kind === 'registry' ? capabilities.origin : undefined;
  const fiveStats = statRulesSchema.parse({ stat: world.statRules }).stat.count === 5;
  const armyTypes =
    (capabilities.kind === 'registry' ? capabilities.armyTypes : undefined) ?? readCampaignArmyTypes(world);
  const resolved = engineResolver(world);
  if (context) context.resolver = resolved;
  const { preset } = resolved;
  const { presetRules: rules, recruitmentLocation } = effectiveWorldOptions(preset, world.runtimeOptions);
  if (world.replayFormat === 3) await assertPersonnelStorage(tx, worldId, true, context?.rows?.nationTurns);
  const ext = await loadExt(tx, worldId);
  const cities =
    capabilities.kind === 'registry' ? capabilities.cities : await tx.city.findMany({ where: { worldId } });
  const operationalMap = readOperationalMap(world.operationalMap, world.replayOrigin);
  const nations = await tx.nation.findMany({
    where: { worldId },
    omit: { notice: true, noticeDirective: true, noticeRevision: true, noticeUpdatedAt: true, noticeUpdatedBy: true },
  });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: { noticeSeen: true, lastActiveAt: true },
  });
  if (context) context.generals = generals;
  const diplomacies = await tx.diplomacy.findMany({
    where: { worldId },
    orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
  });
  const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
    void ignored;
    return value;
  };
  const officeEffects = officeEffectsSchema.parse(world.officeEffects);
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

    ...(ext ? { ext } : {}),
    fogOfWar: world.fogOfWar,
    startYear: world.startYear,
    cities: Object.fromEntries(
      attachOperationalKinds(cities.map(stripWorldId), operationalMap, world.campaignState).map((city) => [
        city.cityKey,
        city,
      ]),
    ),
    nations: Object.fromEntries(
      nations.map((nation) => {
        return [nation.id, { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey }];
      }),
    ),
    generals: Object.fromEntries(
      generals.map((row) => [
        row.id,
        {
          id: row.id,
          userId: row.userId,
          affinity: row.affinity,
          name: row.name,
          portraitId: row.portraitId,
          nationId: row.nationId,
          cityKey: row.cityKey,
          officerLevel: row.officerLevel,
          birthYear: row.birthYear,
          deathYear: row.deathYear,
          activeFromYear: row.activeFromYear,
          personality: row.personality,
          special: row.special,
          gold: row.gold,
          rice: row.rice,
          crew: row.crew,
          crewType: row.crewType,
          train: row.train,
          atmos: row.atmos,
          experience: row.experience,
          dedication: row.dedication,
          age: row.age,
          injury: row.injury,
          nextTurnTick: row.nextTurnTick,
          ...storedGeneralStats(
            {
              leadership: row.leadership,
              strength: row.strength,
              intel: row.intel,
              politics: row.politics,
              charm: row.charm,
            },
            fiveStats,
          ),
          ...storedGeneralSex({ sex: row.sex }, true),
          ...storedGeneralRemoval(
            { removedAt: row.removedAt, cityAnchorKey: row.cityAnchorKey, movePath: row.movePath },
            world.replayFormat,
          ),
          ...(row.officerCityKey == null ? {} : { officerCityKey: row.officerCityKey }),
        },
      ]),
    ),
    diplomacies: diplomacies.map(stripWorldId),
    ...(await loadCommandState(tx, worldId, world, context?.rows?.nationTurns)),
    ...(capabilities.kind === 'caps' && 'treaty' in capabilities.selection ? await loadTreaties(tx, worldId) : {}),
  };
  const campaign = readStoredCampaign(world.campaignState, state, world.seed);
  verifySupplyLedger(campaign?.supplyLedger, operationalMap, true);
  if (campaign) state.campaign = campaign;
  const cityResources = readStoredCityResources(world.cityResourcesState, state, armyTypes);
  if (cityResources) state.cityResources = cityResources;
  const cityRuins = readStoredCityRuins(world, state, checkedOrigin);
  if (cityRuins) state.cityRuins = cityRuins;
  const nationStrategy = readStoredNationStrategy(world, checkedOrigin);
  if (nationStrategy) state.nationStrategy = nationStrategy;
  const preparedTurns = readStoredPreparedTurns(world, checkedOrigin);
  if (preparedTurns) state.preparedTurns = preparedTurns;
  const nationResearch = readStoredNationResearch(world, checkedOrigin);
  if (nationResearch) state.nationResearch = nationResearch;
  const relations = readStoredRelations(world, hashState, checkedOrigin);
  if (relations) state.relations = relations;
  const nationLifecycle = readStoredNationLifecycle(world, checkedOrigin);
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
  for (const feature of [...engineFeatures].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    state = (await feature.loadWorld?.(tx, worldId, state, context)) ?? state;
  return state;
}
