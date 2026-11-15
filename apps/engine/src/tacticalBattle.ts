import type { Prisma } from '@opensamguk/db';
import { nextActionSequence } from '@opensamguk/db';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  applyBattleInput,
  applyBattleStep,
  battleStateHash,
  battleParticipant,
  canCommandBattleUnit,
  battleCancellation,
  unitSetSchema,
  type WorldView,
  type BattleState,
} from '@opensamguk/rules';
import { battleTurnInputSchema } from '@opensamguk/shared';
import type { EngineWorld, QueuedInputHandler } from './features';
import { loadWorld } from './worldLoader';
import { databaseNow } from './lease';
import { persistEffects } from './persist';
import { loadReplayState } from './monthly';
import { engineFeatures } from './features';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const envelope = z.object({ input: z.unknown(), receivedAt: z.number().int(), sessionId: z.string() });
async function allowed(tx: Prisma.TransactionClient, worldId: string, userId: string, sessionId: string, now: Date) {
  if (
    !(await tx.session.findFirst({
      where: { id: sessionId, userId, expiresAt: { gt: now }, user: { status: 'ACTIVE' } },
    }))
  )
    return false;
  return !(await tx.sanction.findFirst({
    where: {
      userId,
      liftedAt: null,
      AND: [{ OR: [{ worldId: null }, { worldId }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  }));
}
export const processTacticalInput: QueuedInputHandler = async (tx, world, event) => {
  const reject = (code: string) => ({ status: 'REJECTED' as const, result: { code, message: code } });
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED');
  const payload = envelope.parse(event.payload),
    now = await databaseNow(tx);
  if (event.generalId === null || !(await allowed(tx, world.id, event.userId, payload.sessionId, now)))
    return reject('ACTOR_INACTIVE');
  const before = await loadWorld(tx, world.id),
    actor = before.generals[event.generalId];
  if (actor?.userId !== event.userId || actor.removedAt !== undefined) return reject('ACTOR_INACTIVE');
  const input = payload.input as { battleId?: string };
  const b = before.campaign?.tactical?.battles.find((b) => b.id === input.battleId);
  if (!b || !b.deadlineAt || payload.receivedAt >= b.deadlineAt) return reject('WINDOW_CLOSED');
  const outcome = applyBattleInput(before, event.kind, payload.input, actor.id);
  if (!outcome.ok) return reject(outcome.code);
  const sequence = await tx.world.findUniqueOrThrow({ where: { id: world.id }, select: { actionSequence: true } });
  await persistEffects(
    tx,
    world.id,
    outcome.state,
    [{ kind: 'world', state: outcome.state }],
    { tick: world.clockTick, sequence: sequence.actionSequence },
    before,
  );
  return { status: 'APPLIED', result: json(outcome.result) };
};

export async function persistTacticalTables(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
  sequence: number,
) {
  for (const b of next.campaign?.tactical?.battles ?? []) {
    const old = before.campaign?.tactical?.battles.find((v) => v.id === b.id);
    if (isDeepStrictEqual(old, b)) continue;
    await tx.battle.upsert({
      where: { worldId_id: { worldId, id: b.id } },
      create: {
        worldId,
        id: b.id,
        revision: b.revision,
        phase: b.fault ? 'FAULTED' : b.phase,
        deadlineAt: new Date(b.deadlineAt),
        state: json(b),
      },
      update: {
        revision: b.revision,
        phase: b.fault ? 'FAULTED' : b.phase,
        deadlineAt: new Date(b.deadlineAt),
        state: json(b),
      },
    });
    if (!old) {
      const keys = [
        `city:${b.targetCityKey}`,
        `garrison:${b.targetCityKey}`,
        ...b.units.flatMap((u) => [
          ...(u.sourceId === null ? [] : [`unit:${u.sourceId}`]),
          ...(u.ownerId === null ? [] : [`general:${u.ownerId}`]),
          ...(u.commanderId === null ? [] : [`general:${u.commanderId}`]),
        ]),
        ...Object.values(b.sides).flatMap((s) => s.riceOwners.map((o) => `rice:${b.id}:${o.kind}:${o.id}`)),
      ];
      for (const key of new Set(keys)) {
        const row = await tx.battleReservation.findFirst({ where: { worldId, key, releasedSequence: null } });
        if (row?.releasedSequence === null) throw Error('BATTLE_BUSY');
        await tx.battleReservation.create({ data: { worldId, key, battleId: b.id, createdSequence: sequence } });
      }
    }
    for (const record of b.records.filter((r) => r.turn > (old?.turn ?? 0))) {
      await tx.battleTurn.create({
        data: {
          worldId,
          battleId: b.id,
          turnNo: record.turn,
          beforeHash: record.beforeHash,
          afterHash: record.afterHash,
          record: json(record),
          attackView: json(b.views.attack.find((f) => f.turn === record.turn)),
          defendView: json(b.views.defend.find((f) => f.turn === record.turn)),
        },
      });
    }
    for (const frame of b.frames) {
      const prior = old?.frames.find((f) => f.turn === frame.turn)?.events.length ?? 0;
      const added = frame.events.slice(prior);
      if (added.length)
        await tx.battleEvent.createMany({
          data: added.map((event, index) => ({
            worldId,
            battleId: b.id,
            turnNo: frame.turn,
            ordinal: prior + index,
            data: json(event),
          })),
        });
      if (frame.turn > 0 && old?.frames.some((f) => f.turn === frame.turn) && added.length)
        await tx.battleTurn.updateMany({
          where: { worldId, battleId: b.id, turnNo: frame.turn },
          data: {
            attackView: json(b.views.attack.find((f) => f.turn === frame.turn)),
            defendView: json(b.views.defend.find((f) => f.turn === frame.turn)),
          },
        });
    }
    if (b.settled && !old?.settled)
      await tx.battleReservation.updateMany({
        where: { worldId, battleId: b.id, releasedSequence: null },
        data: { releasedSequence: sequence },
      });
  }
}

export async function processTacticalStep(
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  now: Date,
  forceCancel?: string,
) {
  const before = await loadWorld(tx, world.id);
  const candidates =
    before.campaign?.tactical?.battles.filter(
      (b) => !b.settled && (forceCancel || (!b.fault && b.pausedAt === null)),
    ) ?? [];
  let selected: BattleState | undefined;
  for (const b of candidates) {
    const human = Object.values(b.sides).some(
      (s) => s.commanderId !== null && before.generals[s.commanderId]?.userId !== null,
    );
    const ready = Object.values(b.sides).every(
      (s) => s.ready || s.commanderId === null || before.generals[s.commanderId]?.userId === null,
    );
    if (
      forceCancel ||
      !b.deadlineAt ||
      battleCancellation(before, b) ||
      b.deadlineAt <= now.getTime() ||
      (b.phase === 'council' && (!human || ready))
    ) {
      selected = b;
      break;
    }
  }
  if (!selected) return null;
  const b = selected;
  let present = false;
  const presence = await tx.battlePresence.findMany({
    where: { worldId: world.id, battleId: b.id, receivedAt: { gt: new Date(now.getTime() - 45_000) } },
  });
  for (const p of presence) {
    const g = before.generals[p.generalId];
    if (
      g?.userId &&
      Object.values(b.sides).some((s) => s.commanderId === g.id) &&
      (await allowed(tx, world.id, g.userId, p.sessionId, now))
    )
      present = true;
  }
  const orders = new Map<
    number,
    { unitId: number; action: ReturnType<typeof battleTurnInputSchema.parse>['action'] }
  >();
  const inputs = await tx.inputEvent.findMany({
    where: {
      worldId: world.id,
      kind: 'battle.turn',
      status: 'APPLIED',
      payload: { path: ['input', 'battleId'], equals: b.id },
    },
    orderBy: { id: 'asc' },
  });
  const receipts: Array<{ id: string; status: 'APPLIED' | 'REJECTED'; reason: string | null }> = [];
  const selectedReceipts = new Map<number, { id: string; status: 'APPLIED' | 'REJECTED'; reason: string | null }>();
  for (const event of inputs) {
    const e = envelope.parse(event.payload),
      input = battleTurnInputSchema.parse(e.input);
    if (input.windowNo !== b.windowNo || input.turnNo !== b.turn + 1) continue;
    const receipt: { id: string; status: 'APPLIED' | 'REJECTED'; reason: string | null } = {
      id: event.id.toString(),
      status: 'REJECTED',
      reason: 'NOT_ALLOWED',
    };
    receipts.push(receipt);
    if (event.generalId === null || !(await allowed(tx, world.id, event.userId, e.sessionId, now))) continue;
    const actor = before.generals[event.generalId];
    if (
      actor?.userId === event.userId &&
      battleParticipant(b, actor.id) &&
      canCommandBattleUnit(b, actor.id, input.unitId, before)
    ) {
      const previous = selectedReceipts.get(input.unitId);
      if (previous) {
        previous.status = 'REJECTED';
        previous.reason = 'SUPERSEDED';
      }
      receipt.status = 'APPLIED';
      receipt.reason = null;
      selectedReceipts.set(input.unitId, receipt);
      orders.set(input.unitId, { unitId: input.unitId, action: input.action });
    }
  }
  const cancellation = forceCancel ?? battleCancellation(before, b);
  if (cancellation)
    for (const receipt of receipts) {
      receipt.status = 'REJECTED';
      receipt.reason = 'BATTLE_CANCELLED';
    }
  const payload = {
    battleId: b.id,
    now: now.getTime(),
    turnTermMinutes: world.turnTermMinutes,
    present,
    orders: [...orders.values()].sort((a, c) => a.unitId - c.unitId),
    cancel: cancellation,
    receipts,
  };
  const beforeReplay = await loadReplayState(tx, world.id);
  let next;
  try {
    next = applyBattleStep(before, payload, unitSetSchema.parse(world.unitSet));
  } catch {
    Object.assign(payload, { fault: 'TACTICAL_CALCULATION_FAILED' });
    next = applyBattleStep(before, payload, unitSetSchema.parse(world.unitSet));
  }
  const sequence = await nextActionSequence(tx, world.id),
    after = next.campaign!.tactical!.battles.find((v) => v.id === b.id)!;
  await tx.inputEvent.create({
    data: {
      worldId: world.id,
      userId: '__engine__',
      generalId: null,
      kind: 'battle.step',
      idempotencyKey: `battle.step:${b.id}:${b.revision}`,
      payload: json(payload),
      status: 'APPLIED',
      sequence,
      tick: world.clockTick,
      result: { hash: battleStateHash(after) },
    },
  });
  await persistEffects(
    tx,
    world.id,
    next,
    [{ kind: 'world', state: next }],
    { tick: world.clockTick, sequence },
    before,
  );
  for (const feature of engineFeatures)
    if (feature.key !== 'campaign-v1')
      await feature.afterQueuedInput?.(tx, world, beforeReplay, {
        sequence,
        tick: world.clockTick,
        generalId: null,
        kind: 'battle.step',
        status: 'APPLIED',
        payload,
        result: { hash: battleStateHash(after) },
      });
  return loadWorld(tx, world.id);
}
export async function cancelTacticalBattles(
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  now: Date,
  reason: string,
) {
  while (await processTacticalStep(tx, world, now, reason)) {
    /* 같은 종료 트랜잭션에서 각 묶음을 한 번 정산한다. */
  }
}
