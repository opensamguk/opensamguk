import type { Prisma, PrismaClient } from '@opensamguk/db';
import { governanceMovementSchema } from '@opensamguk/rules';
import { activeSanctionWhere } from '../auth/sanction';
import { readView } from '../game/queries';
import type {
  GovernanceAdmission,
  GovernanceIdentity,
  GovernanceLedgerScope,
  GovernanceSnapshot,
  GovernanceStore,
} from './ports';

const emptySnapshot = (authenticated: boolean): GovernanceSnapshot => ({
  authenticated,
  sanctioned: false,
  world: null,
  state: null,
  previous: null,
  movements: [],
});

export class PgGovernanceStore implements GovernanceStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date,
  ) {}
  private async authenticated(tx: Prisma.TransactionClient, identity: GovernanceIdentity) {
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
    identity: GovernanceIdentity,
    worldId: string,
    options: { write?: boolean; requestId?: string; state?: boolean },
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
              idempotencyKey: `governance:${options.requestId}`,
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
    return {
      authenticated: true,
      sanctioned: sanctioned !== null,
      world,
      previous,
      state: options.state ? await readView(tx, worldId) : null,
      movements: [],
    } satisfies GovernanceSnapshot;
  }
  read(identity: GovernanceIdentity, worldId: string, select: (snapshot: GovernanceSnapshot) => GovernanceLedgerScope) {
    return this.db.$transaction(
      async (tx): Promise<GovernanceSnapshot> => {
        const snapshot = await this.snapshot(tx, identity, worldId, { state: true }),
          scope = select(snapshot);
        const allowed: Prisma.GovernanceMovementWhereInput[] = [];
        if (scope.monarchNationId !== null)
          allowed.push(
            { kind: 'TRIBUTE', OR: [{ fromNationId: scope.monarchNationId }, { toNationId: scope.monarchNationId }] },
            { kind: 'STIPEND', fromNationId: scope.monarchNationId },
          );
        if (scope.generalId !== null)
          allowed.push({ kind: 'STIPEND', holder: 'general', holderId: scope.generalId, delta: { gt: 0 } });
        const rows = allowed.length
          ? await tx.governanceMovement.findMany({
              where: { worldId, OR: allowed },
              orderBy: [{ sequence: 'desc' }, { ordinal: 'asc' }],
              take: 50,
            })
          : [];
        return {
          ...snapshot,
          movements: rows.map(({ tick, sequence, ordinal, ...row }) => ({
            ...governanceMovementSchema.parse({
              kind: row.kind,
              refId: row.refId,
              holder: row.holder,
              holderId: row.holderId,
              resource: row.resource,
              delta: row.delta,
              fromNationId: row.fromNationId,
              toNationId: row.toNationId,
            }),
            tick,
            sequence,
            ordinal,
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  request(identity: GovernanceIdentity, worldId: string, requestId: string) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { requestId }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  submit(
    identity: GovernanceIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: GovernanceSnapshot) => GovernanceAdmission,
  ) {
    return this.db.$transaction(async (tx) => {
      const snapshot = await this.snapshot(tx, identity, worldId, { write: true, requestId, state: true });
      const decision = decide(snapshot);
      if (!decision.enqueue) {
        if (!snapshot.previous) throw new Error('재전송할 황실 요청이 없습니다.');
        return snapshot.previous;
      }
      const event = await tx.inputEvent.create({
        data: {
          worldId,
          userId: identity.userId,
          generalId: decision.generalId,
          kind: 'governance.act',
          idempotencyKey: `governance:${requestId}`,
          payload: decision.payload,
          status: 'PENDING',
        },
      });
      await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
        VALUES (${worldId},${identity.userId},${decision.generalId},'general.active',${`general.active:governance:${requestId}`},'{}'::jsonb,'PENDING')
        ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
      return event;
    });
  }
}
