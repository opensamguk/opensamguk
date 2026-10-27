import { publicMapConfig } from '@opensamguk/shared';
import { persistPublicMap } from './publicMap';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { nextActionSequence, notifyWorld, type RealtimeSignal } from '@opensamguk/db';
import {
  checkpointClock,
  monthlyDate,
  toGameDate,
  seasonOutcome,
  runGeneralTurn,
  unitSetSchema,
  TICKS_PER_MONTH,
  assertSlotSet,
  isPolicyKey,
  isPolicyMode,
  completePersonnelStep,
  updateResidenceAnchors,
  type WorldState,
} from '@opensamguk/rules';
import { appendNationHistory, persistCommandReports, commandRealtimeSignals } from './commandPersistence';
import { assertLease, databaseNow, lockLease, type Lease } from './lease';
import { loadWorld, loadWorldAfterCapabilityCheck } from './worldLoader';
import { persistEffects, shiftTurns } from './persist';
import { persistMonthly, loadReplayState } from './monthly';
import { hashState } from '@opensamguk/shared/node';
import { processInputs, processPendingInput } from './inputs';
import { checkWorldReplay } from './features';
import { persistPersonnelPacket } from './ruleFeatures';
import { engineResolver, persistExt, verifyWorldExt } from './extState';
import { assertWorldCapabilities } from './capsGate';

export const CLOCK_CHECKPOINT_MS = 5_000;
export const ENGINE_BATCH_STEPS = 64;
export const ENGINE_BATCH_MS = 250;
type WorldStatus = Prisma.WorldGetPayload<Record<string, never>>['status'];
async function policyBaseline(tx: Prisma.TransactionClient, world: Prisma.WorldGetPayload<Record<string, never>>) {
  if (world.replayFormat === 3 || world.policyFromSequence !== null) return undefined;
  const human = await tx.general.findFirst({
    where: { worldId: world.id, userId: { not: null } },
    select: { id: true },
  });
  return human ? world.clockTick : undefined;
}
export interface PollBatch {
  executions: TurnExecution[];
  more: boolean;
  status: WorldStatus;
}
type TurnHooks = {
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  elapsedNow?: () => number;
  publicMapNow?: () => number;
};
export interface TurnExecution {
  generalId: number;
  tick: number;
  commandKey: string;
}

export class TurnLoop {
  private highWaterTick = 0;
  private committedState: WorldState | null = null;
  private extVerified = false;
  private busy = false;
  private replayChecked = false;
  private readonly elapsedNow: () => number;
  private nextCheckpointAt: number;
  private readonly mapConfig = publicMapConfig(process.env);

  constructor(
    private readonly db: PrismaClient,
    readonly lease: Lease,
    private readonly hooks: TurnHooks = {},
  ) {
    this.elapsedNow = hooks.elapsedNow ?? (() => performance.now());
    this.nextCheckpointAt = this.elapsedNow() + CLOCK_CHECKPOINT_MS;
  }

  get state(): WorldState | null {
    return this.committedState && structuredClone(this.committedState);
  }

  async advanceTo(tick: number, signal?: AbortSignal): Promise<TurnExecution[]> {
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > 2_147_483_647 - TICKS_PER_MONTH) {
      throw new Error('진행할 tick이 올바르지 않습니다.');
    }
    return (await this.drain(tick, signal)).executions;
  }

  async poll(signal?: AbortSignal): Promise<PollBatch> {
    return this.drain(undefined, signal);
  }

  private async drain(target: number | undefined, signal?: AbortSignal): Promise<PollBatch> {
    if (this.busy) throw new Error('이미 턴을 실행 중입니다.');
    this.busy = true;
    try {
      const executions: TurnExecution[] = [];
      const started = this.elapsedNow();
      let steps = 0;
      let status: WorldStatus = 'PREOPEN';
      while (!signal?.aborted) {
        const result = await this.step(target, signal);
        status = result.status;
        // 실패한 트랜잭션의 메모리 사본은 여기까지 오지 못한다.
        if (result.state) this.committedState = result.state;
        this.highWaterTick = Math.max(this.highWaterTick, result.tick);
        if (result.checkpointed) this.nextCheckpointAt = this.elapsedNow() + CLOCK_CHECKPOINT_MS;
        if (result.execution) executions.push(result.execution);
        if (!result.progressed) break;
        steps++;
        if (target === undefined && (steps >= ENGINE_BATCH_STEPS || this.elapsedNow() - started >= ENGINE_BATCH_MS))
          return { executions, status, more: true };
      }
      return { executions, status, more: false };
    } finally {
      this.busy = false;
    }
  }

  private async step(target: number | undefined, signal?: AbortSignal) {
    const { worldId } = this.lease;
    const signals: RealtimeSignal[] = [];
    const result = await this.db.$transaction(
      async (tx) => {
        await lockLease(tx, this.lease);
        // 일시정지·재개와 턴 commit이 같은 월드 행에서 직렬화된다.
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        if (world.replayFormat === 3 && !this.replayChecked) checkWorldReplay(world);
        const capabilities = await assertWorldCapabilities(tx, world);
        if (!this.extVerified) await verifyWorldExt(tx, world);
        const baselineActiveTick = await policyBaseline(tx, world);
        if (world.status !== 'RUNNING') {
          const deferInputs =
            world.replayFormat === 3 &&
            world.status === 'PAUSED' &&
            world.monthlyTick + TICKS_PER_MONTH <= world.clockTick;
          const inputResult = deferInputs
            ? false
            : world.replayFormat === 3
              ? await processInputs(tx, world, world.clockTick, undefined, (signal) => signals.push(signal))
              : await processPendingInput(tx, world, world.clockTick, baselineActiveTick);
          const progressed = inputResult === true;
          if (progressed) await this.hooks.beforeCommit?.(tx);
          signal?.throwIfAborted();
          await assertLease(tx, this.lease);
          return {
            tick: world.clockTick,
            state: null,
            execution: null,
            checkpointed: false,
            progressed,
            status: world.status,
          };
        }
        const now = (await databaseNow(tx)).getTime();
        const clock = { ...world, clockAnchorAt: world.clockAnchorAt?.getTime() ?? null };
        const checkpoint = checkpointClock(clock, now, this.highWaterTick);
        const boundary = world.monthlyTick + TICKS_PER_MONTH;
        const year = monthlyDate(world.startYear, boundary).year;
        const accelerated = target === undefined && world.clockMode === 'ACCELERATED';
        const earliest = accelerated
          ? await tx.general.findFirst({
              where: { worldId, activeFromYear: { lte: year } },
              orderBy: [{ nextTurnTick: 'asc' }, { id: 'asc' }],
            })
          : null;
        const tick =
          target ??
          (accelerated
            ? Math.max(world.clockTick, Math.min(boundary, earliest?.nextTurnTick ?? boundary))
            : checkpoint.clockTick);
        if (tick < world.clockTick) throw new Error('이미 저장된 시계보다 뒤로 진행할 수 없습니다.');
        if (tick > 2_147_483_647 - TICKS_PER_MONTH) throw new Error('게임 tick 저장 범위를 넘었습니다.');
        const catchUp = world.replayFormat === 3 && boundary <= tick;
        const inputResult = catchUp
          ? false
          : world.replayFormat === 3
            ? await processInputs(tx, world, tick, undefined, (signal) => signals.push(signal))
            : await processPendingInput(tx, world, tick, baselineActiveTick);
        if (inputResult !== false) {
          const state = await loadWorld(tx, worldId);
          await this.hooks.beforeCommit?.(tx);
          signal?.throwIfAborted();
          await assertLease(tx, this.lease);
          return {
            tick,
            state,
            execution: null,
            checkpointed: false,
            progressed: inputResult === true,
            status: world.status,
          };
        }
        const due = await tx.general.findFirst({
          where: { worldId, nextTurnTick: { lte: tick }, activeFromYear: { lte: year } },
          orderBy: [{ nextTurnTick: 'asc' }, { id: 'asc' }],
        });
        const monthly = boundary <= tick && (!due || due.nextTurnTick >= boundary);
        const progressed = monthly || due !== null;
        const checkpointed = progressed || target !== undefined || this.elapsedNow() >= this.nextCheckpointAt;
        if (!checkpointed)
          return { tick, state: null, execution: null, checkpointed: false, progressed: false, status: world.status };
        let execution: TurnExecution | null = null;
        let next: WorldState | null = null;
        let sequence = 0;
        if (monthly) {
          sequence = await nextActionSequence(tx, worldId);
          next = await persistMonthly(tx, worldId, world.seed, boundary, sequence);
        } else if (due) {
          sequence = await nextActionSequence(tx, worldId);
          await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND id = ${due.id} FOR UPDATE`;
          // 예턴 편집은 actor 행 잠금 또는 turnRevision 조건을 함께 사용해야 한다.
          const personnelBefore =
            world.replayFormat === 3 && world.ruleFeatures.includes('personnel')
              ? await loadReplayState(tx, worldId)
              : null;
          const state = personnelBefore?.state ?? (await loadWorldAfterCapabilityCheck(tx, world, capabilities));
          const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: due.id } } });
          const slots = await tx.generalTurn.findMany({
            where: { worldId, generalId: due.id },
            orderBy: { slot: 'asc' },
          });
          const command = slots.find((slot) => slot.slot === 0);
          const modern =
            world.replayFormat === 3
              ? world.ruleFeatures.includes('policy')
              : isPolicyMode({ fromSequence: world.policyFromSequence, actionSequence: world.actionSequence });
          if (modern) {
            assertSlotSet(slots);
            if (!isPolicyKey(actor.defaultPolicy)) throw new Error('기본 방침이 올바르지 않습니다.');
          }
          const treatiesHash =
            world.treatyFormat === 1 ? hashState(state.treaties ? { treaties: state.treaties } : {}) : null;
          const turn = runGeneralTurn(
            state,
            { generalId: due.id, tick: due.nextTurnTick, unitSet: unitSetSchema.parse(world.unitSet) },
            {
              commandKey: command?.commandKey ?? 'rest',
              args: command?.args ?? {},
              ...(modern ? { explicit: command!.explicit } : {}),
            },
            world.seed,
            modern ? { policy: actor.defaultPolicy as import('@opensamguk/rules').PolicyKey } : {},
            engineResolver(world).resolver,
            ...(personnelBefore ? ([{ offices: personnelBefore.offices! }] as const) : []),
          );
          if (
            treatiesHash !== null &&
            treatiesHash !== hashState(turn.state.treaties ? { treaties: turn.state.treaties } : {})
          )
            throw new Error('턴 실행 중 조약 목록이 바뀌었습니다.');
          const commandKey = turn.commandKey;
          const result = turn.result;
          const failed = 'code' in result;
          next = turn.state;
          next.generals[due.id]!.nextTurnTick = due.nextTurnTick + TICKS_PER_MONTH;
          const personnelPacket = personnelBefore
            ? completePersonnelStep(
                personnelBefore.state,
                personnelBefore.offices!,
                { state: next, ...turn.personnel! },
                due.nextTurnTick,
              )
            : null;
          const anchors =
            personnelBefore && personnelPacket
              ? updateResidenceAnchors({
                  before: personnelBefore.state,
                  after: personnelPacket.state,
                  anchors: personnelBefore.residenceAnchors!,
                  tick: due.nextTurnTick,
                  createdHumanId: null,
                })
              : null;
          if (personnelPacket) next = personnelPacket.state;
          signals.push(...commandRealtimeSignals(state, next));
          await persistEffects(
            tx,
            worldId,
            next,
            [{ kind: 'world', state: next }],
            { sequence, tick: due.nextTurnTick },
            state,
          );
          await persistExt(tx, worldId, state.ext, next.ext);
          if (personnelBefore && personnelPacket && anchors)
            await persistPersonnelPacket(tx, worldId, personnelBefore, personnelPacket, anchors, due.nextTurnTick);
          if (!failed) await persistCommandReports(tx, worldId, due.nextTurnTick, due.id, result);
          if (turn.nation) {
            const national = turn.nation.result;
            const nationId = turn.nation.nationId;
            if (!('code' in national)) await persistCommandReports(tx, worldId, due.nextTurnTick, due.id, national);
            if ('code' in national || !national.history?.some((entry) => entry.nationId === nationId)) {
              const name = engineResolver(world).resolver.get(turn.nation.commandKey)?.name ?? '국가 명령';
              await appendNationHistory(
                tx,
                worldId,
                due.nextTurnTick,
                nationId,
                `${name}: ${'code' in national ? `${national.code}: ${national.message}` : national.logs.map((log) => log.text).join('\n')}`,
              );
            }
          }
          await tx.generalLog.create({
            data: {
              worldId,
              generalId: due.id,
              tick: due.nextTurnTick,
              commandKey,
              kind: failed ? 'failure' : 'success',
              text: failed ? `${result.code}: ${result.message}` : result.logs.map((log) => log.text).join('\n'),
            },
          });
          await shiftTurns(tx, worldId, due.id, { ...world, actionSequence: sequence }, slots);
          const updated = await tx.general.updateMany({
            where: { worldId, id: due.id, nextTurnTick: due.nextTurnTick, turnRevision: actor.turnRevision },
            data: { nextTurnTick: due.nextTurnTick + TICKS_PER_MONTH, turnRevision: { increment: 1 } },
          });
          if (updated.count !== 1) throw new Error('예턴이 변경되어 턴 저장을 취소했습니다.');
          execution = { generalId: due.id, tick: due.nextTurnTick, commandKey };
        }
        const endedTick = monthly ? boundary : due?.nextTurnTick;
        const date = monthly ? monthlyDate(world.startYear, boundary) : toGameDate(world.startYear, endedTick ?? tick);
        const outcome =
          next && sequence > world.outcomeFromSequence
            ? seasonOutcome(next, {
                endYear: world.endYear,
                ...(monthly ? { settled: date } : {}),
              })
            : null;
        const savedTick = outcome ? Math.max(world.clockTick, endedTick!) : tick;
        const endedAt = outcome ? await databaseNow(tx) : null;
        if (outcome) {
          const winner = outcome.winnerNationId === null ? null : next!.nations[outcome.winnerNationId]!;
          await tx.worldResult.create({
            data: {
              worldId,
              ...outcome,
              winnerName: winner?.name ?? null,
              winnerColor: winner?.color ?? null,
              endedYear: date.year,
              endedMonth: date.month,
              endedTick: endedTick!,
              endedSequence: sequence,
              remainingNations: Object.keys(next!.nations).length,
              finalStateHash: hashState(await loadReplayState(tx, worldId)),
              endedAt: endedAt!,
            },
          });
        }
        const saved = await tx.world.updateMany({
          where: { id: worldId, status: 'RUNNING', clockRevision: world.clockRevision },
          data: {
            clockTick: savedTick,
            clockAnchorAt: new Date(target === undefined && !accelerated && !outcome ? checkpoint.clockAnchorAt! : now),
            clockRevision: { increment: 1 },
            ...(outcome ? { status: 'ENDED', endedAt } : {}),
          },
        });
        if (saved.count !== 1) throw new Error('월드 시계가 바뀌어 저장을 취소했습니다.');
        if (next && progressed && !outcome) {
          await persistPublicMap(
            tx,
            this.lease,
            next,
            endedTick!,
            this.hooks.publicMapNow?.() ?? (await databaseNow(tx)).getTime(),
            this.mapConfig,
            {
              worldId,
              status: 'RUNNING',
            },
          );
        }
        if (monthly) signals.push({ kind: 'monthly.done', target: 'world' });
        if (execution) signals.push({ kind: 'turn.result', target: { generalId: execution.generalId } });
        if (progressed) await this.hooks.beforeCommit?.(tx);
        signal?.throwIfAborted();
        await assertLease(tx, this.lease);
        return {
          tick: savedTick,
          state: next,
          execution,
          checkpointed,
          progressed,
          status: outcome ? ('ENDED' as const) : world.status,
        };
      },
      { timeout: 30_000 },
    );
    this.extVerified = true;
    this.replayChecked = true;
    for (const signal of signals)
      await notifyWorld(this.db, worldId, signal, () => console.warn('실시간 알림 전송 실패'));
    return result;
  }
}
