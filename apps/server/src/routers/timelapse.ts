import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { page, readWorld, recordsInput } from '../queries';
import {
  publicNationDisplaySelect,
  publicTimelapseCityInfo,
  publicTimelapseCitySelect,
  timelapseFrameInfo,
} from '../visibility';

async function readFrameRows(tx: Prisma.TransactionClient, worldId: string, cursor: string | undefined) {
  const history = await tx.yearbookSnapshot.findMany({
    where: {
      worldId,
      ...(cursor === undefined ? {} : { tick: { gt: Number(cursor) } }),
    },
    orderBy: { tick: 'asc' },
    take: 31,
    select: { tick: true, year: true, month: true, data: true },
  });
  // 다음 페이지 확인용 31번째 행은 파싱하지 않는다.
  const result = page(history);
  const items = result.items.map((row) => ({
    tick: row.tick,
    year: row.year,
    month: row.month,
    ...timelapseFrameInfo(row.data),
  }));
  const nationIds = [
    ...new Set(items.flatMap((frame) => frame.cities.flatMap(({ nationId }) => (nationId === null ? [] : [nationId])))),
  ];
  return { items, nationIds, nextCursor: result.nextCursor };
}

async function attachSavedNations(
  tx: Prisma.TransactionClient,
  worldId: string,
  items: Awaited<ReturnType<typeof readFrameRows>>['items'],
  nationIds: number[],
) {
  const savedNations =
    items.length === 0 || nationIds.length === 0
      ? []
      : await tx.yearbookNation.findMany({
          where: {
            worldId,
            tick: { in: items.map(({ tick }) => tick) },
            nationId: { in: nationIds },
          },
          orderBy: [{ tick: 'asc' }, { nationId: 'asc' }],
          select: { tick: true, nationId: true, name: true, color: true },
        });
  return items.map((frame) => {
    const owners = new Set(frame.cities.map(({ nationId }) => nationId));
    return {
      ...frame,
      nations: savedNations
        .filter(({ tick, nationId }) => tick === frame.tick && owners.has(nationId))
        .map(({ nationId, name, color }) => ({ id: nationId, name, color })),
    };
  });
}

export const timelapseRouter = router({
  frames: protectedProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const { items, nationIds, nextCursor } = await readFrameRows(tx, input.worldId, input.cursor);
      const currentNations =
        nationIds.length === 0
          ? []
          : await tx.nation.findMany({
              where: { worldId: input.worldId, id: { in: nationIds } },
              orderBy: { id: 'asc' },
              select: publicNationDisplaySelect,
            });
      return {
        items: await attachSavedNations(tx, input.worldId, items, nationIds),
        currentNations,
        nextCursor,
      };
    }),
  ),
  publicFrames: publicProcedure.input(recordsInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      if (world.status !== 'ENDED') {
        throw new TRPCError({ code: 'FORBIDDEN', message: '종료된 월드만 로그인 없이 볼 수 있습니다.' });
      }
      if (world.result === null) throw new Error('종료된 월드의 결과가 없습니다.');
      const { endedYear, endedMonth } = world.result;
      const map =
        input.cursor === undefined
          ? {
              cities: (
                await tx.city.findMany({
                  where: { worldId: input.worldId },
                  orderBy: { cityKey: 'asc' },
                  select: publicTimelapseCitySelect,
                })
              ).map(publicTimelapseCityInfo),
            }
          : null;
      const { items, nationIds, nextCursor } = await readFrameRows(tx, input.worldId, input.cursor);
      return {
        world: { name: world.name, endedYear, endedMonth },
        map,
        items: await attachSavedNations(tx, input.worldId, items, nationIds),
        nextCursor,
      };
    }),
  ),
});
