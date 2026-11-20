import type { PrismaClient } from '@opensamguk/db';
// eslint-disable-next-line opensamguk/no-cross-package-relative -- 공식 생성 경로로 조회용 고정물을 저장한다.
import { monthlyFixture } from '../../engine/test/monthlyFixture';
// eslint-disable-next-line opensamguk/no-cross-package-relative -- 공식 생성 경로로 조회용 고정물을 저장한다.
import { prepareInitialWorld, savePreparedInitialWorld } from '../../engine/src/world/persistence';

export async function saveTestWorld(
  db: PrismaClient,
  data: { name: string; status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED'; id?: string; createdAt?: Date },
) {
  const prepared = prepareInitialWorld(await monthlyFixture(), {
    name: data.name,
    turnTermMinutes: 1,
    endYear: null,
  });
  const { worldId } = await db.$transaction((tx) => savePreparedInitialWorld(tx, prepared, data.id));
  return db.world.update({
    where: { id: worldId },
    data: { status: data.status, ...(data.createdAt ? { createdAt: data.createdAt } : {}) },
    select: { id: true, name: true, status: true },
  });
}
