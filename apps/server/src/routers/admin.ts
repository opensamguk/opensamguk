import { z } from 'zod';
import { adminProcedure } from '../admin/role';
import { router } from '../trpc';

export const adminRouter = router({
  whoami: adminProcedure.input(z.void()).query(() => ({ admin: true as const })),
});
