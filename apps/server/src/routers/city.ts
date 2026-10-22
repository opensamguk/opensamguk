import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldInput } from '../queries';
import { cityInfo, generalInfo } from '../visibility';

export const cityRouter = router({
  get: protectedProcedure.input(worldInput.extend({ cityKey: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const viewer = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const city = await tx.city.findUnique({ where: { worldId_cityKey: input } });
      if (!city) throw new TRPCError({ code: 'NOT_FOUND', message: '도시를 찾을 수 없습니다.' });
      const generals = await tx.general.findMany({
        where: { worldId: input.worldId, cityKey: input.cityKey },
        orderBy: { id: 'asc' },
      });
      return { ...cityInfo(city, viewer), generals: generals.map((general) => generalInfo(general, viewer)) };
    }),
  ),
});
