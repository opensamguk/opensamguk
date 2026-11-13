import { protectedProcedure, router } from '../trpc';
import { nextTurnAt, turnSchedule, readWorld, requireGeneral, worldClock, worldInput } from '../queries';
import { cityInfo, ownGeneralInfo, logInfo, logSelect, nationInfo } from '../visibility';
import {
  GENERAL_CONDITION_FEATURE,
  INACTIVE_REMOVAL_FEATURE,
  inactiveRemovalTick,
  DEFENSE_STANCES,
  DEFENSE_STANCE_FEATURE,
  DEFENSE_STANCE_KIND,
  defenseRequirements,
  defenseStanceInput,
  generalCondition,
  LINEAGE_EXITED_YEAR,
  nowTick,
  OFFICE_EFFECTS_FEATURE,
  PLAYER_AUTOPLAY_FEATURE,
  playerAutoplayWindow,
  TICKS_PER_MONTH,
  policyOptions,
  toGameDate,
} from '@opensamguk/rules';
import { displaySlots, readSlots } from '../game/slots';
import { readCityScaleProjection } from '../game/cityScale';
import { nationPopulation, projectNationFinance, salaryRate } from '../game/nationFinance';
import { readView } from '../game/queries';
import { cityDefense } from '../game/defenseRead';

export const homeRouter = router({
  get: protectedProcedure.input(worldInput).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const city = await tx.city.findUniqueOrThrow({
        where: { worldId_cityKey: { worldId: input.worldId, cityKey: general.cityKey } },
      });
      const nation =
        general.nationId === null
          ? null
          : await tx.nation.findUniqueOrThrow({
              where: { worldId_id: { worldId: input.worldId, id: general.nationId } },
              include: {
                cities: {
                  where: { OR: [{ kind: null }, { kind: 'CITY' }] },
                  orderBy: { cityKey: 'asc' },
                  select: { cityKey: true, commerce: true, agriculture: true, population: true, populationMax: true },
                },
                generals: { select: { activeFromYear: true, removedAt: true } },
              },
            });
      const state =
        world.ruleFeatures.includes('campaign-v1') ||
        (nation && world.status !== 'ENDED' && world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE))
          ? await readView(tx, input.worldId)
          : undefined;
      const finance =
        nation && world.status !== 'ENDED'
          ? projectNationFinance(world, ctx.now, nation.cities, nation.generals, state, nation.philosophy)
          : undefined;
      const turns = displaySlots(await readSlots(tx, input.worldId, general.id));
      const tick = nowTick(worldClock(world), ctx.now);
      const autoplay =
        world.ruleFeatures.includes(PLAYER_AUTOPLAY_FEATURE) &&
        general.lastActiveTick !== null &&
        world.status !== 'ENDED'
          ? playerAutoplayWindow(general.lastActiveTick, world.turnTermMinutes)
          : null;
      const stanceEnabled = world.ruleFeatures.includes(DEFENSE_STANCE_FEATURE);
      const limits = defenseRequirements(stanceEnabled, general.defenseThreshold);
      const pendingDefense = stanceEnabled
        ? await tx.inputEvent.findFirst({
            where: { worldId: input.worldId, generalId: general.id, kind: DEFENSE_STANCE_KIND, status: 'PENDING' },
            select: { payload: true },
          })
        : null;
      const defense = cityDefense(
        city,
        general.removedAt === null ? [general] : [],
        world.startYear,
        tick,
        state,
        stanceEnabled,
      );
      const defendingTroops =
        general.removedAt === null
          ? (defense.generals.find(({ generalId }) => generalId === general.id)?.troops ?? 0)
          : 0;
      const ruins = await readCityScaleProjection(tx, input.worldId, world.ruleFeatures);
      const logs = await tx.generalLog.findMany({
        where: { worldId: input.worldId, generalId: general.id },
        orderBy: [{ tick: 'desc' }, { id: 'desc' }],
        take: 10,
        select: logSelect,
      });
      const sessions = ctx.connectedSessions?.(input.worldId) ?? [];
      const battle = await tx.generalBattleStats.findUnique({
        where: { worldId_generalId: { worldId: input.worldId, generalId: general.id } },
      });
      const connected =
        sessions.length === 0
          ? []
          : await tx.general.findMany({
              where: {
                worldId: input.worldId,
                removedAt: null,
                activeFromYear: { not: LINEAGE_EXITED_YEAR },
                user: {
                  status: 'ACTIVE',
                  sessions: { some: { id: { in: [...sessions] }, expiresAt: { gt: new Date(ctx.now) } } },
                },
              },
              select: { id: true, name: true, nationId: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
            });
      return {
        general: {
          ...ownGeneralInfo(general),
          battleStats:
            battle === null
              ? null
              : {
                  engagements: battle.engagements,
                  wins: battle.wins,
                  losses: battle.losses,
                  kills: String(battle.kills),
                  casualties: String(battle.casualties),
                  winRate: battle.wins / battle.engagements,
                  killRate: battle.casualties === 0n ? null : Number(battle.kills) / Number(battle.casualties),
                  lastBattle: toGameDate(world.startYear, battle.lastTick),
                },
          ...(world.ruleFeatures.includes(GENERAL_CONDITION_FEATURE)
            ? { condition: generalCondition(general, nation?.level ?? 0) }
            : {}),
          defense: {
            participating: defendingTroops > 0,
            troops: defendingTroops,
            minimumTraining: limits.minimumTraining,
            minimumMorale: limits.minimumMorale,
            ...(stanceEnabled
              ? {
                  stance: {
                    enabled: limits.enabled,
                    options: DEFENSE_STANCES,
                    editable: world.status !== 'ENDED' && general.removedAt === null,
                    pendingThreshold: pendingDefense
                      ? defenseStanceInput.parse(pendingDefense.payload).threshold
                      : null,
                  },
                }
              : {}),
          },
          ...(finance
            ? {
                salaryEstimate: {
                  gold:
                    general.activeFromYear <= finance.financeEstimate.gold.year
                      ? finance.financeEstimate.gold.perGeneral
                      : 0,
                  rice:
                    general.activeFromYear <= finance.financeEstimate.rice.year
                      ? finance.financeEstimate.rice.perGeneral
                      : 0,
                },
              }
            : {}),
          policy: (() => {
            const option = policyOptions().find((entry) => entry.key === (general.defaultPolicy ?? 'none'))!;
            return { key: option.key, name: option.name };
          })(),
          ...(autoplay
            ? {
                autoplay: {
                  active: tick >= autoplay.startsAtTick && tick < autoplay.expiresAtTick,
                  expired: tick >= autoplay.expiresAtTick,
                  startsAt: nextTurnAt(world, autoplay.startsAtTick),
                  expiresAt: nextTurnAt(world, autoplay.expiresAtTick),
                  expiresOn: toGameDate(world.startYear, autoplay.expiresAtTick),
                  ...(world.ruleFeatures.includes(INACTIVE_REMOVAL_FEATURE) && general.lastActiveTick !== null
                    ? {
                        removalOn: toGameDate(
                          world.startYear,
                          inactiveRemovalTick(general.lastActiveTick, world.turnTermMinutes),
                        ),
                      }
                    : {}),
                  slots: Array.from({ length: turns.length }, (_, slot) => slot).filter((slot) => {
                    const turn = general.nextTurnTick + slot * TICKS_PER_MONTH;
                    return turn >= autoplay.startsAtTick && turn < autoplay.expiresAtTick;
                  }),
                },
              }
            : {}),
        },
        city: { ...cityInfo(city, general), ...(ruins ? { ruin: ruins.get(city.cityKey) ?? null } : {}) },
        nation:
          nation === null
            ? null
            : {
                ...nationInfo(
                  nation,
                  { cityCount: nation.cities.length, generalCount: nation.generals.length },
                  general,
                ),
                ...nationPopulation(nation.cities),
                salaryRate,
                ...(finance ? { financeEstimate: finance.financeEstimate } : {}),
              },
        nextTurnAt: nextTurnAt(world, general.nextTurnTick),
        presence: {
          nationIds: [...new Set(connected.flatMap(({ nationId }) => (nationId === null ? [] : [nationId])))].sort(
            (a, b) => a - b,
          ),
          allies:
            general.nationId === null
              ? []
              : connected.filter(({ nationId }) => nationId === general.nationId).map(({ id, name }) => ({ id, name })),
        },
        turnSchedule: turnSchedule(world, general.nextTurnTick),
        turnsPreview: Array.from({ length: 5 }, (_, slot) => ({ slot, ...turns[slot]! })),
        recentLogs: logs.map(logInfo),
      };
    }),
  ),
});
