import { protectedProcedure, router } from '../trpc';
import { worldInput } from '../game/queries';
import { readEquipmentBoard } from '../game/equipmentApi';

export const equipmentRouter = router({
  mine: protectedProcedure.input(worldInput).query(({ ctx, input }) => readEquipmentBoard(ctx, input.worldId)),
});
