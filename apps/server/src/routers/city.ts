import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldClock, worldInput } from '../queries';
import { cityInfo, commandedTroops, garrisonGeneralInfo, visibility } from '../visibility';
import { readView } from '../game/queries';
import {
  cityRegionName,
  LINEAGE_EXITED_YEAR,
  toGameDate,
  isOfficeResident,
  readOperationalMap,
  nowTick,
} from '@opensamguk/rules';
import { readCityScaleProjection } from '../game/cityScale';
import { readCityIntel } from '../game/fog';
import { cityDefense } from '../game/defenseRead';

export const cityRouter = router({
  get: protectedProcedure.input(worldInput.extend({ cityKey: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const fogEnabled = world.fogOfWar;
      const general = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const viewer = fogEnabled && general?.removedAt != null ? null : general;
      const city = await tx.city.findUnique({
        where: { worldId_cityKey: input },
        include: { world: { select: { mapKey: true, operationalMap: true } } },
      });
      if (!city) throw new TRPCError({ code: 'NOT_FOUND', message: '도시를 찾을 수 없습니다.' });
      const garrisonHidden = fogEnabled && city.nationId !== null && viewer?.nationId !== city.nationId;
      const generals = garrisonHidden
        ? []
        : await tx.general.findMany({
            where: {
              worldId: input.worldId,
              cityKey: input.cityKey,
              removedAt: null,
              activeFromYear: { not: LINEAGE_EXITED_YEAR },
            },
            orderBy: { id: 'asc' },
          });
      const activeViewer = viewer?.removedAt == null ? viewer : null;
      const nationId = activeViewer?.nationId;
      const alliedResidence =
        !garrisonHidden &&
        nationId != null &&
        activeViewer !== null &&
        activeViewer.officerLevel > 0 &&
        generals.some((resident) => resident.nationId === nationId);
      const full = alliedResidence || visibility(activeViewer).city(city);
      const adjacent =
        !garrisonHidden &&
        !full &&
        nationId != null &&
        city.connections.length > 0 &&
        (await tx.city.count({
          where: { worldId: input.worldId, nationId, cityKey: { in: city.connections } },
        })) > 0;
      const view = !garrisonHidden ? await readView(tx, input.worldId) : undefined;
      const units = view?.campaign?.units;
      const ruins = await readCityScaleProjection(tx, input.worldId);
      const intel =
        fogEnabled && viewer?.nationId != null && !visibility(viewer).city(city)
          ? await readCityIntel(tx, world, viewer.nationId, city.cityKey, ctx)
          : null;

      const officers =
        !garrisonHidden && city.nationId !== null && city.kind !== 'PASS' && city.kind !== 'FIELD'
          ? await tx.general.findMany({
              where: {
                worldId: input.worldId,
                nationId: city.nationId,
                removedAt: null,
                activeFromYear: { lte: toGameDate(world.startYear, world.clockTick).year },
                OR: [{ officerCityKey: city.cityKey }, { cityKey: city.cityKey, officerLevel: { gte: 5, lte: 11 } }],
              },
              orderBy: [{ officerLevel: 'desc' }, { id: 'asc' }],
              select: {
                id: true,
                name: true,
                nationId: true,
                officerLevel: true,
                officerCityKey: true,
                cityKey: true,
                userId: true,
                portraitId: true,
              },
            })
          : [];
      return {
        ...{
          ...(!garrisonHidden
            ? {
                officers: officers.map((officer) => ({
                  generalId: officer.id,
                  name: officer.name,
                  officerLevel: officer.officerLevel,
                  isHuman: officer.userId !== null,
                  portraitId: officer.portraitId,
                  resident: isOfficeResident(officer, city.nationId),
                })),
              }
            : {}),
        },
        ...cityInfo(city, activeViewer, alliedResidence, !fogEnabled || visibility(activeViewer).city(city)),
        ...(!garrisonHidden && city.nationId !== null && city.nationId === activeViewer?.nationId
          ? { defense: cityDefense(city, generals, world.startYear, nowTick(worldClock(world), ctx.now), view) }
          : {}),
        region: city.region,
        regionName: cityRegionName(
          city.region,
          city.world.mapKey,
          readOperationalMap(city.world.operationalMap)?.regionScheme,
        ),
        ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}),

        ...(fogEnabled ? { fog: { intel, garrisonHidden } } : {}),
        ...(full && !garrisonHidden && nationId != null
          ? {
              enemyCrew: generals
                .filter((resident) => resident.nationId !== null && resident.nationId !== nationId)
                .reduce((sum, resident) => sum + commandedTroops(resident, units), 0),
            }
          : {}),
        generals: generals.map((resident) =>
          garrisonGeneralInfo(resident, activeViewer, units, {
            stats: !garrisonHidden && (full || adjacent),
            troops: !garrisonHidden && full,
          }),
        ),
      };
    }),
  ),
});
