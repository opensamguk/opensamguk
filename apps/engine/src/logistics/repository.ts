import type { Prisma } from '@opensamguk/db';
import type { LogisticsMovement, WorldState } from '@opensamguk/rules';
import type { LogisticsRepository } from './port';
import { databaseNow } from '../lease';
import { loadReplayState } from '../monthly';
import { appendLogisticsMovements } from '../logisticsState';
import { persistEffects } from '../persist';

// 엔진이 확보한 리스·World 잠금의 트랜잭션만 받는다.
export class PgLogisticsRepository implements LogisticsRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async isUserActive(userId: string) {
    await this.tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
    const user = await this.tx.user.findUnique({ where: { id: userId }, select: { status: true } });
    return user?.status === 'ACTIVE';
  }

  async isSanctioned(worldId: string, userId: string) {
    const now = await databaseNow(this.tx);
    return (
      (await this.tx.sanction.findFirst({
        where: {
          userId,
          liftedAt: null,
          AND: [{ OR: [{ worldId: null }, { worldId }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
        },
        select: { id: true },
      })) !== null
    );
  }

  async loadForGeneral(worldId: string, generalId: number) {
    await this.tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${worldId} AND id = ${generalId} FOR UPDATE`;
    return (await loadReplayState(this.tx, worldId)).state;
  }

  async save(
    worldId: string,
    before: WorldState,
    next: WorldState,
    movements: readonly LogisticsMovement[],
    at: { tick: number; sequence: number },
  ) {
    await persistEffects(this.tx, worldId, next, [{ kind: 'world', state: next }], at, before);
    await appendLogisticsMovements(this.tx, worldId, movements, at);
  }
}
