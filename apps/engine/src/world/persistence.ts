import { providedRuleData } from '@opensamguk/rules';
import { buildSupplyLedger } from '@opensamguk/rules';
import { OFFICE_EFFECTS_FEATURE, officeEffectsSchema } from '@opensamguk/rules';
import type { PrismaClient, Prisma } from '@opensamguk/db';
import type { WorldInit } from '@opensamguk/rules';
import {
  emptyQueue,
  parsePreset,
  presetRules,
  effectiveWorldOptions,
  statRulesSchema,
  unitSetSchema,
  toWorldState,
  type WorldPreset,
  checkReplayOrigin,
  replayResourceHashInput,
  type JsonValue,
  checkStatProfile,
  checkOperationalProfile,
  readOperationalMap,
  readOpeningCityProfile,
  attachOperationalKinds,
  emptyCampaignState,
  emptyCityResourcesState,
  initialCityRuins,
  initialNationStrategy,
  initialPreparedTurns,
  initialNationResearch,
  initialNationLifecycle,
  assertInitialNationLifecycle,
  assertNationLifecycle,
  readStoredNationLifecycle,
  initialLogisticsState,
  initialEquipment,
  equipmentConfigSchema,
  initialGovernanceState,
  initialLineageState,
  initialStratagemCards,
  readStratagemCardsConfig,
  storedGeneralSex,
  storedGeneralRemoval,
  applySexLedger,
  type SexLedger,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { loadCommandState } from '../commandPersistence';
import { engineResolver, loadExt } from '../extState';
import { storedGeneralStats } from '../generalStats';
import { persistInitialPublicMap } from '../publicMap';
import { loadSexLedger } from './resources';

export type InitialWorldOptions = {
  name: string;
  turnTermMinutes: number;
  endYear: number | null;
  fogOfWar?: boolean;
  replayFormat?: 'legacy' | 'policy' | 1 | 3;

  featureData?: Record<string, JsonValue>;
  treatyFormat?: 1;
  extFormat?: 1;
  preset?: { key: string; value: WorldPreset };
};

export interface PreparedInitialWorld {
  readonly stateHash: string;
}

type StorePreparedWorld = (
  tx: Prisma.TransactionClient,
  plannedWorldId?: string,
  publishInitialMap?: boolean,
) => Promise<{ worldId: string; stateHash: string }>;
const preparedWorlds = new WeakMap<PreparedInitialWorld, StorePreparedWorld>();

export function prepareInitialWorld(
  state: WorldInit,
  suppliedOptions: InitialWorldOptions,
  sexLedger?: SexLedger,
): PreparedInitialWorld {
  const options = structuredClone(suppliedOptions);
  if (
    !options.name.trim() ||
    !Number.isSafeInteger(options.turnTermMinutes) ||
    options.turnTermMinutes < 1 ||
    options.turnTermMinutes > 2_147_483_647
  ) {
    throw new Error('월드 이름과 턴 간격(1~2147483647분)을 확인하세요.');
  }
  if (options.replayFormat !== undefined && ![1, 3, 'legacy', 'policy'].includes(options.replayFormat))
    throw new Error('재생 생성 형식을 확인하세요.');
  if (options.replayFormat !== undefined && options.replayFormat !== 3)
    throw new Error('새 월드는 재생 형식 3만 사용합니다.');
  if (options.extFormat !== undefined || options.treatyFormat !== undefined)
    throw new Error('별도 기능 생성 옵션은 지원하지 않습니다.');
  const frozen = structuredClone(state);
  const base = frozen;
  const featureData = { ...providedRuleData(frozen, options.turnTermMinutes), ...options.featureData };
  assertInitialNationLifecycle(frozen, true);
  const preset = options.preset ? parsePreset(options.preset.value) : null;
  if (preset?.commands) throw new Error('월드별 명령 선택은 지원하지 않습니다.');
  if (options.preset && !/^[a-zA-Z0-9_-]+$/.test(options.preset.key)) throw new Error('프리셋 ID를 확인하세요.');
  const initial: WorldInit = {
    ...base,
    fogOfWar: options.fogOfWar ?? frozen.fogOfWar ?? false,
    ...(preset ? { presetRules: presetRules(preset) } : {}),
  };
  initial.generals = applySexLedger(initial, sexLedger ?? loadSexLedger());
  if (initial.generals.some((general) => Object.hasOwn(general, 'officerCityKey')))
    throw new Error('초기 장수에는 도시 관직을 배정할 수 없습니다.');
  const stateHash = hashState(initial);
  checkStatProfile(initial);
  checkOperationalProfile(initial);
  if (
    options.endYear !== null &&
    (!Number.isSafeInteger(options.endYear) || options.endYear < state.startYear || options.endYear > 10000)
  )
    throw new Error('종료 연도는 시작 연도 이상, 10000 이하 정수여야 합니다.');
  if (options.treatyFormat !== undefined && options.treatyFormat !== 1) throw new Error('조약 생성 형식을 확인하세요.');
  let replayOrigin: unknown = {
    version: 1,
    initial,
    resourceHash: hashState(replayResourceHashInput(state)),
    initialStateHash: stateHash,
  };
  const creationState = initial;
  {
    const origin = {
      version: typeof options.replayFormat === 'number' ? options.replayFormat : 3,
      initial,
      initialStateHash: stateHash,
      resourceHash: '',
      ...(featureData !== undefined ? { featureData } : {}),
    };
    checkReplayOrigin(origin);
    origin.resourceHash = hashState(replayResourceHashInput(initial, featureData));
    replayOrigin = origin;
  }
  const prepared = Object.freeze({ stateHash });
  preparedWorlds.set(prepared, async (tx, plannedWorldId, publishInitialMap) => {
    const world = await tx.world.create({
      select: { id: true, createdAt: true },
      data: {
        ...(plannedWorldId === undefined ? {} : { id: plannedWorldId }),
        name: options.name,
        fogOfWar: initial.fogOfWar ?? false,
        ...(preset ? { presetKey: options.preset!.key, preset: preset as Prisma.InputJsonValue } : {}),
        turnTermMinutes: options.turnTermMinutes,
        scenarioKey: creationState.scenarioKey,
        mapKey: creationState.mapKey,
        unitSetKey: creationState.unitSetKey,
        seed: creationState.seed,
        startYear: creationState.startYear,
        endYear: options.endYear,
        initialStateHash: stateHash,
        ...{
          replayFormat: typeof options.replayFormat === 'number' ? options.replayFormat : 3,

          ...{ officeEffects: officeEffectsSchema.parse(featureData?.[OFFICE_EFFECTS_FEATURE]) },
        },
        ...(options.treatyFormat === 1 ? { treatyFormat: 1 } : {}),
        replayOrigin: replayOrigin as Prisma.InputJsonValue,
        ...(initial.recruitmentLocation
          ? { runtimeOptions: { recruitmentLocation: initial.recruitmentLocation } }
          : {}),
        statRules: creationState.statRules,
        unitSet: creationState.unitSet as Prisma.InputJsonValue,
        ...{
          campaignState: {
            ...emptyCampaignState(toWorldState(creationState), creationState.seed, creationState.scenarioKey),
            ...(creationState.operationalMap ? { supplyLedger: buildSupplyLedger(creationState.operationalMap) } : {}),
          } as Prisma.InputJsonValue,
        },
        ...{ cityResourcesState: emptyCityResourcesState(toWorldState(creationState)) as Prisma.InputJsonValue },
        ...{ cityRuinsState: initialCityRuins(creationState) as Prisma.InputJsonValue },
        ...{ nationStrategyState: initialNationStrategy() as Prisma.InputJsonValue },
        ...{ preparedTurnsState: initialPreparedTurns() as Prisma.InputJsonValue },
        ...{ nationResearchState: initialNationResearch() as Prisma.InputJsonValue },
        ...{ nationLifecycleState: initialNationLifecycle(initial.nations) as Prisma.InputJsonValue },
        ...{
          logisticsState: initialLogisticsState(
            featureData?.['logistics-v1'],
            toWorldState(creationState),
          ) as Prisma.InputJsonValue,
        },
        ...{
          equipmentState: initialEquipment(
            equipmentConfigSchema.parse(featureData?.['equipment-v1']),
          ) as Prisma.InputJsonValue,
        },
        ...{
          governanceState: initialGovernanceState(
            featureData?.['governance-v1'],
            toWorldState(creationState),
          ) as Prisma.InputJsonValue,
        },
        ...{
          lineageState: initialLineageState(
            featureData?.['lineage-v1'],
            toWorldState(creationState),
            creationState.seed,
          ) as Prisma.InputJsonValue,
        },
        ...{
          stratagemCardsState: initialStratagemCards(
            readStratagemCardsConfig(featureData?.['stratagem-cards-v1']),
            toWorldState(creationState),
            creationState.seed,
          ) as Prisma.InputJsonValue,
        },
        ...(creationState.operationalMap
          ? { operationalMap: creationState.operationalMap as Prisma.InputJsonValue }
          : {}),
        ...(creationState.commandMeta ? { commandMeta: creationState.commandMeta as Prisma.InputJsonValue } : {}),
      },
    });
    const worldId = world.id;
    await tx.worldExtSlice.create({ data: { worldId, key: 'intel', value: {} } });
    // 국가↔수도 순환 참조는 같은 트랜잭션에서 도시를 만든 뒤 연결한다.
    await tx.nation.createMany({
      data: creationState.nations.map((nation) => ({ ...nation, worldId, capitalCityKey: null })),
    });
    await tx.city.createMany({ data: creationState.cities.map((city) => ({ ...city, worldId })) });
    for (const nation of creationState.nations) {
      await tx.nation.update({
        where: { worldId_id: { worldId, id: nation.id } },
        data: { capitalCityKey: nation.capitalCityKey },
        select: { id: true },
      });
    }
    await tx.general.createMany({
      data: creationState.generals.map((general) => ({
        ...general,
        worldId,
        ...{ defaultPolicy: 'none', lastActiveTick: general.userId === null ? null : 0 },
      })),
    });
    {
      const queue = emptyQueue();
      if (creationState.mapKey === 'san10-expanded') {
        // 확장판 공백지는 예턴 90,330칸을 만든다. DB에서 같은 빈 칸을 합성해 바인딩을 줄인다.
        const empty = queue[0]!;
        await tx.$executeRaw`
          INSERT INTO "GeneralTurn" ("worldId", "generalId", slot, "commandKey", args, explicit)
          SELECT g."worldId", g.id, slot, ${empty.commandKey}, '{}'::jsonb, ${empty.explicit}
          FROM "General" g CROSS JOIN generate_series(0, ${queue.length - 1}::int) AS slots(slot)
          WHERE g."worldId" = ${worldId}`;
      } else {
        await tx.generalTurn.createMany({
          data: creationState.generals.flatMap((general) =>
            queue.map((turn, slot) => ({ ...turn, args: {}, worldId, generalId: general.id, slot })),
          ),
        });
      }
    }
    await tx.diplomacy.createMany({
      data: creationState.diplomacies.map((diplomacy) => ({ ...diplomacy, worldId })),
    });
    await tx.nationTurn.createMany({
      data: Object.entries(creationState.nationTurns ?? {}).flatMap(([nationId, slots]) =>
        slots.map((slot, i) => ({
          worldId,
          nationId: Number(nationId),
          slot: i,
          commandKey: slot.commandKey,
          args: slot.args as Prisma.InputJsonValue,
        })),
      ),
    });
    if (publishInitialMap) {
      const publicState = toWorldState(creationState);
      publicState.governance = initialGovernanceState(featureData['governance-v1'], publicState);
      publicState.cityRuins = initialCityRuins(creationState);
      await persistInitialPublicMap(tx, world, publicState, creationState.operationalMap);
    }
    return { worldId: world.id, stateHash };
  });
  return prepared;
}

export async function savePreparedInitialWorld(
  tx: Prisma.TransactionClient,
  prepared: PreparedInitialWorld,
  plannedWorldId?: string,
  publishInitialMap = true,
) {
  const store = preparedWorlds.get(prepared);
  if (!store) throw new Error('검증한 초기 월드 자료가 필요합니다.');
  return store(tx, plannedWorldId, publishInitialMap);
}

export async function saveInitialWorld(db: PrismaClient, state: WorldInit, options: InitialWorldOptions) {
  const prepared = prepareInitialWorld(state, options);
  return db.$transaction((tx) => savePreparedInitialWorld(tx, prepared, undefined, false), { timeout: 30_000 });
}

export async function readWorldState(db: PrismaClient, worldId: string): Promise<WorldInit> {
  // 일관된 스냅샷에서 읽어 해시 비교 중 다른 트랜잭션의 변경이 섞이지 않게 한다.
  return db.$transaction(
    async (tx) => {
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      const { preset } = engineResolver(world);
      let cityScale: WorldInit['cityScale'];
      {
        const origin: unknown = world.replayOrigin;
        checkReplayOrigin(origin);
        cityScale = origin.initial.cityScale;
      }
      const ext = await loadExt(tx, worldId);
      const cities = await tx.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } });
      const nations = await tx.nation.findMany({
        where: { worldId },
        orderBy: { id: 'asc' },
        omit: {
          notice: true,
          noticeDirective: true,
          noticeRevision: true,
          noticeUpdatedAt: true,
          noticeUpdatedBy: true,
        },
      });
      const generals = await tx.general.findMany({
        where: { worldId },
        orderBy: { id: 'asc' },
        omit: { noticeSeen: true, defaultPolicy: true, lastActiveTick: true, lastActiveAt: true, residenceTick: true },
      });
      const diplomacies = await tx.diplomacy.findMany({
        where: { worldId },
        orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
      });
      const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
        void ignored;
        return value;
      };
      const operationalMap = readOperationalMap(world.operationalMap, world.replayOrigin);
      const openingCityProfile = operationalMap ? readOpeningCityProfile(world.replayOrigin) : undefined;
      const { presetRules: rules, recruitmentLocation } = effectiveWorldOptions(preset, world.runtimeOptions);
      const initial: WorldInit = {
        fogOfWar: world.fogOfWar,
        ...(operationalMap ? { operationalMap } : {}),
        ...(cityScale ? { cityScale } : {}),
        ...(openingCityProfile ? { openingCityProfile } : {}),
        ...(rules ? { presetRules: rules } : {}),
        ...(recruitmentLocation === 'city' ? { recruitmentLocation } : {}),

        ...(ext && world.replayFormat !== 3 ? { ext } : {}),
        seed: world.seed,
        scenarioKey: world.scenarioKey,
        mapKey: world.mapKey,
        unitSetKey: world.unitSetKey,
        startYear: world.startYear,
        statRules: statRulesSchema.parse({ stat: world.statRules }).stat,
        unitSet: unitSetSchema.parse(world.unitSet),
        cities: attachOperationalKinds(cities.map(stripWorldId), operationalMap),
        nations: nations.map((nation) => {
          return { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey };
        }),
        generals: generals.map(({ turnRevision, battleWins, captures, officerCityKey, ...general }) => {
          void turnRevision;
          void battleWins;
          void captures;
          return storedGeneralStats(
            storedGeneralRemoval(
              storedGeneralSex(
                { ...stripWorldId(general), ...(officerCityKey == null ? {} : { officerCityKey }) },
                true,
              ),
              world.replayFormat,
            ),
            true,
          );
        }),
        diplomacies: diplomacies.map(stripWorldId),
        ...(await loadCommandState(tx, worldId)),
      };
      const nationLifecycle = readStoredNationLifecycle(world);
      const state = toWorldState(initial);
      if (nationLifecycle) state.nationLifecycle = nationLifecycle;
      assertNationLifecycle(state);
      return initial;
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
