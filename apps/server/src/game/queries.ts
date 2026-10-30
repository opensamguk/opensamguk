import { TRPCError } from '@trpc/server';
import { isDeepStrictEqual } from 'node:util';
import { readWorldExtRows, type Prisma } from '@opensamguk/db';
import {
  toWorldState,
  presetRules,
  restoreExtState,
  selectWorldCapabilities,
  projectTreatyRows,
  validateBrokenTreatyRow,
  validateClosedTreatyRow,
  type WorldInit,
  readOperationalMap,
  attachOperationalKinds,
  readCampaignState,
  readCityResourcesState,
  checkReplayOrigin,
  campaignArmyTypes,
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
  const treatyOptions = { tradeEnabled: world.replayFormat === 3 && world.ruleFeatures.includes('treaty-trade') };
  if (world.replayFormat === 3)
    for (const row of treatyRows)
      if (!['PROPOSED', 'ACTIVE', 'BROKEN'].includes(row.status)) validateClosedTreatyRow(row, treatyOptions);
  if (breakEnabled)
    for (const row of treatyRows) if (row.status === 'BROKEN') validateBrokenTreatyRow(row, treatyOptions);
  const treaties = treatyEnabled
    ? projectTreatyRows(breakEnabled ? treatyRows.filter((row) => row.status !== 'BROKEN') : treatyRows, treatyOptions)
    : undefined;
  const ext = restoreExtState(commands, await readWorldExtRows(tx, worldId));
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({ where: { worldId } });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: { defaultPolicy: true, lastActiveTick: true, lastActiveAt: true, residenceTick: true },
  });
  const diplomacies = await tx.diplomacy.findMany({ where: { worldId } });
  const state = toWorldState({
    ...(preset ? { presetRules: presetRules(preset) } : {}),
    ...(world.ruleFeatures?.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
    ...(ext ? { ext } : {}),
    startYear: world.startYear,
    cities: attachOperationalKinds(
      cities,
      readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin),
    ),
    nations,
    generals,
    diplomacies,
    ...(world.commandMeta ? { commandMeta: world.commandMeta } : {}),
  } as unknown as WorldInit);
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
  return { ...state, ...(treaties ? { treaties } : {}) };
}
