import type { Prisma } from '@opensamguk/db';
import {
  assertSlotSet,
  isPolicyKey,
  isPolicyMode,
  emptyTurns,
  monthlyDate,
  runMonthly,
  buildYearbook,
  ruleRegistry,
  settleMonthlyFeatures,
  selectWorldCapabilities,
  settleTreaties,
  type ReplayState,
  type WorldState,
  unitSetSchema,
} from '@opensamguk/rules';
import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import { engineFeatures } from './features';
import { loadWorld } from './worldLoader';
import { persistRanking } from './ranking';
import { persistYearbookNations } from './nationArchive';
import { persistExt } from './extState';
import { persistTreatyClosures } from './treatyState';
import { persistCampaignState, readCampaignArmyTypes } from './campaignState';
import { persistCityResourcesState } from './cityResourcesState';

export async function loadReplayState(tx: Prisma.TransactionClient, worldId: string): Promise<ReplayState> {
  const state = await loadWorld(tx, worldId);
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const generals = await tx.general.findMany({ where: { worldId } });
  const slots = await tx.generalTurn.findMany({ where: { worldId }, orderBy: { slot: 'asc' } });
  const modern =
    world.replayFormat === 3
      ? world.ruleFeatures.includes('policy')
      : isPolicyMode({ fromSequence: world.policyFromSequence ?? null, actionSequence: world.actionSequence });
  const turns = Object.fromEntries(generals.map(({ id }) => [id, emptyTurns()]));
  if (modern) {
    const byGeneral = new Map<number, typeof slots>();
    for (const slot of slots) {
      const group = byGeneral.get(slot.generalId);
      if (group) group.push(slot);
      else byGeneral.set(slot.generalId, [slot]);
    }
    for (const general of generals) assertSlotSet(byGeneral.get(general.id) ?? []);
  }
  for (const slot of slots)
    turns[slot.generalId]![slot.slot] = {
      commandKey: slot.commandKey,
      args: slot.args,
      ...(modern ? { explicit: slot.explicit } : {}),
    };
  const policy: ReplayState['policy'] = modern
    ? { turnTermMinutes: world.turnTermMinutes, policies: {}, lastActiveTicks: {} }
    : undefined;
  if (policy)
    for (const general of generals) {
      if (!isPolicyKey(general.defaultPolicy)) throw new Error('저장된 기본 방침이 올바르지 않습니다.');
      policy.policies[general.id] = general.defaultPolicy;
      if (general.userId !== null) {
        if (general.lastActiveTick === null) throw new Error('사람 장수의 활동 tick이 없습니다.');
        policy.lastActiveTicks[general.id] = general.lastActiveTick;
      }
    }
  let replay: ReplayState = {
    state,
    turns,
    revisions: Object.fromEntries(generals.map(({ id, turnRevision }) => [id, turnRevision])),
    monthlyTick: world.monthlyTick,
    ...(policy ? { policy } : {}),
    ...(world.ruleFeatures.includes('campaign-v1')
      ? { campaignArmyTypes: readCampaignArmyTypes(world), campaignUnitSet: unitSetSchema.parse(world.unitSet) }
      : {}),
  };
  for (const feature of engineFeatures
    .filter((feature) => state.ruleFeatures?.includes(feature.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    replay = (await feature.loadReplayState?.(tx, worldId, replay)) ?? replay;
  return replay;
}

export async function persistMonthly(
  tx: Prisma.TransactionClient,
  worldId: string,
  seed: string,
  tick: number,
  sequence: number,
): Promise<WorldState> {
  const beforeReplay = await loadReplayState(tx, worldId);
  const before = beforeReplay.state;
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const capabilities = world.replayFormat === 3 ? null : selectWorldCapabilities(world);
  const date = monthlyDate(before.startYear, tick);
  const result = runMonthly(before, tick, rngFor(seed, 'monthly', date.year, date.month));
  const treatyEnabled = capabilities?.kind === 'caps' && 'treaty' in capabilities.selection;
  const settled = { ...beforeReplay, state: result.state, monthlyTick: tick };
  const features =
    world.replayFormat === 3
      ? settleMonthlyFeatures(beforeReplay, settled, tick)
      : {
          replay: { ...settled, state: treatyEnabled ? settleTreaties(result.state, tick) : result.state },
          effects: {} as Record<string, unknown>,
        };
  const next = features.replay.state;
  const yearbook = world.replayFormat === 3 ? buildYearbook(next, date.year) : result.yearbook;
  // 모든 변경은 같은 리스·월드 잠금을 잡은 트랜잭션 안에서 최종값으로 쓴다.
  for (const city of Object.values(next.cities)) {
    const old = before.cities[city.cityKey]!;
    if (JSON.stringify(city) !== JSON.stringify(old)) {
      await tx.city.update({ where: { worldId_cityKey: { worldId, cityKey: city.cityKey } }, data: city });
    }
  }
  for (const nation of Object.values(next.nations)) {
    if (JSON.stringify(nation) !== JSON.stringify(before.nations[nation.id])) {
      await tx.nation.update({ where: { worldId_id: { worldId, id: nation.id } }, data: nation });
    }
  }
  for (const general of Object.values(next.generals)) {
    if (JSON.stringify(general) !== JSON.stringify(before.generals[general.id])) {
      await tx.general.update({ where: { worldId_id: { worldId, id: general.id } }, data: general });
    }
  }
  await tx.diplomacy.deleteMany({ where: { worldId } });
  await tx.diplomacy.createMany({ data: next.diplomacies.map((entry) => ({ ...entry, worldId })) });
  await persistExt(tx, worldId, before.ext, next.ext);
  await persistCampaignState(tx, worldId, before, next);
  await persistCityResourcesState(
    tx,
    worldId,
    before,
    next,
    world.ruleFeatures.includes('city-resources-v1') ? readCampaignArmyTypes(world) : [],
  );
  if (treatyEnabled) await persistTreatyClosures(tx, worldId, before, next, { tick, sequence });
  for (const key of ruleRegistry.monthlyOrder ?? []) {
    const feature = engineFeatures.find((feature) => feature.key === key);
    if (feature && next.ruleFeatures?.includes(key))
      await feature.persistMonthly?.(tx, worldId, beforeReplay, features.replay, features.effects[key], {
        tick,
        sequence,
      });
  }
  await tx.world.update({ where: { id: worldId }, data: { monthlyTick: tick } });
  const snapshot = await loadReplayState(tx, worldId);
  await tx.yearbookSnapshot.create({
    data: {
      worldId,
      tick,
      ...date,
      sequence,
      data: yearbook as unknown as Prisma.InputJsonValue,
      stateHash: hashState(snapshot),
    },
  });
  await persistYearbookNations(tx, worldId, tick, next);
  for (const nation of yearbook.nations) {
    const where = { worldId_tick_nationId: { worldId, tick, nationId: nation.nationId } };
    // 같은 월드 잠금 안에서 기존 사건을 보존하고 월간 수치를 덧붙인다.
    const previous = await tx.nationHistory.findUnique({ where });
    const data = { ...(previous?.data as Prisma.JsonObject | undefined), ...nation } as Prisma.InputJsonValue;
    await tx.nationHistory.upsert({
      where,
      create: { worldId, tick, nationId: nation.nationId, data },
      update: { data },
    });
  }
  await persistRanking(tx, worldId, next, seed, { tick, ...date });
  return next;
}
