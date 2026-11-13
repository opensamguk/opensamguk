import { protectedProcedure, router } from '../trpc';
import { nextTurnAt, turnSchedule, readWorld, requireGeneral, worldClock, worldInput } from '../queries';
import { cityInfo, ownGeneralInfo, logInfo, logSelect, nationInfo } from '../visibility';
import {
  GENERAL_CONDITION_FEATURE,
  BATTLE_TACTICS_FEATURE,
  storedHeritageBenefits,
  TROOP_FEATURE,
  HERITAGE_BENEFITS_FEATURE,
  readTroops,
  troopOf,
  combatSpecialty,
  emptyStatExperience,
  STAT_GROWTH_FEATURE,
  STAT_UPGRADE_LIMIT,
  storedStatExperience,
  personalityEffects,
  domesticSpecialty,
  GENERAL_PROFICIENCY_FEATURE,
  proficiencyByArmType,
  storedGeneralProficiency,
  unitSetSchema,
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
  CITY_OFFICE_VOLUNTEER_FEATURE,
  PLAYER_AUTOPLAY_FEATURE,
  playerAutoplayWindow,
  policyOptions,
  toGameDate,
  storedHeritageTurnTime,
  turnTickForSlot,
} from '@opensamguk/rules';
import { displaySlots, readSlots } from '../game/slots';
import { readCityScaleProjection } from '../game/cityScale';
import { effectiveFinanceRates, nationPopulation, projectNationFinance } from '../game/nationFinance';
import { readView } from '../game/queries';
import { cityDefense } from '../game/defenseRead';
import { recordWorldTraffic } from '../game/worldTraffic';

export const homeRouter = router({
  get: protectedProcedure.input(worldInput).query(async ({ ctx, input }) => {
    const { page, traffic } = await readWorld(ctx.db, input.worldId, async (tx, world) => {
      const general = await requireGeneral(tx, input.worldId, ctx.user.id);
      const offset = storedHeritageTurnTime(general.heritageTurnTime).heritageTurnTime?.offset;
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
                  select: {
                    cityKey: true,
                    commerce: true,
                    agriculture: true,
                    population: true,
                    populationMax: true,
                    supplied: true,
                    defence: true,
                    wall: true,
                    wallMax: true,
                    warCasualties: true,
                    security: true,
                    securityMax: true,
                  },
                },
                generals: { select: { id: true, dedication: true, activeFromYear: true, removedAt: true } },
              },
            });
      const state =
        world.ruleFeatures.includes('campaign-v1') ||
        world.ruleFeatures.includes(TROOP_FEATURE) ||
        (nation && world.status !== 'ENDED' && world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE))
          ? await readView(tx, input.worldId)
          : undefined;
      const troops = state ? readTroops(state) : undefined;
      const troop = troops ? troopOf(troops, general.id) : undefined;
      const troopLeader = troop ? state?.generals[troop.leaderId] : undefined;
      const finance =
        nation && world.status !== 'ENDED'
          ? projectNationFinance(world, ctx.now, nation.cities, nation.generals, state, nation)
          : undefined;
      const turns = displaySlots(await readSlots(tx, input.worldId, general.id));
      const tick = nowTick(worldClock(world), ctx.now);
      const autoplay =
        world.ruleFeatures.includes(PLAYER_AUTOPLAY_FEATURE) &&
        general.lastActiveTick !== null &&
        world.status !== 'ENDED'
          ? playerAutoplayWindow(general.lastActiveTick, world.turnTermMinutes)
          : null;
      const proficiencyEnabled = world.ruleFeatures.includes(GENERAL_PROFICIENCY_FEATURE);
      const proficiency = proficiencyEnabled
        ? storedGeneralProficiency(true, general.proficiency).proficiency
        : undefined;
      const unitSet = proficiencyEnabled
        ? unitSetSchema.parse(
            (
              await tx.world.findUniqueOrThrow({
                where: { id: input.worldId },
                select: { unitSet: true },
              })
            ).unitSet,
          )
        : undefined;
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
      const pendingCityOfficeRequests =
        world.ruleFeatures.includes(CITY_OFFICE_VOLUNTEER_FEATURE) &&
        general.nationId !== null &&
        general.officerLevel >= 5
          ? Object.values(state?.cityOfficeVolunteers?.requests ?? {}).filter(
              (request) => request.nationId === general.nationId && request.status === 'pending',
            ).length
          : 0;
      const page = {
        ...(pendingCityOfficeRequests > 0 ? { pendingCityOfficeRequests } : {}),
        ...(world.ruleFeatures.includes(HERITAGE_BENEFITS_FEATURE) ? { heritageBenefitsEnabled: true as const } : {}),
        general: {
          ...ownGeneralInfo(general),
          ...(world.ruleFeatures.includes(STAT_GROWTH_FEATURE)
            ? {
                statExperience: storedStatExperience(general.statExperience).statExperience ?? emptyStatExperience,
                statUpgradeLimit: STAT_UPGRADE_LIMIT,
              }
            : {}),

          personalityEffects: personalityEffects(world, general.personality) ?? null,
          domesticSpecialty: domesticSpecialty(world, general.special) ?? null,
          combatSpecialty:
            combatSpecialty(world, general.heritageSpecialty === null ? general.special : general.combatSpecial) ??
            null,
          ...(world.ruleFeatures.includes(BATTLE_TACTICS_FEATURE)
            ? { battleTactics: { leadership: general.leadership, strength: general.strength, intel: general.intel } }
            : {}),
          ...(world.ruleFeatures.includes(HERITAGE_BENEFITS_FEATURE)
            ? { heritageBenefits: storedHeritageBenefits(true, general.heritageBenefits).heritageBenefits ?? null }
            : {}),
          troop:
            troop && troopLeader
              ? {
                  id: troop.leaderId,
                  name: troop.name,
                  leader: troopLeader.name,
                  leaderCity:
                    troopLeader.cityKey === general.cityKey ? null : (state?.cities[troopLeader.cityKey]?.name ?? null),
                }
              : null,
          ...(unitSet
            ? {
                proficiency: proficiencyByArmType(unitSet.armTypes, proficiency),
              }
            : {}),
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
                  gold: finance.salaries.gold.get(general.id) ?? 0,
                  rice: finance.salaries.rice.get(general.id) ?? 0,
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
                    const turn = turnTickForSlot(general.nextTurnTick, offset, slot);
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
                ...effectiveFinanceRates(world, nation),
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
        turnSchedule: turnSchedule(world, general.nextTurnTick, offset),
        turnsPreview: Array.from({ length: 5 }, (_, slot) => ({ slot, ...turns[slot]! })),
        recentLogs: logs.map(logInfo),
      };
      return {
        page,
        traffic:
          world.status === 'RUNNING' && general.removedAt === null && general.activeFromYear !== LINEAGE_EXITED_YEAR
            ? { tick, turnTermMinutes: world.turnTermMinutes }
            : null,
      };
    });
    const refreshScore = traffic
      ? await recordWorldTraffic(
          ctx.db,
          input.worldId,
          page.general.id,
          traffic.tick,
          ctx.now,
          traffic.turnTermMinutes,
        ).catch(() => {
          ctx.reply.log.warn('월드 접속량 집계에 실패했습니다.');
        })
      : undefined;
    return { ...page, ...(refreshScore ? { refreshScore } : {}) };
  }),
});
