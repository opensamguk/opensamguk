import type { Prisma } from '@opensamguk/db';
import type { RealtimeSignal } from '@opensamguk/db';
import type { CommandResult, WorldState } from '@opensamguk/rules';
import { loadWorld } from './worldLoader';
import { persistPublicNationEvents, persistRemovedNations, type ActionAt } from './nationArchive';
import { persistCampaignState, readCampaignArmyTypes } from './campaignState';
import { persistCityResourcesState } from './cityResourcesState';
import { persistLogisticsState } from './logisticsState';
import { persistGovernanceState } from './governance/repository';
import { persistLineageState } from './lineage/repository';
import { persistStratagemCardsState } from './stratagemCards/state';
import { persistEquipmentState } from './equipmentState';
import { persistNationStrategy } from './nationStrategyState';
import { persistPreparedTurns } from './preparedTurnsState';
import { persistNationResearch } from './nationResearchState';
import { persistNationLifecycle } from './nationLifecycleState';

export async function loadCommandState(
  tx: Prisma.TransactionClient,
  worldId: string,
  lockedWorld?: Pick<Prisma.WorldGetPayload<Record<string, never>>, 'commandMeta'>,
): Promise<Pick<WorldState, 'commandMeta' | 'nationTurns'>> {
  const world =
    lockedWorld ?? (await tx.world.findUniqueOrThrow({ where: { id: worldId }, select: { commandMeta: true } }));
  const slots = await tx.nationTurn.findMany({ where: { worldId }, orderBy: [{ nationId: 'asc' }, { slot: 'asc' }] });
  const nationTurns: NonNullable<WorldState['nationTurns']> = {};
  for (const slot of slots) {
    nationTurns[slot.nationId] ??= Array.from({ length: 30 }, () => ({ commandKey: 'nation_rest', args: {} }));
    nationTurns[slot.nationId]![slot.slot] = { commandKey: slot.commandKey, args: slot.args };
  }
  return {
    ...(world.commandMeta ? { commandMeta: world.commandMeta as NonNullable<WorldState['commandMeta']> } : {}),
    ...(slots.length ? { nationTurns } : {}),
  };
}

export async function persistCommandState(
  tx: Prisma.TransactionClient,
  worldId: string,
  state: WorldState,
  at: ActionAt,
  previous?: WorldState,
  beforeNationRemoval?: () => Promise<void>,
  // 같은 트랜잭션에서 잠근 World 행의 원생성을 검증해 얻은 목록만 전달한다.
  knownCityArmyTypes?: readonly number[],
  cityTransfer?: CommandResult['cityTransfer'],
) {
  // 같은 잠긴 트랜잭션에서 읽은 사본은 다시 조회하지 않는다.
  const before = previous ?? (await loadWorld(tx, worldId));
  await persistNationLifecycle(tx, worldId, before, state);
  await persistNationStrategy(tx, worldId, before, state);
  await persistPreparedTurns(tx, worldId, before, state);
  await persistNationResearch(tx, worldId, before, state);
  await persistCampaignState(tx, worldId, before, state);
  const cityArmyTypes = before.ruleFeatures?.includes('city-resources-v1')
    ? (knownCityArmyTypes ??
      readCampaignArmyTypes(
        await tx.world.findUniqueOrThrow({ where: { id: worldId }, select: { unitSet: true, replayOrigin: true } }),
      ))
    : [];
  await persistCityResourcesState(tx, worldId, before, state, cityArmyTypes);
  await persistLogisticsState(tx, worldId, before, state);
  await persistGovernanceState(tx, worldId, before, state);
  await persistLineageState(tx, worldId, before, state);
  await persistEquipmentState(tx, worldId, before, state);
  await persistStratagemCardsState(tx, worldId, before, state);
  for (const nation of Object.values(state.nations)) {
    if (!before.nations[nation.id]) {
      await tx.nation.create({ data: { ...nation, worldId, capitalCityKey: null } });
    }
  }
  for (const city of Object.values(state.cities)) {
    if (JSON.stringify(city) !== JSON.stringify(before.cities[city.cityKey]))
      await tx.city.update({ where: { worldId_cityKey: { worldId, cityKey: city.cityKey } }, data: city });
  }
  for (const nation of Object.values(state.nations)) {
    if (JSON.stringify(nation) !== JSON.stringify(before.nations[nation.id]))
      await tx.nation.update({ where: { worldId_id: { worldId, id: nation.id } }, data: nation });
  }
  const generals = Object.values(state.generals);
  if (before.officeEffects) {
    for (const general of generals) {
      const old = before.generals[general.id];
      if (
        old?.officerCityKey == null ||
        (general.officerCityKey === old.officerCityKey && general.officerLevel === old.officerLevel)
      )
        continue;
      await tx.general.update({
        where: { worldId_id: { worldId, id: general.id } },
        data: { officerCityKey: null },
      });
    }
  }
  for (const general of generals) {
    if (JSON.stringify(general) !== JSON.stringify(before.generals[general.id])) {
      // 장수 턴의 nextTurnTick·revision은 TurnLoop의 조건부 갱신만 바꾼다.
      const { nextTurnTick, ...data } = general;
      void nextTurnTick;
      await tx.general.update({
        where: { worldId_id: { worldId, id: general.id } },
        data: {
          ...data,
          ...(general.nationId === before.generals[general.id]?.nationId
            ? {}
            : { nationJoinedTick: general.nationId === null ? null : at.tick }),
        },
      });
    }
  }
  if (JSON.stringify(state.diplomacies) !== JSON.stringify(before.diplomacies)) {
    await tx.diplomacy.deleteMany({ where: { worldId } });
    await tx.diplomacy.createMany({ data: state.diplomacies.map((d) => ({ ...d, worldId })) });
  }
  if (JSON.stringify(state.nationTurns) !== JSON.stringify(before.nationTurns)) {
    await tx.nationTurn.deleteMany({ where: { worldId } });
    await tx.nationTurn.createMany({
      data: Object.entries(state.nationTurns ?? {}).flatMap(([nationId, slots]) =>
        slots.map((slot, i) => ({
          worldId,
          nationId: Number(nationId),
          slot: i,
          commandKey: slot.commandKey,
          args: slot.args as Prisma.InputJsonValue,
        })),
      ),
    });
  }
  await persistCommandMeta(tx, worldId, before, state);
  // 새 국가의 FK 대상은 생긴 뒤, 멸망 국가의 직책이 연쇄 삭제되기 전에 후속 상태를 저장한다.
  await beforeNationRemoval?.();
  await persistPublicNationEvents(tx, worldId, before, state, at, cityTransfer);
  await persistRemovedNations(tx, worldId, before, state, at);
}

export async function persistCommandMeta(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldState,
  next: WorldState,
) {
  if (JSON.stringify(next.commandMeta) !== JSON.stringify(before.commandMeta)) {
    if (next.commandMeta)
      await tx.world.update({
        where: { id: worldId },
        data: { commandMeta: next.commandMeta as Prisma.InputJsonValue },
      });
    else await tx.$executeRaw`UPDATE "World" SET "commandMeta" = NULL WHERE id = ${worldId}`;
  }
}

export async function persistCommandReports(
  tx: Prisma.TransactionClient,
  worldId: string,
  tick: number,
  attackerId: number,
  result: CommandResult,
) {
  if (result.attackTarget) {
    await tx.city.update({
      where: { worldId_cityKey: { worldId, cityKey: result.attackTarget.cityKey } },
      data: { conflictTick: tick },
    });
  }
  if (result.stratagemCityKey !== undefined) {
    await tx.city.update({
      where: { worldId_cityKey: { worldId, cityKey: result.stratagemCityKey } },
      data: { stratagemTick: tick },
    });
  }
  if (result.stratagemSucceeded) {
    await tx.general.update({
      where: { worldId_id: { worldId, id: attackerId } },
      data: { stratagemSuccesses: { increment: 1 } },
    });
  }
  for (const award of result.battleAwards ?? []) {
    await tx.general.update({
      where: { worldId_id: { worldId, id: award.generalId } },
      data: { battleWins: { increment: award.wins }, captures: { increment: award.captures } },
    });
  }
  const engagements = result.generalEngagements ?? [];
  const opponents = new Set(engagements.flatMap(({ attackerId, defenderId }) => [attackerId, defenderId]));
  const humans = new Set(
    opponents.size
      ? (
          await tx.general.findMany({
            where: { worldId, id: { in: [...opponents] }, userId: { not: null } },
            select: { id: true },
          })
        ).map(({ id }) => id)
      : [],
  );
  for (const engagement of engagements) {
    for (const [generalId, opponentId, kills, casualties] of [
      [engagement.attackerId, engagement.defenderId, engagement.defenderLoss, engagement.attackerLoss],
      [engagement.defenderId, engagement.attackerId, engagement.attackerLoss, engagement.defenderLoss],
    ] as const) {
      const wins = Number(engagement.winnerId === generalId);
      const losses = Number(engagement.winnerId !== null && engagement.winnerId !== generalId);
      const human = humans.has(opponentId);
      await tx.generalBattleStats.upsert({
        where: { worldId_generalId: { worldId, generalId } },
        create: {
          worldId,
          generalId,
          engagements: 1,
          wins,
          losses,
          kills,
          casualties,
          lastTick: tick,
          ...(human ? { humanEngagements: 1, humanKills: kills, humanCasualties: casualties } : {}),
        },
        update: {
          engagements: { increment: 1 },
          wins: { increment: wins },
          losses: { increment: losses },
          kills: { increment: kills },
          casualties: { increment: casualties },
          ...(human
            ? {
                humanEngagements: { increment: 1 },
                humanKills: { increment: kills },
                humanCasualties: { increment: casualties },
              }
            : {}),
          lastTick: tick,
        },
      });
    }
  }
  await tx.battleLog.createMany({
    data: (result.reports ?? []).map((report) => ({ ...report, worldId, tick, attackerId })),
  });
  for (const entry of result.history ?? [])
    await appendNationHistory(tx, worldId, tick, entry.nationId, entry.text, entry.kind);
}
export async function appendNationHistory(
  tx: Prisma.TransactionClient,
  worldId: string,
  tick: number,
  nationId: number,
  text: string,
  kind?: 'intel',
) {
  const where = { worldId_tick_nationId: { worldId, tick, nationId } };
  const previous = await tx.nationHistory.findUnique({ where });
  const data = (previous?.data ?? {}) as Record<string, Prisma.InputJsonValue>;
  const events = Array.isArray(data.events) ? data.events : [];
  const alerts = Array.isArray(data.intelAlerts) ? data.intelAlerts : [];
  const next = { ...data, events: [...events, text], ...(kind === 'intel' ? { intelAlerts: [...alerts, text] } : {}) };
  await tx.nationHistory.upsert({
    where,
    create: { worldId, tick, nationId, data: next },
    update: { data: next },
  });
}

export function commandRealtimeSignals(before: WorldState, state: WorldState): RealtimeSignal[] {
  const signals: RealtimeSignal[] = [];
  for (const [id, nationId] of Object.entries(state.commandMeta?.offers ?? {}))
    if (before.commandMeta?.offers[Number(id)] !== nationId)
      signals.push({ kind: 'offer.new', target: { generalId: Number(id) } });
  for (const diplomacy of state.diplomacies) {
    const prior = before.diplomacies.find((d) => d.nationA === diplomacy.nationA && d.nationB === diplomacy.nationB);
    if (JSON.stringify(prior) !== JSON.stringify(diplomacy))
      signals.push({ kind: 'treaty.new', target: { nationIds: [diplomacy.nationA, diplomacy.nationB] } });
  }
  return signals;
}
