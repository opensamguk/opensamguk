import type { Prisma } from '@opensamguk/db';
import {
  assertSlotSet,
  isPolicyKey,
  isPolicyMode,
  emptyTurns,
  monthlyDate,
  runMonthly,
  type ReplayState,
  type WorldState,
} from '@opensamguk/rules';
import { rngFor } from '@opensamguk/shared';
import { hashState } from '@opensamguk/shared/node';
import { loadWorld } from './worldLoader';
import { persistRanking } from './ranking';
import { persistYearbookNations } from './nationArchive';
import { persistExt } from './extState';

export async function loadReplayState(tx: Prisma.TransactionClient, worldId: string): Promise<ReplayState> {
  const state = await loadWorld(tx, worldId);
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const generals = await tx.general.findMany({ where: { worldId } });
  const slots = await tx.generalTurn.findMany({ where: { worldId }, orderBy: { slot: 'asc' } });
  const modern = isPolicyMode({ fromSequence: world.policyFromSequence ?? null, actionSequence: world.actionSequence });
  const turns = Object.fromEntries(generals.map(({ id }) => [id, emptyTurns()]));
  for (const general of generals) if (modern) assertSlotSet(slots.filter((slot) => slot.generalId === general.id));
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
  return {
    state,
    turns,
    revisions: Object.fromEntries(generals.map(({ id, turnRevision }) => [id, turnRevision])),
    monthlyTick: world.monthlyTick,
    ...(policy ? { policy } : {}),
  };
}

export async function persistMonthly(
  tx: Prisma.TransactionClient,
  worldId: string,
  seed: string,
  tick: number,
  sequence: number,
): Promise<WorldState> {
  const before = await loadWorld(tx, worldId);
  const date = monthlyDate(before.startYear, tick);
  const result = runMonthly(before, tick, rngFor(seed, 'monthly', date.year, date.month));
  const next = result.state;
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
  await tx.world.update({ where: { id: worldId }, data: { monthlyTick: tick } });
  const snapshot = await loadReplayState(tx, worldId);
  await tx.yearbookSnapshot.create({
    data: {
      worldId,
      tick,
      ...date,
      sequence,
      data: result.yearbook as unknown as Prisma.InputJsonValue,
      stateHash: hashState(snapshot),
    },
  });
  await persistYearbookNations(tx, worldId, tick, next);
  for (const nation of result.yearbook.nations) {
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
