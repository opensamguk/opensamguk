import { TRPCError } from '@trpc/server';
import { formatResourceKey } from '@opensamguk/rules';
import { z } from 'zod';
import type { Context } from '../context';
import { listInput, listResources } from '../resourceAdmin/read';
import { RESOURCE_PAYLOAD_LIMITS } from '../resourceAdmin/payload';
import { requireCurrentAdmin } from './access';
import { artifactMapVersion } from './worldCreateOptions';

export const creationVersionsInput = z.strictObject({
  expectedUserId: z.uuid(),
  kind: listInput.shape.kind.unwrap(),
  cursor: listInput.shape.cursor,
});

export async function getWorldCreationVersions(ctx: Context, input: z.infer<typeof creationVersionsInput>) {
  if (!ctx.user || ctx.user.id !== input.expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
  ctx.reply.header('Cache-Control', 'no-store');
  try {
    return await ctx.db.$transaction(
      async (tx) => {
        await requireCurrentAdmin(tx, ctx, false);
        if (input.kind === 'MAP') {
          const map = await tx.gameResource.findFirst({
            where: artifactMapVersion,
            select: { name: true, version: true, contentHash: true },
          });
          if (map) return { items: [{ ...map, key: formatResourceKey(map) }], next: null };
        }
        const page = await listResources(
          tx,
          { kind: input.kind, status: 'PUBLISHED', cursor: input.cursor },
          RESOURCE_PAYLOAD_LIMITS,
        );
        return {
          items: page.items.map(({ name, version, contentHash }) => ({
            key: formatResourceKey({ name, version }),
            name,
            version,
            contentHash,
          })),
          next: page.next,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '게시된 생성 자원을 확인하지 못했습니다.' });
  }
}
