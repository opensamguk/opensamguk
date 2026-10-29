import type { Prisma } from '@opensamguk/db';
import { applyCityResourceInput } from '@opensamguk/rules';
import type { QueuedInputHandler } from './features';
import { databaseNow } from './lease';
import { loadReplayState } from './monthly';
import { persistEffects } from './persist';

// 입력 처리기가 확보한 리스·World 잠금과 같은 트랜잭션을 쓴다.
export const processCityResourceInput: QueuedInputHandler = async (tx, world, event, { tick, sequence }) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (event.kind !== 'city.resources') throw new Error('도시 자원 입력 종류를 확인하세요.');
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (!user || user.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  const now = await databaseNow(tx);
  const sanction = await tx.sanction.findFirst({
    where: {
      userId: event.userId,
      AND: [
        { OR: [{ worldId: null }, { worldId: world.id }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
      liftedAt: null,
    },
    select: { id: true },
  });
  if (sanction) return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  if (event.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${world.id} AND id = ${event.generalId} FOR UPDATE`;
  const before = await loadReplayState(tx, world.id);
  const outcome = applyCityResourceInput(before.state, event.payload, event.generalId, {
    tick,
    userId: event.userId,
    userActive: true,
    armyTypes: before.campaignArmyTypes!,
  });
  if (!outcome.ok) return reject(outcome.code, outcome.message);
  await persistEffects(
    tx,
    world.id,
    outcome.state,
    [{ kind: 'world', state: outcome.state }],
    { tick, sequence },
    before.state,
  );
  return { status: 'APPLIED', result: outcome.result as Prisma.InputJsonValue };
};
