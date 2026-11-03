import type { Prisma, PrismaClient } from '@opensamguk/db';
import { pendingAssignmentsFromRows } from '@opensamguk/rules';
import { activeSanctionWhere } from '../auth/sanction';
import { readView } from '../game/queries';
import type { LineageAdmission, LineageIdentity, LineageSnapshot, LineageStore } from './ports';

const emptySnapshot = (authenticated: boolean): LineageSnapshot => ({
  authenticated,
  sanctioned: false,
  world: null,
  state: null,
  previous: null,
});

export class PgLineageStore implements LineageStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date,
  ) {}
  private async authenticated(tx: Prisma.TransactionClient, identity: LineageIdentity) {
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
    identity: LineageIdentity,
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
              idempotencyKey: `lineage:${options.requestId}`,
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
    if (state?.ruleFeatures?.includes('personnel'))
      Object.assign(
        state,
        pendingAssignmentsFromRows(
          await tx.assignmentOffer.findMany({
            where: { worldId, status: 'PENDING' },
            orderBy: [{ targetGeneralId: 'asc' }, { id: 'asc' }],
          }),
          worldId,
        ),
      );
    return {
      authenticated: true,
      sanctioned: sanctioned !== null,
      world,
      previous,
      state,
    } satisfies LineageSnapshot;
  }
  read(identity: LineageIdentity, worldId: string) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { state: true }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  request(identity: LineageIdentity, worldId: string, requestId: string) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { requestId }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  submit(
    identity: LineageIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: LineageSnapshot) => LineageAdmission,
  ) {
    return this.db.$transaction(async (tx) => {
      const snapshot = await this.snapshot(tx, identity, worldId, { write: true, requestId, state: true });
      const decision = decide(snapshot);
      if (!decision.enqueue) {
        if (!snapshot.previous) throw new Error('재전송할 가문 요청이 없습니다.');
        return snapshot.previous;
      }
      const event = await tx.inputEvent.create({
        data: {
          worldId,
          userId: identity.userId,
          generalId: decision.generalId,
          kind: 'lineage.act',
          idempotencyKey: `lineage:${requestId}`,
          payload: decision.payload,
          status: 'PENDING',
        },
      });
      await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
        VALUES (${worldId},${identity.userId},${decision.generalId},'general.active',${`general.active:lineage:${requestId}`},'{}'::jsonb,'PENDING')
        ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
      return event;
    });
  }
}
