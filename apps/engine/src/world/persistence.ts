import { OFFICE_EFFECTS_FEATURE, defaultOfficeEffects, officeEffectsSchema } from '@opensamguk/rules';
import type { PrismaClient, Prisma } from '@opensamguk/db';
import type { WorldInit } from '@opensamguk/rules';
import {
  emptyQueue,
  parsePreset,
  presetRules,
  effectiveWorldOptions,
  statRulesSchema,
  unitSetSchema,
  ORIGIN_CAPS,
  capsResourceHashInput,
  parseCapsOrigin,
  selectSupportedCapabilities,
  createExtState,
  toWorldState,
  presetCommands,
  extSliceKeys,
  type CapsOrigin,
  type WorldPreset,
  checkRuleFeatures,
  checkReplayOrigin,
  checkInitialNpcStatLimits,
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
  INTEL_FEATURE,
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
  assertGeneralSex,
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
  replayFormat?: 'legacy' | 'policy' | 1 | 3;
  ruleFeatures?: string[];
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
  const featureFormat =
    typeof options.replayFormat === 'number' ||
    (options.replayFormat === undefined && options.extFormat === undefined && options.treatyFormat === undefined);
  if (state.recruitmentLocation && (!featureFormat || options.replayFormat === 1))
    throw new Error('도시별 모집은 재생 형식 3에서 사용할 수 있습니다.');
  if (
    (featureFormat && (options.extFormat !== undefined || options.treatyFormat !== undefined)) ||
    (!featureFormat &&
      (Object.hasOwn(state, 'ruleFeatures') || options.ruleFeatures !== undefined || options.featureData !== undefined))
  )
    throw new Error('기능 표시 형식과 기존 생성 옵션을 함께 쓸 수 없습니다.');
  const frozen = structuredClone(state);
  const { ruleFeatures: stateFeatures, ...base } = frozen;
  let features: string[] = [];
  let featureData = options.featureData === undefined ? undefined : structuredClone(options.featureData);
  if (featureFormat) {
    if (
      Object.hasOwn(frozen, 'ruleFeatures') &&
      options.ruleFeatures !== undefined &&
      JSON.stringify(stateFeatures) !== JSON.stringify(options.ruleFeatures)
    )
      throw new Error('월드 상태와 생성 옵션의 규칙 기능 목록이 다릅니다.');
    if (Object.hasOwn(frozen, 'ruleFeatures')) checkRuleFeatures(stateFeatures);
    if (options.ruleFeatures !== undefined && !Array.isArray(options.ruleFeatures))
      throw new Error('규칙 기능 목록은 배열이어야 합니다.');
    const selected = options.ruleFeatures ?? stateFeatures ?? [];
    if (!Array.isArray(selected)) throw new Error('규칙 기능 목록은 배열이어야 합니다.');
    features = selected.length ? checkRuleFeatures(selected) : [];
    if (
      featureData !== undefined &&
      (featureData === null || typeof featureData !== 'object' || Array.isArray(featureData))
    )
      throw new Error('규칙 기능 자료를 확인하세요.');
    if (features.includes(OFFICE_EFFECTS_FEATURE) && featureData?.[OFFICE_EFFECTS_FEATURE] === undefined)
      featureData = { ...featureData, [OFFICE_EFFECTS_FEATURE]: defaultOfficeEffects };
    if (features.includes('policy')) {
      const policy = featureData?.policy;
      if (
        policy !== undefined &&
        (policy === null ||
          typeof policy !== 'object' ||
          Array.isArray(policy) ||
          policy.version !== 1 ||
          policy.turnTermMinutes !== options.turnTermMinutes)
      )
        throw new Error('정책 기능 자료와 월드 턴 간격이 다릅니다.');
      if (policy === undefined)
        featureData = { ...featureData, policy: { version: 1, turnTermMinutes: options.turnTermMinutes } };
    }
  }
  assertInitialNationLifecycle(
    frozen,
    featureFormat && options.replayFormat !== 1 && features.includes('nation-lifecycle-v1'),
  );
  if (frozen.unitSet.coefMode === 'multiply' && !features.includes('battle-affinity-v2'))
    throw new Error('곱셈 병종 판에는 battle-affinity-v2 규칙 기능이 필요합니다.');
  const parsedPreset = options.preset ? parsePreset(options.preset.value) : null;
  if (options.extFormat !== undefined && options.extFormat !== 1) throw new Error('확장 생성 형식을 확인하세요.');
  if (
    options.extFormat === 1 &&
    (!parsedPreset?.commands || options.treatyFormat !== undefined || options.replayFormat === 'legacy')
  )
    throw new Error('확장 단독 월드의 생성 옵션을 확인하세요.');
  const preset =
    options.extFormat === 1
      ? parsePreset({
          ...parsedPreset!,
          commands: {
            general: [...parsedPreset!.commands!.general].sort(),
            nation: [...parsedPreset!.commands!.nation].sort(),
          },
        })
      : engineResolver({ preset: parsedPreset }).preset;
  if (options.preset && !/^[a-zA-Z0-9_-]+$/.test(options.preset.key)) throw new Error('프리셋 ID를 확인하세요.');
  const initial = {
    ...(featureFormat ? base : frozen),
    ...(preset ? { presetRules: presetRules(preset) } : {}),
    ...(features.length ? { ruleFeatures: features } : {}),
  };
  if (features.includes('lineage-v1')) initial.generals = applySexLedger(initial, sexLedger ?? loadSexLedger());
  else for (const general of initial.generals) assertGeneralSex(general, false);
  if (initial.generals.some((general) => Object.hasOwn(general, 'officerCityKey')))
    throw new Error('초기 장수에는 도시 관직을 배정할 수 없습니다.');
  const stateHash = hashState(initial);
  checkStatProfile(initial);
  if (!featureFormat) checkInitialNpcStatLimits(initial, 'legacy');
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
  let creationState = initial;
  if (featureFormat) {
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
  if (options.extFormat === 1) {
    const commands = presetCommands(preset)!;
    if (
      Object.hasOwn(initial, 'ext') ||
      extSliceKeys(commands).length !== 0 ||
      createExtState(commands, toWorldState(initial)) !== undefined
    )
      throw new Error('상태 조각이 없는 확장 명령만 생성할 수 있습니다.');
    const origin: CapsOrigin = {
      version: ORIGIN_CAPS,
      initial,
      initialStateHash: stateHash,
      resourceHash: '',
      capabilities: { version: 1, ext: { version: 1, commands, preset: preset!, resources: {}, sliceKeys: [] } },
    };
    origin.resourceHash = hashState(capsResourceHashInput(origin));
    const parsedOrigin = parseCapsOrigin(origin);
    selectSupportedCapabilities(parsedOrigin, {
      endYear: options.endYear,
      outcomeFromSequence: 0,
      policy: { version: 1, fromSequence: 0, turnTermMinutes: options.turnTermMinutes },
    });
    replayOrigin = parsedOrigin;
    creationState = parsedOrigin.initial;
  }
  if (options.treatyFormat === 1) {
    const origin: CapsOrigin = {
      version: ORIGIN_CAPS,
      initial,
      initialStateHash: stateHash,
      resourceHash: '',
      capabilities: { version: 1, treaty: { version: 1 } },
    };
    origin.resourceHash = hashState(capsResourceHashInput(origin));
    const parsedOrigin = parseCapsOrigin(origin);
    replayOrigin = parsedOrigin;
    creationState = parsedOrigin.initial;
  }
  const prepared = Object.freeze({ stateHash });
  preparedWorlds.set(prepared, async (tx, plannedWorldId, publishInitialMap) => {
    const world = await tx.world.create({
      select: { id: true, createdAt: true },
      data: {
        ...(plannedWorldId === undefined ? {} : { id: plannedWorldId }),
        name: options.name,
        ...(preset ? { presetKey: options.preset!.key, preset: preset as Prisma.InputJsonValue } : {}),
        turnTermMinutes: options.turnTermMinutes,
        scenarioKey: creationState.scenarioKey,
        mapKey: creationState.mapKey,
        unitSetKey: creationState.unitSetKey,
        seed: creationState.seed,
        startYear: creationState.startYear,
        endYear: options.endYear,
        initialStateHash: stateHash,
        ...(featureFormat
          ? {
              replayFormat: typeof options.replayFormat === 'number' ? options.replayFormat : 3,
              ruleFeatures: features,
              ...(features.includes(OFFICE_EFFECTS_FEATURE)
                ? { officeEffects: officeEffectsSchema.parse(featureData?.[OFFICE_EFFECTS_FEATURE]) }
                : {}),
            }
          : options.replayFormat === 'legacy'
            ? {}
            : { policyFromSequence: 0 }),
        ...(options.treatyFormat === 1 ? { treatyFormat: 1 } : {}),
        replayOrigin: replayOrigin as Prisma.InputJsonValue,
        ...(initial.recruitmentLocation
          ? { runtimeOptions: { recruitmentLocation: initial.recruitmentLocation } }
          : {}),
        statRules: creationState.statRules,
        unitSet: creationState.unitSet as Prisma.InputJsonValue,
        ...(features.includes('campaign-v1')
          ? {
              campaignState: emptyCampaignState(
                toWorldState(creationState),
                creationState.seed,
                creationState.scenarioKey,
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(features.includes('city-resources-v1')
          ? { cityResourcesState: emptyCityResourcesState(toWorldState(creationState)) as Prisma.InputJsonValue }
          : {}),
        ...(features.includes('city-scale-v1')
          ? { cityRuinsState: initialCityRuins(creationState) as Prisma.InputJsonValue }
          : {}),
        ...(features.includes('nation-strategy-v1')
          ? { nationStrategyState: initialNationStrategy() as Prisma.InputJsonValue }
          : {}),
        ...(features.includes('prepared-turns-v1')
          ? { preparedTurnsState: initialPreparedTurns() as Prisma.InputJsonValue }
          : {}),
        ...(features.includes('nation-research-v1')
          ? { nationResearchState: initialNationResearch() as Prisma.InputJsonValue }
          : {}),
        ...(features.includes('nation-lifecycle-v1')
          ? { nationLifecycleState: initialNationLifecycle(initial.nations) as Prisma.InputJsonValue }
          : {}),
        ...(features.includes('logistics-v1')
          ? {
              logisticsState: initialLogisticsState(
                featureData?.['logistics-v1'],
                toWorldState(creationState),
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(features.includes('equipment-v1')
          ? {
              equipmentState: initialEquipment(
                equipmentConfigSchema.parse(featureData?.['equipment-v1']),
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(features.includes('governance-v1')
          ? {
              governanceState: initialGovernanceState(
                featureData?.['governance-v1'],
                toWorldState(creationState),
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(features.includes('lineage-v1')
          ? {
              lineageState: initialLineageState(
                featureData?.['lineage-v1'],
                toWorldState(creationState),
                creationState.seed,
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(features.includes('stratagem-cards-v1')
          ? {
              stratagemCardsState: initialStratagemCards(
                readStratagemCardsConfig(featureData?.['stratagem-cards-v1'], features),
                toWorldState(creationState),
                creationState.seed,
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(creationState.operationalMap
          ? { operationalMap: creationState.operationalMap as Prisma.InputJsonValue }
          : {}),
        ...(creationState.commandMeta ? { commandMeta: creationState.commandMeta as Prisma.InputJsonValue } : {}),
      },
    });
    const worldId = world.id;
    if (features.includes(INTEL_FEATURE)) await tx.worldExtSlice.create({ data: { worldId, key: 'intel', value: {} } });
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
        ...(general.nationId === null ? {} : { nationJoinedTick: 0 }),
        ...((featureFormat ? !features.includes('policy') : options.replayFormat === 'legacy')
          ? {}
          : { defaultPolicy: 'none', lastActiveTick: general.userId === null ? null : 0 }),
      })),
    });
    if (featureFormat ? features.includes('policy') : options.replayFormat !== 'legacy') {
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
      if (features.includes('city-scale-v1')) publicState.cityRuins = initialCityRuins(creationState);
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
      const { preset, commands } = engineResolver(world);
      let cityScale: WorldInit['cityScale'];
      if (world.ruleFeatures.includes('city-scale-v1')) {
        const origin: unknown = world.replayOrigin;
        checkReplayOrigin(origin);
        cityScale = origin.initial.cityScale;
      }
      const ext = await loadExt(tx, worldId, commands, world.ruleFeatures);
      const cities = await tx.city.findMany({
        where: { worldId },
        orderBy: { cityKey: 'asc' },
        omit: { conflictTick: true, stratagemTick: true },
      });
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
        omit: {
          noticeSeen: true,
          defaultPolicy: true,
          lastActiveTick: true,
          lastActiveAt: true,
          residenceTick: true,
          nationJoinedTick: true,
        },
      });
      const diplomacies = await tx.diplomacy.findMany({
        where: { worldId },
        orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
      });
      const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
        void ignored;
        return value;
      };
      const operationalMap = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
      const openingCityProfile = operationalMap ? readOpeningCityProfile(world.replayOrigin) : undefined;
      const { presetRules: rules, recruitmentLocation } = effectiveWorldOptions(preset, world.runtimeOptions);
      const initial: WorldInit = {
        ...(operationalMap ? { operationalMap } : {}),
        ...(cityScale ? { cityScale } : {}),
        ...(openingCityProfile ? { openingCityProfile } : {}),
        ...(rules ? { presetRules: rules } : {}),
        ...(recruitmentLocation === 'city' ? { recruitmentLocation } : {}),
        ...(world.ruleFeatures?.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
        ...(ext && world.replayFormat !== 3 ? { ext } : {}),
        seed: world.seed,
        scenarioKey: world.scenarioKey,
        mapKey: world.mapKey,
        unitSetKey: world.unitSetKey,
        startYear: world.startYear,
        statRules: statRulesSchema.parse({ stat: world.statRules }).stat,
        unitSet: unitSetSchema.parse(world.unitSet),
        cities: attachOperationalKinds(
          cities.map(({ seasonalEvent, ...city }) => {
            void seasonalEvent;
            return stripWorldId(city);
          }),
          operationalMap,
        ),
        nations: nations.map(({ diplomaticAidUntilMonth, ...nation }) => {
          void diplomaticAidUntilMonth;
          return { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey };
        }),
        generals: generals.map(
          ({ turnRevision, battleWins, captures, stratagemSuccesses, officerCityKey, ...general }) => {
            void turnRevision;
            void battleWins;
            void captures;
            void stratagemSuccesses;
            return storedGeneralStats(
              storedGeneralRemoval(
                storedGeneralSex(
                  { ...stripWorldId(general), ...(officerCityKey == null ? {} : { officerCityKey }) },
                  world.ruleFeatures.includes('lineage-v1'),
                ),
                world.replayFormat,
              ),
              world.ruleFeatures?.includes('five-stats') ?? false,
            );
          },
        ),
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
