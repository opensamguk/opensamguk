import { verifySupplyLedger } from '@opensamguk/rules';
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
  officeEffectsSchema,
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
export async function requireGeneral(tx: Prisma.TransactionClient, worldId: string, userId: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND "userId" = ${userId} FOR UPDATE`;
  const general = await tx.general.findUnique({ where: { worldId_userId: { worldId, userId } } });
  if (!general) throw new TRPCError({ code: 'NOT_FOUND', message: '장수가 없습니다.' });
  return general;
}
export async function readView(tx: Prisma.TransactionClient, worldId: string) {
  const world = await requireWorld(tx, worldId);
  const { preset } = worldResolver(world);
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
    world.replayFormat === 3 ? true : capabilities?.kind === 'caps' && 'treaty' in capabilities.selection;
  if (!treatyEnabled && treatyRows.length) throw new Error('조약을 끈 월드에 조약 저장 행이 있습니다.');
  const breakEnabled = world.replayFormat === 3;
  const clauses = treatyOptions();
  if (world.replayFormat === 3)
    for (const row of treatyRows)
      if (!['PROPOSED', 'ACTIVE', 'BROKEN'].includes(row.status)) validateClosedTreatyRow(row, clauses);
  if (breakEnabled) for (const row of treatyRows) if (row.status === 'BROKEN') validateBrokenTreatyRow(row, clauses);
  const treaties = treatyEnabled
    ? projectTreatyRows(breakEnabled ? treatyRows.filter((row) => row.status !== 'BROKEN') : treatyRows, clauses)
    : undefined;
  const ext = restoreExtState(await readWorldExtRows(tx, worldId));
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({ where: { worldId }, omit: { noticeDirective: true } });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: { defaultPolicy: true, lastActiveTick: true, lastActiveAt: true, residenceTick: true },
  });
  const diplomacies = await tx.diplomacy.findMany({ where: { worldId } });
  const state = toWorldState({
    ...(rules ? { presetRules: rules } : {}),
    ...(recruitmentLocation === 'city' ? { recruitmentLocation } : {}),

    ...(ext ? { ext } : {}),
    fogOfWar: world.fogOfWar,
    startYear: world.startYear,
    cities: attachOperationalKinds(cities, readOperationalMap(world.operationalMap, world.replayOrigin)),
    nations,
    generals: generals.map((general) => storedGeneralRemoval(storedGeneralSex(general, true), world.replayFormat)),
    diplomacies,
    ...(world.commandMeta ? { commandMeta: world.commandMeta } : {}),
  } as unknown as WorldInit);
  {
    state.officeEffects = officeEffectsSchema.parse(world.officeEffects);
  }
  {
    if (Object.values(state.generals).some((general) => general.crew !== 0))
      throw new Error('부곡 월드에 중복 병력이 있습니다.');
    state.campaign = readCampaignState(world.campaignState, state, world.seed);
    verifySupplyLedger(state.campaign.supplyLedger, readOperationalMap(world.operationalMap, world.replayOrigin), true);
  }
  {
    if (world.replayFormat !== 3) throw new Error('도시 자원의 재생 형식과 휘하 기능 의존 관계가 다릅니다.');
    const origin: unknown = world.replayOrigin;
    checkReplayOrigin(origin);
    if (origin.version !== 3 || !isDeepStrictEqual(world.unitSet, origin.initial.unitSet))
      throw new Error('도시 자원의 생성 기록과 운영 병종이 다릅니다.');
    state.cityResources = readCityResourcesState(world.cityResourcesState, state, campaignArmyTypes(origin.initial));
  }
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
  {
    const origin: unknown = world.replayOrigin;
    checkReplayOrigin(origin);
    if (world.replayFormat !== 3 || origin.version !== 3) throw new Error('폐허의 재생 형식이나 생성 원장이 다릅니다.');
    const cityRuins = readCityRuins(world.cityRuinsState, state, origin.initial.cityScale);
    if (!cityRuins) throw new Error('폐허 복구 상태가 없습니다.');
    state.cityRuins = cityRuins;
  }
  {
    const config = readLogisticsOriginConfig(world, state);
    state.logistics = readLogisticsState(world.logisticsState, state);
    if (!isDeepStrictEqual(state.logistics.config, config) || state.logistics.monthlyTick !== world.monthlyTick)
      throw new Error('물류 설정·월 정산 tick이 원생성·저장 월드와 다릅니다.');
  }
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
