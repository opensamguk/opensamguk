import type { Prisma } from '@opensamguk/db';
import { HERITAGE_DIRECT_INPUT_KINDS } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import type { HeritageEntryWrite, HeritageRepository } from './port';

// World 잠금을 가진 엔진 트랜잭션 안에서만 쓴다. 계정 잠금은 잔액 잠금보다 먼저 잡는다.
export class PgHeritageRepository implements HeritageRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async lockUser(userId: string) {
    await this.tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
    const user = await this.tx.user.findUnique({ where: { id: userId }, select: { status: true } });
    return !user ? null : user.status === 'WITHDRAWN' ? ('WITHDRAWN' as const) : ('OPEN' as const);
  }

  async activity(worldId: string, endedSequence: number) {
    return this.tx.inputEvent.findMany({
      where: {
        worldId,
        status: 'APPLIED',
        sequence: { lte: endedSequence },
        kind: { in: [...HERITAGE_DIRECT_INPUT_KINDS] },
      },
      select: { userId: true, kind: true, status: true, sequence: true, tick: true, result: true },
    });
  }

  async append(entry: HeritageEntryWrite) {
    const detail = JSON.parse(JSON.stringify(entry.detail)) as Prisma.InputJsonObject;
    const inserted = await this.tx.heritageEntry.createMany({ data: [{ ...entry, detail }], skipDuplicates: true });
    if (inserted.count === 0) {
      const existing = await this.tx.heritageEntry.findUniqueOrThrow({
        where: { userId_key: { userId: entry.userId, key: entry.key } },
        select: { kind: true, worldId: true, delta: true, detail: true },
      });
      if (hashState(existing) !== hashState({ kind: entry.kind, worldId: entry.worldId, delta: entry.delta, detail }))
        throw new Error('같은 유산 원장 키의 내용이 다릅니다.');
      return false;
    }
    if (entry.delta < 0) {
      const saved = await this.tx.heritageAccount.updateMany({
        where: { userId: entry.userId, balance: { gte: -entry.delta } },
        data: { balance: { increment: entry.delta } },
      });
      if (saved.count !== 1) throw new Error('유산 몰수 잔액이 원장과 다릅니다.');
    } else {
      await this.tx.heritageAccount.upsert({
        where: { userId: entry.userId },
        create: { userId: entry.userId, balance: entry.delta },
        update: { balance: { increment: entry.delta } },
      });
    }
    return true;
  }

  async spend(input: Parameters<HeritageRepository['spend']>[0]) {
    const { userId, worldId, sequence, allocation } = input;
    const debited = await this.tx.heritageAccount.updateMany({
      where: { userId, balance: { gte: allocation.cost } },
      data: { balance: { decrement: allocation.cost } },
    });
    if (debited.count === 0) return false;
    // 중복 키는 예외로 턴 전체를 롤백한다. PENDING 입력만 이 경로에 들어온다.
    await this.tx.heritageEntry.create({
      data: {
        userId,
        worldId,
        key: `spend:${worldId}:${sequence}`,
        kind: 'CREATION_SPEND',
        delta: -allocation.cost,
        detail: JSON.parse(JSON.stringify(allocation)) as Prisma.InputJsonObject,
      },
    });
    return true;
  }

  async creationSpends(worldId: string) {
    const rows = await this.tx.heritageEntry.findMany({
      where: { worldId, kind: 'CREATION_SPEND' },
      select: { userId: true, key: true, delta: true },
    });
    return rows.map((row) => ({ ...row, sequence: Number(row.key.slice(`spend:${worldId}:`.length)) }));
  }

  async refundKeys(worldId: string) {
    const rows = await this.tx.heritageEntry.findMany({
      where: { worldId, kind: { in: ['CREATION_REFUND', 'FORFEIT'] } },
      select: { key: true },
    });
    return new Set(rows.map((row) => row.key));
  }
}
