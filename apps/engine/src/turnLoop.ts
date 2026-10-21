import type { Prisma, PrismaClient } from '@opensamguk/db';
import { nextActionSequence } from '@opensamguk/db';
import {
  checkpointClock,
  commandRegistry,
  monthlyDate,
  runGeneralTurn,
  unitSetSchema,
  TICKS_PER_MONTH,
  type WorldState,
} from '@opensamguk/rules';
import { appendNationHistory, persistCommandReports } from './commandPersistence';
import { assertLease, databaseNow, lockLease, type Lease } from './lease';
import { loadWorld } from './worldLoader';
import { persistEffects, shiftTurns } from './persist';
import { persistMonthly } from './monthly';
import { processCreation } from './inputs';

export const CLOCK_CHECKPOINT_MS = 5_000;
type TurnHooks = { beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>; elapsedNow?: () => number };
export interface TurnExecution {
  generalId: number;
  tick: number;
  commandKey: string;
}

export class TurnLoop {
  private highWaterTick = 0;
  private committedState: WorldState | null = null;
  private busy = false;
  private readonly elapsedNow: () => number;
  private nextCheckpointAt: number;

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
    return this.drain(tick, signal);
  }

  async poll(signal?: AbortSignal): Promise<TurnExecution[]> {
    return this.drain(undefined, signal);
  }

  private async drain(target: number | undefined, signal?: AbortSignal): Promise<TurnExecution[]> {
    if (this.busy) throw new Error('이미 턴을 실행 중입니다.');
    this.busy = true;
    try {
      const executions: TurnExecution[] = [];
      while (!signal?.aborted) {
        const result = await this.step(target, signal);
        // 실패한 트랜잭션의 메모리 사본은 여기까지 오지 못한다.
        if (result.state) this.committedState = result.state;
        this.highWaterTick = Math.max(this.highWaterTick, result.tick);
        if (result.checkpointed) this.nextCheckpointAt = this.elapsedNow() + CLOCK_CHECKPOINT_MS;
        if (result.execution) executions.push(result.execution);
        if (!result.progressed) break;
      }
      return executions;
    } finally {
      this.busy = false;
    }
  }

  private async step(target: number | undefined, signal?: AbortSignal) {
    const { worldId } = this.lease;
    return this.db.$transaction(
      async (tx) => {
        await lockLease(tx, this.lease);
        // 일시정지·재개와 턴 commit이 같은 월드 행에서 직렬화된다.
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        if (world.status !== 'RUNNING') {
          const progressed = await processCreation(tx, world, world.clockTick);
          if (progressed) await this.hooks.beforeCommit?.(tx);
          signal?.throwIfAborted();
          await assertLease(tx, this.lease);
          return { tick: world.clockTick, state: null, execution: null, checkpointed: false, progressed };
        }
        const now = (await databaseNow(tx)).getTime();
        const clock = { ...world, clockAnchorAt: world.clockAnchorAt?.getTime() ?? null };
        const checkpoint = checkpointClock(clock, now, this.highWaterTick);
        const tick = target ?? checkpoint.clockTick;
        if (tick < world.clockTick) throw new Error('이미 저장된 시계보다 뒤로 진행할 수 없습니다.');
        if (tick > 2_147_483_647 - TICKS_PER_MONTH) throw new Error('게임 tick 저장 범위를 넘었습니다.');
        if (await processCreation(tx, world, tick)) {
          const state = await loadWorld(tx, worldId);
          await this.hooks.beforeCommit?.(tx);
          signal?.throwIfAborted();
          await assertLease(tx, this.lease);
          return { tick, state, execution: null, checkpointed: false, progressed: true };
        }
        const boundary = world.monthlyTick + TICKS_PER_MONTH;
        const year = monthlyDate(world.startYear, boundary).year;
        const due = await tx.general.findFirst({
          where: { worldId, nextTurnTick: { lte: tick }, activeFromYear: { lte: year } },
          orderBy: [{ nextTurnTick: 'asc' }, { id: 'asc' }],
        });
        const monthly = boundary <= tick && (!due || due.nextTurnTick >= boundary);
        const progressed = monthly || due !== null;
        const checkpointed = progressed || target !== undefined || this.elapsedNow() >= this.nextCheckpointAt;
        if (!checkpointed) return { tick, state: null, execution: null, checkpointed: false, progressed: false };
        let execution: TurnExecution | null = null;
        let next: WorldState | null = null;
        if (monthly) {
          const sequence = await nextActionSequence(tx, worldId);
          next = await persistMonthly(tx, worldId, world.seed, boundary, sequence);
        } else if (due) {
          await nextActionSequence(tx, worldId);
          await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND id = ${due.id} FOR UPDATE`;
          // 예턴 편집은 actor 행 잠금 또는 turnRevision 조건을 함께 사용해야 한다.
          const state = await loadWorld(tx, worldId);
          const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: due.id } } });
          const command = await tx.generalTurn.findUnique({
            where: { worldId_generalId_slot: { worldId, generalId: due.id, slot: 0 } },
          });
          const commandKey = command?.commandKey ?? 'rest';
          const turn = runGeneralTurn(
            state,
            { generalId: due.id, tick: due.nextTurnTick, unitSet: unitSetSchema.parse(world.unitSet) },
            { commandKey, args: command?.args ?? {} },
            world.seed,
          );
          const result = turn.result;
          const failed = 'code' in result;
          next = turn.state;
          next.generals[due.id]!.nextTurnTick = due.nextTurnTick + TICKS_PER_MONTH;
          await persistEffects(tx, worldId, next, [{ kind: 'world', state: next }]);
          if (!failed) await persistCommandReports(tx, worldId, due.nextTurnTick, due.id, result);
          if (turn.nation) {
            const national = turn.nation.result;
            const nationId = turn.nation.nationId;
            if (!('code' in national)) await persistCommandReports(tx, worldId, due.nextTurnTick, due.id, national);
            if ('code' in national || !national.history?.some((entry) => entry.nationId === nationId)) {
              const name = commandRegistry.get(turn.nation.commandKey)?.name ?? '국가 명령';
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
          await shiftTurns(tx, worldId, due.id);
          const updated = await tx.general.updateMany({
            where: { worldId, id: due.id, nextTurnTick: due.nextTurnTick, turnRevision: actor.turnRevision },
            data: { nextTurnTick: due.nextTurnTick + TICKS_PER_MONTH, turnRevision: { increment: 1 } },
          });
          if (updated.count !== 1) throw new Error('예턴이 변경되어 턴 저장을 취소했습니다.');
          execution = { generalId: due.id, tick: due.nextTurnTick, commandKey };
        }
        await tx.world.update({
          where: { id: worldId },
          data: {
            clockTick: tick,
            clockAnchorAt: new Date(target === undefined ? checkpoint.clockAnchorAt! : now),
            clockRevision: { increment: 1 },
          },
        });
        if (progressed) await this.hooks.beforeCommit?.(tx);
        signal?.throwIfAborted();
        await assertLease(tx, this.lease);
        return { tick, state: next, execution, checkpointed, progressed };
      },
      { timeout: 30_000 },
    );
  }
}
