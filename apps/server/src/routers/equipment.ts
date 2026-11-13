import { protectedProcedure, router } from '../trpc';
import { worldInput } from '../game/queries';
import { readEquipmentBoard, readRareEquipment } from '../game/equipmentApi';

export const equipmentRouter = router({
  rare: protectedProcedure.input(worldInput).query(({ ctx, input }) => readRareEquipment(ctx.db, input.worldId)),
  mine: protectedProcedure.input(worldInput).query(({ ctx, input }) => readEquipmentBoard(ctx, input.worldId)),
});
