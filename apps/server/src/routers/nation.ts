import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldInput } from '../queries';
import { generalInfo, mapCity, nationInfo } from '../visibility';

export const nationRouter = router({
  get: protectedProcedure.input(worldInput.extend({ nationId: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx) => {
      const viewer = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const nation = await tx.nation.findUnique({
        where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
      });
      if (!nation) throw new TRPCError({ code: 'NOT_FOUND', message: '국가를 찾을 수 없습니다.' });
      const cities = await tx.city.findMany({ where: input, orderBy: { cityKey: 'asc' } });
      const generals = await tx.general.findMany({ where: input, orderBy: { id: 'asc' } });
      return {
        ...nationInfo(nation, { cityCount: cities.length, generalCount: generals.length }, viewer),
        cities: cities.map(mapCity),
        generals: generals.map((general) => generalInfo(general, viewer)),
      };
    }),
  ),
});
