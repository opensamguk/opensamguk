import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  BALANCE,
  DIPLOMATIC_COOLDOWN_FEATURE,
  INTEL_FEATURE,
  NATION_STRATEGY_FEATURE,
  NPC_NATION_POLICY_FEATURE,
  NATION_RESTRICTIONS_FEATURE,
  NATION_RESTRICTIONS_KIND,
  NATION_RESTRICTIONS_MIN_OFFICE,
  changeNationRestrictions,
  nationRestrictions,
  nationRestrictionsInput,
  storedNationRestrictions,
  NPC_NATION_POLICY_KIND,
  npcNationPolicy,
  npcGeneralCommands,
  npcNationCommands,
  npcNationPolicyInput,
  npcPolicyLimits,
  storedNpcNationPolicy,
  OFFICE_EFFECTS_FEATURE,
  STRATEGY_KEYS,
  TICKS_PER_MONTH,
  WANDERING_MONTH_LIMIT,
  diplomaticAidMonths,
  effectiveWorldOptions,
  generalTurnCandidates,
  nationTurnCandidates,
  nowTick,
  parsePreset,
  readStoredNationStrategy,
  strategyMonth,
  toGameDate,
  unitSetSchema,
} from '@opensamguk/rules';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { entityKey, readWorld, viewerGeneral, worldClock, worldInput } from '../queries';
import { cityCapacity, cityInfo, garrisonGeneralInfo, mapCity, nationInfo, visibility } from '../visibility';
import { readView, requireGeneral, requireRuleFeature, requireWorld } from '../game/queries';
import { nationPopulation, projectNationFinance, salaryRate } from '../game/nationFinance';
import { nationTenureYears } from '../game/nationTenure';
import { worldResolver } from '../game/resolver';

export const nationRouter = router({
  setRestrictions: worldVerifiedProcedure
    .input(nationRestrictionsInput.extend(worldInput.shape))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const world = await requireWorld(tx, input.worldId, true);
        requireRuleFeature(world, NATION_RESTRICTIONS_FEATURE);
        if (world.status === 'ENDED')
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
        const actor = await requireGeneral(tx, input.worldId, ctx.user.id, true);
        if (
          actor.removedAt !== null ||
          actor.officerLevel < NATION_RESTRICTIONS_MIN_OFFICE ||
          actor.nationId !== input.nationId
        )
          throw new TRPCError({ code: 'FORBIDDEN', message: '현재 소속국 수뇌부만 제한을 변경할 수 있습니다.' });
        const pending = await tx.inputEvent.findFirst({
          where: {
            worldId: input.worldId,
            kind: NATION_RESTRICTIONS_KIND,
            status: 'PENDING',
            payload: { path: ['nationId'], equals: input.nationId },
          },
          select: { payload: true },
        });
        const payload = { nationId: input.nationId, setting: input.setting, blocked: input.blocked };
        if (pending) {
          const previous = nationRestrictionsInput.parse(pending.payload);
          if (previous.setting !== input.setting || previous.blocked !== input.blocked)
            throw new TRPCError({ code: 'CONFLICT', message: '다른 국가 제한 변경을 처리하고 있습니다.' });
          return { status: 'pending' as const };
        }
        const row = await tx.nation.findUniqueOrThrow({
          where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
          select: { restrictions: true },
        });
        const current = nationRestrictions(world, storedNationRestrictions(true, row.restrictions), world.clockTick);
        if (!changeNationRestrictions(current, payload))
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: '이번 달 출병 제한 변경 횟수가 남아 있지 않습니다.',
          });
        await tx.inputEvent.create({
          data: {
            worldId: input.worldId,
            userId: ctx.user.id,
            generalId: actor.id,
            kind: NATION_RESTRICTIONS_KIND,
            idempotencyKey: `${NATION_RESTRICTIONS_KIND}:${randomUUID()}`,
            payload,
          },
        });
        return { status: 'pending' as const };
      }),
    ),
  setNpcPolicy: worldVerifiedProcedure.input(npcNationPolicyInput.extend(worldInput.shape)).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const world = await requireWorld(tx, input.worldId, true);
      requireRuleFeature(world, NPC_NATION_POLICY_FEATURE);
      if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
      const actor = await requireGeneral(tx, input.worldId, ctx.user.id, true);
      if (actor.removedAt !== null || actor.officerLevel !== BALANCE.RULER_LEVEL || actor.nationId !== input.nationId)
        throw new TRPCError({ code: 'FORBIDDEN', message: '현재 군주만 NPC 운영 기준을 변경할 수 있습니다.' });
      const pending = await tx.inputEvent.findFirst({
        where: { worldId: input.worldId, generalId: actor.id, kind: NPC_NATION_POLICY_KIND, status: 'PENDING' },
        select: { payload: true },
      });
      const payload = { nationId: input.nationId, policy: input.policy };
      if (pending) {
        const previous = npcNationPolicyInput.parse(pending.payload);
        if (previous.nationId !== input.nationId || JSON.stringify(previous.policy) !== JSON.stringify(input.policy))
          throw new TRPCError({ code: 'CONFLICT', message: '다른 NPC 운영 기준 요청을 처리하고 있습니다.' });
      } else {
        await tx.inputEvent.create({
          data: {
            worldId: input.worldId,
            userId: ctx.user.id,
            generalId: actor.id,
            kind: NPC_NATION_POLICY_KIND,
            idempotencyKey: `${NPC_NATION_POLICY_KIND}:${randomUUID()}`,
            payload,
          },
        });
      }
      return { status: 'pending' as const };
    }),
  ),
  get: protectedProcedure.input(worldInput.extend({ nationId: entityKey }).strict()).query(({ ctx, input }) =>
    readWorld(ctx.db, input.worldId, async (tx, world) => {
      const viewer = await viewerGeneral(tx, input.worldId, ctx.user.id);
      const nation = await tx.nation.findUnique({
        where: { worldId_id: { worldId: input.worldId, id: input.nationId } },
      });
      if (!nation) throw new TRPCError({ code: 'NOT_FOUND', message: '국가를 찾을 수 없습니다.' });
      const openRoster = !world.ruleFeatures.includes(INTEL_FEATURE);
      const ownNation = visibility(viewer).nation(nation);
      const tick = world.result?.endedTick ?? nowTick(worldClock(world), ctx.now);
      const cities = await tx.city.findMany({
        where: input,
        orderBy: ownNation ? [{ region: 'asc' }, { level: 'desc' }, { cityKey: 'asc' }] : { cityKey: 'asc' },
      });
      const generals = await tx.general.findMany({ where: input, orderBy: { id: 'asc' } });
      const needsOfficeEffects =
        ownNation && world.status !== 'ENDED' && world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE);
      const showNpcOrders = ownNation && viewer?.officerLevel === BALANCE.RULER_LEVEL && world.status !== 'ENDED';
      const state =
        needsOfficeEffects ||
        showNpcOrders ||
        world.ruleFeatures.some((feature) => ['campaign-v1', 'nation-lifecycle-v1'].includes(feature))
          ? await readView(tx, input.worldId)
          : undefined;
      const units = state?.campaign?.units;
      const lifecycle = state?.nationLifecycle;
      const wandering = lifecycle?.nations[String(nation.id)];
      const settlements = cities.filter((city) => city.kind !== 'PASS').sort((a, b) => a.cityKey - b.cityKey);
      const finance =
        ownNation && world.status !== 'ENDED'
          ? projectNationFinance(world, ctx.now, settlements, generals, state, nation.philosophy)
          : undefined;
      const strategyStatus =
        ownNation && world.status !== 'ENDED' && world.ruleFeatures.includes(NATION_STRATEGY_FEATURE)
          ? await readStrategyStatus()
          : undefined;
      const diplomaticAid =
        ownNation && world.ruleFeatures.includes(DIPLOMATIC_COOLDOWN_FEATURE) && world.status !== 'ENDED'
          ? { remainingMonths: diplomaticAidMonths(nation, strategyMonth(tick)) }
          : undefined;
      const npcOrders = showNpcOrders && state ? await readNpcOrders(state) : undefined;
      const restrictionsEnabled = world.ruleFeatures.includes(NATION_RESTRICTIONS_FEATURE);
      const restrictions = nationRestrictions(
        world,
        storedNationRestrictions(restrictionsEnabled, nation.restrictions),
        world.clockTick,
      );
      const canEditRestrictions =
        restrictionsEnabled &&
        ownNation &&
        world.status !== 'ENDED' &&
        (viewer?.officerLevel ?? 0) >= NATION_RESTRICTIONS_MIN_OFFICE;
      const restrictionPending = canEditRestrictions
        ? await tx.inputEvent.findFirst({
            where: {
              worldId: input.worldId,
              kind: NATION_RESTRICTIONS_KIND,
              status: 'PENDING',
              payload: { path: ['nationId'], equals: nation.id },
            },
            select: { payload: true },
          })
        : null;
      const npcPolicyEnabled = world.ruleFeatures.includes(NPC_NATION_POLICY_FEATURE);
      const npcPolicyEditable = npcPolicyEnabled && showNpcOrders;
      const npcPolicyPending = npcPolicyEditable
        ? await tx.inputEvent.findFirst({
            where: { worldId: input.worldId, generalId: viewer!.id, kind: NPC_NATION_POLICY_KIND, status: 'PENDING' },
            select: { payload: true },
          })
        : null;
      return {
        ...(lifecycle
          ? {
              nationLifecycleEnabled: true as const,
              wandering: wandering
                ? {
                    sinceTick: wandering.sinceTick,
                    expiresTick: wandering.sinceTick + WANDERING_MONTH_LIMIT * TICKS_PER_MONTH,
                  }
                : null,
            }
          : {}),
        ...(units === undefined ? {} : { campaignEnabled: true as const }),
        ...(world.ruleFeatures.includes('five-stats') ? { fiveStats: true as const } : {}),
        ...nationInfo(nation, { cityCount: settlements.length, generalCount: generals.length }, viewer),
        philosophy: nation.philosophy,
        ...(restrictionsEnabled
          ? {
              restrictions: {
                recruitmentBlocked: restrictions.recruitmentBlocked,
                ...(ownNation ? { warBlocked: restrictions.warBlocked } : {}),
                ...(canEditRestrictions
                  ? {
                      editor: {
                        warChanges: restrictions.warChanges,
                        pending: restrictionPending ? nationRestrictionsInput.parse(restrictionPending.payload) : null,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(nation.recruitmentNotice ? { recruitmentNotice: nation.recruitmentNotice } : {}),
        ...(ownNation && viewer?.officerLevel === BALANCE.RULER_LEVEL && world.status !== 'ENDED'
          ? { canEditRecruitmentNotice: true as const }
          : {}),
        ...nationPopulation(settlements),
        ...(ownNation
          ? {
              salaryRate,
              npcPolicy: {
                ...npcNationPolicy(world, storedNpcNationPolicy(npcPolicyEnabled, nation.npcSettings)),
                ...(npcPolicyEditable
                  ? {
                      editor: {
                        limits: npcPolicyLimits,
                        commands: { general: npcGeneralCommands, nation: npcNationCommands },
                        pending: npcPolicyPending ? npcNationPolicyInput.parse(npcPolicyPending.payload).policy : null,
                      },
                    }
                  : {}),
                ...npcOrders,
                aggression:
                  effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions)
                    .presetRules?.npc.aggression ?? 1,
              },
            }
          : {}),
        ...(finance ? { financeEstimate: finance.financeEstimate } : {}),
        ...(strategyStatus ? { strategyStatus } : {}),
        ...(diplomaticAid ? { diplomaticAid } : {}),
        cities: cities.map((city) => {
          if (!ownNation) return { ...mapCity(city), ...cityCapacity(city) };
          const incomeEstimate = finance?.cityIncome.get(city.cityKey);
          return { ...cityInfo(city, viewer), ...(incomeEstimate ? { incomeEstimate } : {}) };
        }),
        generals: generals.map((general) => {
          const tenureYears =
            (ownNation || openRoster) && general.removedAt === null
              ? nationTenureYears(general.nationJoinedTick, tick)
              : undefined;
          return {
            ...garrisonGeneralInfo(general, viewer, units, { stats: openRoster, biography: openRoster }),
            ...(tenureYears === undefined ? {} : { tenureYears }),
          };
        }),
      };

      async function readNpcOrders(view: NonNullable<typeof state>) {
        const stored = await requireWorld(tx, input.worldId);
        const { resolver } = worldResolver(stored);
        const ruler = view.generals[viewer!.id];
        if (!ruler) return undefined;
        const context = {
          resolver,
          unitSet: unitSetSchema.safeParse(stored.unitSet).data,
          worldSeed: stored.seed,
        };
        const summarize = (candidates: ReturnType<typeof generalTurnCandidates>) => {
          const bestByCommand = new Map<string, (typeof candidates)[number]>();
          for (const candidate of candidates) {
            const best = bestByCommand.get(candidate.key);
            if (!best || candidate.score > best.score) bestByCommand.set(candidate.key, candidate);
          }
          return [...bestByCommand.values()]
            .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key, 'en'))
            .map(({ key, score, reason }) => ({ key, name: resolver.get(key)?.name ?? key, score, reason }));
        };
        const currentYear = toGameDate(world.startYear, tick).year;
        const npcs = Object.values(view.generals).filter(
          (general) =>
            general.nationId === input.nationId &&
            general.userId === null &&
            general.removedAt === undefined &&
            general.activeFromYear <= currentYear,
        );
        return {
          nationOrders: summarize(nationTurnCandidates(view, ruler, { ...context, tick: ruler.nextTurnTick })),
          generalOrders: summarize(
            npcs.flatMap((general) => generalTurnCandidates(view, general, { ...context, tick: general.nextTurnTick })),
          ),
        };
      }

      async function readStrategyStatus() {
        const storedWorld = await requireWorld(tx, input.worldId);
        const ledger = readStoredNationStrategy(storedWorld)?.nations[input.nationId];
        const current = strategyMonth(tick);
        const globalUntil = ledger?.strategicUntil ?? 0;
        const availability = (until: number) => ({
          remainingMonths: Math.max(0, until - current),
          availableAt: until > current ? toGameDate(world.startYear, until * TICKS_PER_MONTH) : null,
        });
        const definitions = worldResolver(storedWorld).resolver.list('nation');
        return {
          ...availability(globalUntil),
          commands: STRATEGY_KEYS.flatMap((key) => {
            const definition = definitions.find((item) => item.key === key);
            return definition
              ? [{ key, name: definition.name, ...availability(Math.max(globalUntil, ledger?.commands[key] ?? 0)) }]
              : [];
          }),
        };
      }
    }),
  ),
});
