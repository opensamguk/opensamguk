import type { Prisma, PrismaClient } from '@opensamguk/db';
import { logisticsMovementSchema } from '@opensamguk/rules';
import { activeSanctionWhere } from '../auth/sanction';
import { readView } from '../game/queries';
import type { LogisticsAdmission, LogisticsIdentity, LogisticsSnapshot, LogisticsStore } from './ports';

const emptySnapshot = (authenticated: boolean): LogisticsSnapshot => ({
  authenticated,
  sanctioned: false,
  world: null,
  state: null,
  previous: null,
  movements: [],
});

export class PgLogisticsStore implements LogisticsStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date,
  ) {}

  private async authenticated(tx: Prisma.TransactionClient, identity: LogisticsIdentity) {
    const at = this.now();
    if (!identity.userId || !identity.sessionId || !Number.isFinite(at.getTime())) return false;
    return (
      (await tx.session.findFirst({
        where: {
          id: identity.sessionId,
          userId: identity.userId,
          expiresAt: { gt: at },
          user: { status: 'ACTIVE', sanctions: { none: { worldId: null, ...activeSanctionWhere(at.getTime()) } } },
        },
        select: { id: true },
      })) !== null
    );
  }

  private async snapshot(
    tx: Prisma.TransactionClient,
    identity: LogisticsIdentity,
    worldId: string,
    options: { write?: boolean; requestId?: string; cityKey?: number; state?: boolean },
  ) {
    if (!(await this.authenticated(tx, identity))) return emptySnapshot(false);
    if (options.write) {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      if (!(await this.authenticated(tx, identity))) return emptySnapshot(false);
    }
    const world = await tx.world.findUnique({ where: { id: worldId } });
    if (!world) return emptySnapshot(true);
    const previous = options.requestId
      ? await tx.inputEvent.findUnique({
          where: {
            worldId_userId_idempotencyKey: {
              worldId,
              userId: identity.userId,
              idempotencyKey: `logistics:${options.requestId}`,
            },
          },
        })
      : null;
    const sanctioned = await tx.sanction.findFirst({
      where: {
        userId: identity.userId,
        AND: [{ OR: [{ worldId: null }, { worldId }] }, activeSanctionWhere(this.now().getTime())],
      },
      select: { id: true },
    });
    const state = options.state ? await readView(tx, worldId) : null;
    const rows =
      options.cityKey !== undefined
        ? await tx.logisticsMovement.findMany({
            where: { worldId, holder: 'city', holderId: options.cityKey },
            orderBy: [{ sequence: 'desc' }, { ordinal: 'asc' }],
            take: 50,
          })
        : [];
    return {
      authenticated: true,
      sanctioned: sanctioned !== null,
      world,
      previous,
      state,
      movements: rows.map(({ holderId, tick, sequence, ordinal, ...row }) => ({
        ...logisticsMovementSchema.parse({
          holder: row.holder,
          id: holderId,
          good: row.good,
          delta: row.delta,
          reason: row.reason,
        }),
        tick,
        sequence,
        ordinal,
      })),
    };
  }

  read(identity: LogisticsIdentity, worldId: string, cityKey: number) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { cityKey, state: true }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  request(identity: LogisticsIdentity, worldId: string, requestId: string) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { requestId }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  submit(
    identity: LogisticsIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: LogisticsSnapshot) => LogisticsAdmission,
  ) {
    return this.db.$transaction(async (tx) => {
      const snapshot = await this.snapshot(tx, identity, worldId, { write: true, requestId, state: true });
      const decision = decide(snapshot);
      if (!decision.enqueue) {
        if (!snapshot.previous) throw new Error('재전송할 물류 요청이 없습니다.');
        return snapshot.previous;
      }
      const event = await tx.inputEvent.create({
        data: {
          worldId,
          userId: identity.userId,
          generalId: decision.generalId,
          kind: 'logistics.order',
          idempotencyKey: `logistics:${requestId}`,
          payload: decision.payload,
          status: 'PENDING',
        },
      });
      await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
        VALUES (${worldId},${identity.userId},${decision.generalId},'general.active',${`general.active:logistics:${requestId}`},'{}'::jsonb,'PENDING')
        ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
      return event;
    });
  }
}
