import type { Prisma, PrismaClient } from '@opensamguk/db';
import { activeSanctionWhere } from '../auth/sanction';
import { readView } from '../game/queries';
import type {
  StratagemCardsAdmission,
  StratagemCardsIdentity,
  StratagemCardsSnapshot,
  StratagemCardsStore,
} from './ports';

const emptySnapshot = (authenticated: boolean): StratagemCardsSnapshot => ({
  authenticated,
  sanctioned: false,
  world: null,
  state: null,
  previous: null,
});

export class PgStratagemCardsStore implements StratagemCardsStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date,
  ) {}
  private async authenticated(tx: Prisma.TransactionClient, identity: StratagemCardsIdentity) {
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
    identity: StratagemCardsIdentity,
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
              idempotencyKey: `stratagem-cards:${options.requestId}`,
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
    const state =
      options.state && world.ruleFeatures.includes('stratagem-cards-v1') ? await readView(tx, worldId) : null;
    return {
      authenticated: true,
      sanctioned: sanctioned !== null,
      world,
      previous,
      state,
    } satisfies StratagemCardsSnapshot;
  }
  read(identity: StratagemCardsIdentity, worldId: string) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { state: true }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  request(identity: StratagemCardsIdentity, worldId: string, requestId: string) {
    return this.db.$transaction((tx) => this.snapshot(tx, identity, worldId, { requestId }), {
      isolationLevel: 'RepeatableRead',
    });
  }
  submit(
    identity: StratagemCardsIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: StratagemCardsSnapshot) => StratagemCardsAdmission,
  ) {
    return this.db.$transaction(async (tx) => {
      const snapshot = await this.snapshot(tx, identity, worldId, { write: true, requestId, state: true });
      const decision = decide(snapshot);
      if (!decision.enqueue) {
        if (!snapshot.previous) throw new Error('재전송할 계략 패 요청이 없습니다.');
        return snapshot.previous;
      }
      const event = await tx.inputEvent.create({
        data: {
          worldId,
          userId: identity.userId,
          generalId: decision.generalId,
          kind: 'stratagem-cards.act',
          idempotencyKey: `stratagem-cards:${requestId}`,
          payload: decision.payload,
          status: 'PENDING',
        },
      });
      if (snapshot.world!.ruleFeatures.includes('policy'))
        await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
        VALUES (${worldId},${identity.userId},${decision.generalId},'general.active',${`general.active:stratagem-cards:${requestId}`},'{}'::jsonb,'PENDING')
        ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
      return event;
    });
  }
}
