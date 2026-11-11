import { INTEL_FEATURE, getIntelSliceSchema, nowTick, unitSetSchema } from '@opensamguk/rules';
import { requireGeneral, requireWorld } from '../game/queries';
import { requireIntelReader } from '../game/fog';
import { intelPolicy } from '../intelPolicy';
import { worldClock, worldInput } from '../queries';
import { router, worldVerifiedProcedure } from '../trpc';
import { intelRecordInfo } from '../visibility';

export const intelRouter = router({
  records: worldVerifiedProcedure.input(worldInput).query(({ ctx, input }) => {
    const started = performance.now();
    return ctx.db.$transaction(
      async (tx) => {
        await requireIntelReader(tx, ctx, input.worldId, started);
        const world = await requireWorld(tx, input.worldId);
        const general = await requireGeneral(tx, world.id, ctx.user.id);
        if (world.replayFormat !== 3 || !world.ruleFeatures.includes(INTEL_FEATURE))
          return { enabled: false, items: [] };
        if (general.nationId === null || general.removedAt !== null) return { enabled: true, items: [], alerts: [] };
        const row = await tx.worldExtSlice.findUnique({
          where: { worldId_key: { worldId: world.id, key: 'intel' } },
          select: { value: true },
        });
        const records = getIntelSliceSchema().safeParse(row?.value);
        if (!records.success) throw new Error('첩보 기록을 읽을 수 없습니다.');
        const context = {
          startYear: world.startYear,
          tick: nowTick(worldClock(world), ctx.now),
          unitSet: unitSetSchema.parse(world.unitSet),
        };
        const items = Object.entries(records.data[String(general.nationId)] ?? {})
          .map(([cityKey, record]) => intelRecordInfo(Number(cityKey), record, context, intelPolicy))
          .filter((record) => record !== null)
          .sort((a, b) => b.tick - a.tick || a.cityKey - b.cityKey);
        const alerts = await tx.$queryRaw<{ tick: number; text: string }[]>`
          SELECT history."tick", alert."text"
          FROM "NationHistory" AS history
          CROSS JOIN LATERAL jsonb_array_elements_text(history."data"->'intelAlerts')
            WITH ORDINALITY AS alert("text", "position")
          WHERE history."worldId" = ${world.id} AND history."nationId" = ${general.nationId}
          ORDER BY history."tick" DESC, alert."position" DESC
          LIMIT 30
        `;
        return { enabled: true, items, alerts };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }),
});
