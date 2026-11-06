import { adminProcedure } from '../admin/role';
import { router } from '../trpc';
import { requireResourceEditor } from '../resourceAdmin/access';
import { listInput } from '../resourceAdmin/read';
import {
  cloneResource,
  cloneResourceInput,
  getResourceCatalog,
  getResourceInput,
  listResourceCatalog,
  publishResource,
  publishResourceInput,
  saveResource,
  saveResourceInput,
} from '../resourceAdmin/store';

const resourceProcedure = adminProcedure.use(async ({ ctx, next }) => {
  // 권한 거부는 입력 파싱보다 먼저이며 저장소는 실제 작업 트랜잭션에서 다시 검사한다.
  await ctx.db.$transaction((tx) => requireResourceEditor(tx, ctx, false));
  return next();
});

export const resourceAdminRouter = router({
  list: resourceProcedure.input(listInput).query(({ ctx, input }) => listResourceCatalog(ctx, input)),
  get: resourceProcedure.input(getResourceInput).query(({ ctx, input }) => getResourceCatalog(ctx, input)),
  clone: resourceProcedure.input(cloneResourceInput).mutation(({ ctx, input }) => cloneResource(ctx, input)),
  save: resourceProcedure.input(saveResourceInput).mutation(({ ctx, input }) => saveResource(ctx, input)),
  publish: resourceProcedure.input(publishResourceInput).mutation(({ ctx, input }) => publishResource(ctx, input)),
});
