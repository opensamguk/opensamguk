import { emptyQueue, initialReplayState, providedRuleData, type WorldInit } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { resourceHashV3 } from '../src/replay';

// 단위 TX용 저장 행. 실제 DB 저장·잠금은 통합 시험에서 검증한다.
export function storedFixture(initial: WorldInit, turnTermMinutes = 60) {
  const featureData = providedRuleData(initial, turnTermMinutes);
  const origin = { version: 3 as const, initial, initialStateHash: hashState(initial), resourceHash: '', featureData };
  origin.resourceHash = resourceHashV3(origin);
  const replay = initialReplayState(initial, featureData);
  const state = replay.state;
  const world = {
    monthlyTick: 0,
    replayFormat: 3,
    replayOrigin: origin,
    initialStateHash: origin.initialStateHash,
    operationalMap: initial.operationalMap,
    unitSet: initial.unitSet,
    statRules: initial.statRules,
    fogOfWar: initial.fogOfWar ?? false,
    officeEffects: state.officeEffects,
    campaignState: state.campaign,
    cityResourcesState: state.cityResources,
    cityRuinsState: state.cityRuins,
    nationStrategyState: state.nationStrategy,
    preparedTurnsState: state.preparedTurns,
    nationResearchState: state.nationResearch,
    nationLifecycleState: state.nationLifecycle,
    logisticsState: state.logistics,
    equipmentState: state.equipment,
    governanceState: state.governance,
    lineageState: state.lineage,
    stratagemCardsState: state.stratagemCards,
    relationsState: state.relations,
    turnTermMinutes,
  };
  return { world, replay, state, origin };
}

export function storedReaders(initial: WorldInit, worldId: string) {
  const stored = storedFixture(initial);
  const withWorld = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row, worldId }));
  const read = <T extends object>(
    rows: T[],
    query?: { omit?: Record<string, boolean>; select?: Record<string, boolean> },
  ) =>
    rows.map((row) => {
      const result = { ...row } as Record<string, unknown>;
      if (query?.select) return Object.fromEntries(Object.keys(query.select).map((key) => [key, result[key]]));
      for (const key of Object.keys(query?.omit ?? {})) delete result[key];
      return result;
    });
  return {
    world: {
      findUniqueOrThrow: async () => ({
        id: worldId,
        startYear: initial.startYear,
        seed: initial.seed,
        preset: null,
        commandMeta: null,
        ...stored.world,
      }),
    },
    city: { findMany: async () => withWorld(initial.cities) },
    nation: { findMany: async () => withWorld(initial.nations) },
    general: {
      findMany: async (query?: { omit?: Record<string, boolean>; select?: Record<string, boolean> }) =>
        read(
          withWorld(initial.generals).map((g) => ({
            ...g,
            turnRevision: 0,
            battleWins: 0,
            captures: 0,
            defaultPolicy: 'none',
            lastActiveTick: g.userId === null ? null : 0,
            residenceTick: g.userId === null ? null : 0,
          })),
          query,
        ),
    },
    diplomacy: { findMany: async () => withWorld(initial.diplomacies) },
    generalTurn: {
      findMany: async () =>
        initial.generals.flatMap((g) =>
          emptyQueue().map((turn, slot) => ({ ...turn, worldId, generalId: g.id, slot })),
        ),
    },
    nationTurn: { findFirst: async () => null, findMany: async () => [] },
    nationOffice: { findMany: async () => [] },
    nationOfficeTurn: { findMany: async () => [] },
    assignmentOffer: { findMany: async () => [] },
    nationTrust: { findMany: async () => [] },
    treaty: { findMany: async () => [] },
    governanceMovement: { findMany: async () => [] },
    logisticsMovement: { groupBy: async () => [] },
    reputationEvent: { findMany: async () => [] },
    monthlyReview: { findMany: async () => [] },
    $queryRaw: async () => [{ key: 'intel', value: {} }],
  };
}
