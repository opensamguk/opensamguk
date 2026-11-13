import { changeTroop, readTroops, troopActionSchema } from '@opensamguk/rules';
import type { QueuedInputHandler } from './features';
import { databaseNow } from './lease';
import { loadReplayState } from './monthly';
import { persistExt } from './extState';

export const processTroopInput: QueuedInputHandler = async (tx, world, event) => {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status !== 'RUNNING') return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
  const action = troopActionSchema.safeParse(event.payload);
  if (!action.success) return reject('BAD_ACTION', '부대 변경 요청을 확인하세요.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  if (user?.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
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
  const { state } = await loadReplayState(tx, world.id);
  const general = state.generals[event.generalId];
  if (general?.userId !== event.userId) return reject('NO_GENERAL', '내 장수가 아닙니다.');
  const troops = readTroops(state);
  if (!troops) return reject('NOT_ENABLED', '이 월드에서 부대 기능을 켜지 않았습니다.');
  const changed = changeTroop(state, troops, general.id, action.data);
  if (!changed.ok) return reject(changed.code, changed.message);
  await persistExt(tx, world.id, state.ext, { ...state.ext, troop: changed.slice });
  return { status: 'APPLIED', result: { changed: changed.changed } };
};
