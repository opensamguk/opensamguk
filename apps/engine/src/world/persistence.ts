import type { PrismaClient, Prisma } from '@opensamguk/db';
import type { WorldInit } from '@opensamguk/rules';
import {
  emptyQueue,
  parsePreset,
  presetRules,
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
  type JsonValue,
  checkStatProfile,
  checkOperationalProfile,
  readOperationalMap,
  attachOperationalKinds,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { loadCommandState } from '../commandPersistence';
import { engineResolver, loadExt } from '../extState';
import { storedGeneralStats } from '../generalStats';

export async function saveInitialWorld(
  db: PrismaClient,
  state: WorldInit,
  options: {
    name: string;
    turnTermMinutes: number;
    endYear: number | null;
    replayFormat?: 'legacy' | 'policy' | 1 | 3;
    ruleFeatures?: string[];
    featureData?: Record<string, JsonValue>;
    treatyFormat?: 1;
    extFormat?: 1;
    preset?: { key: string; value: WorldPreset };
  },
) {
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
    resourceHash: hashState({
      scenarioKey: state.scenarioKey,
      mapKey: state.mapKey,
      unitSetKey: state.unitSetKey,
      statRules: state.statRules,
      unitSet: state.unitSet,
      ...(state.operationalMap ? { operationalMap: state.operationalMap } : {}),
    }),
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
    const resources = {
      scenarioKey: initial.scenarioKey,
      mapKey: initial.mapKey,
      unitSetKey: initial.unitSetKey,
      statRules: initial.statRules,
      unitSet: initial.unitSet,
      ...(initial.operationalMap ? { operationalMap: initial.operationalMap } : {}),
    };
    origin.resourceHash = hashState({ ...resources, ...(featureData !== undefined ? { featureData } : {}) });
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
  const world = await db.$transaction(
    async (tx) => {
      const world = await tx.world.create({
        data: {
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
              }
            : options.replayFormat === 'legacy'
              ? {}
              : { policyFromSequence: 0 }),
          ...(options.treatyFormat === 1 ? { treatyFormat: 1 } : {}),
          replayOrigin: replayOrigin as Prisma.InputJsonValue,
          statRules: creationState.statRules,
          unitSet: creationState.unitSet as Prisma.InputJsonValue,
          ...(creationState.operationalMap
            ? { operationalMap: creationState.operationalMap as Prisma.InputJsonValue }
            : {}),
          ...(creationState.commandMeta ? { commandMeta: creationState.commandMeta as Prisma.InputJsonValue } : {}),
        },
      });
      const worldId = world.id;
      // 국가↔수도 순환 참조는 같은 트랜잭션에서 도시를 만든 뒤 연결한다.
      await tx.nation.createMany({
        data: creationState.nations.map((nation) => ({ ...nation, worldId, capitalCityKey: null })),
      });
      await tx.city.createMany({ data: creationState.cities.map((city) => ({ ...city, worldId })) });
      for (const nation of creationState.nations) {
        await tx.nation.update({
          where: { worldId_id: { worldId, id: nation.id } },
          data: { capitalCityKey: nation.capitalCityKey },
        });
      }
      await tx.general.createMany({
        data: creationState.generals.map((general) => ({
          ...general,
          worldId,
          ...((featureFormat ? !features.includes('policy') : options.replayFormat === 'legacy')
            ? {}
            : { defaultPolicy: 'none', lastActiveTick: general.userId === null ? null : 0 }),
        })),
      });
      if (featureFormat ? features.includes('policy') : options.replayFormat !== 'legacy')
        await tx.generalTurn.createMany({
          data: creationState.generals.flatMap((general) =>
            emptyQueue().map((turn, slot) => ({ ...turn, args: {}, worldId, generalId: general.id, slot })),
          ),
        });
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
      return world;
    },
    { timeout: 30_000 },
  );
  return { worldId: world.id, stateHash };
}

export async function readWorldState(db: PrismaClient, worldId: string): Promise<WorldInit> {
  // 일관된 스냅샷에서 읽어 해시 비교 중 다른 트랜잭션의 변경이 섞이지 않게 한다.
  return db.$transaction(
    async (tx) => {
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      const { preset, commands } = engineResolver(world);
      const ext = await loadExt(tx, worldId, commands);
      const cities = await tx.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } });
      const nations = await tx.nation.findMany({
        where: { worldId },
        orderBy: { id: 'asc' },
        omit: { notice: true, noticeRevision: true, noticeUpdatedAt: true, noticeUpdatedBy: true },
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
      const operationalMap = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
      return {
        ...(operationalMap ? { operationalMap } : {}),
        ...(preset ? { presetRules: presetRules(preset) } : {}),
        ...(world.ruleFeatures?.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
        ...(ext ? { ext } : {}),
        seed: world.seed,
        scenarioKey: world.scenarioKey,
        mapKey: world.mapKey,
        unitSetKey: world.unitSetKey,
        startYear: world.startYear,
        statRules: statRulesSchema.parse({ stat: world.statRules }).stat,
        unitSet: unitSetSchema.parse(world.unitSet),
        cities: attachOperationalKinds(cities.map(stripWorldId), operationalMap),
        nations: nations.map((nation) => {
          if (nation.capitalCityKey === null) throw new Error(`국가 ${nation.id}의 수도가 없습니다.`);
          return { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey };
        }),
        generals: generals.map(({ turnRevision, battleWins, captures, ...general }) => {
          void turnRevision;
          void battleWins;
          void captures;
          return storedGeneralStats(stripWorldId(general), world.ruleFeatures?.includes('five-stats') ?? false);
        }),
        diplomacies: diplomacies.map(stripWorldId),
        ...(await loadCommandState(tx, worldId)),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
