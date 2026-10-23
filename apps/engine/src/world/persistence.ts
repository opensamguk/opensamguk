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
  type CapsOrigin,
  type WorldPreset,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { loadCommandState } from '../commandPersistence';
import { engineResolver, loadExt } from '../extState';

export async function saveInitialWorld(
  db: PrismaClient,
  state: WorldInit,
  options: {
    name: string;
    turnTermMinutes: number;
    endYear: number | null;
    replayFormat?: 'legacy' | 'policy';
    treatyFormat?: 1;
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
  const parsedPreset = options.preset ? parsePreset(options.preset.value) : null;
  const { preset } = engineResolver({ preset: parsedPreset });
  if (options.preset && !/^[a-zA-Z0-9_-]+$/.test(options.preset.key)) throw new Error('프리셋 ID를 확인하세요.');
  const initial = preset ? { ...state, presetRules: presetRules(preset) } : state;
  const stateHash = hashState(initial);
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
    }),
    initialStateHash: stateHash,
  };
  if (options.treatyFormat === 1) {
    const origin: CapsOrigin = {
      version: ORIGIN_CAPS,
      initial,
      initialStateHash: stateHash,
      resourceHash: '',
      capabilities: { version: 1, treaty: { version: 1 } },
    };
    origin.resourceHash = hashState(capsResourceHashInput(origin));
    replayOrigin = parseCapsOrigin(origin);
  }
  const world = await db.$transaction(
    async (tx) => {
      const world = await tx.world.create({
        data: {
          name: options.name,
          ...(preset ? { presetKey: options.preset!.key, preset: preset as Prisma.InputJsonValue } : {}),
          turnTermMinutes: options.turnTermMinutes,
          scenarioKey: state.scenarioKey,
          mapKey: state.mapKey,
          unitSetKey: state.unitSetKey,
          seed: state.seed,
          startYear: state.startYear,
          endYear: options.endYear,
          initialStateHash: stateHash,
          ...(options.replayFormat === 'legacy' ? {} : { policyFromSequence: 0 }),
          ...(options.treatyFormat === 1 ? { treatyFormat: 1 } : {}),
          replayOrigin: replayOrigin as Prisma.InputJsonValue,
          statRules: state.statRules,
          unitSet: state.unitSet as Prisma.InputJsonValue,
          ...(state.commandMeta ? { commandMeta: state.commandMeta as Prisma.InputJsonValue } : {}),
        },
      });
      const worldId = world.id;
      // 국가↔수도 순환 참조는 같은 트랜잭션에서 도시를 만든 뒤 연결한다.
      await tx.nation.createMany({
        data: state.nations.map((nation) => ({ ...nation, worldId, capitalCityKey: null })),
      });
      await tx.city.createMany({ data: state.cities.map((city) => ({ ...city, worldId })) });
      for (const nation of state.nations) {
        await tx.nation.update({
          where: { worldId_id: { worldId, id: nation.id } },
          data: { capitalCityKey: nation.capitalCityKey },
        });
      }
      await tx.general.createMany({
        data: state.generals.map((general) => ({
          ...general,
          worldId,
          ...(options.replayFormat === 'legacy'
            ? {}
            : { defaultPolicy: 'none', lastActiveTick: general.userId === null ? null : 0 }),
        })),
      });
      if (options.replayFormat !== 'legacy')
        await tx.generalTurn.createMany({
          data: state.generals.flatMap((general) =>
            emptyQueue().map((turn, slot) => ({ ...turn, args: {}, worldId, generalId: general.id, slot })),
          ),
        });
      await tx.diplomacy.createMany({ data: state.diplomacies.map((diplomacy) => ({ ...diplomacy, worldId })) });
      await tx.nationTurn.createMany({
        data: Object.entries(state.nationTurns ?? {}).flatMap(([nationId, slots]) =>
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
        omit: { noticeSeen: true, defaultPolicy: true, lastActiveTick: true, lastActiveAt: true },
      });
      const diplomacies = await tx.diplomacy.findMany({
        where: { worldId },
        orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
      });
      const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
        void ignored;
        return value;
      };
      return {
        ...(preset ? { presetRules: presetRules(preset) } : {}),
        ...(ext ? { ext } : {}),
        seed: world.seed,
        scenarioKey: world.scenarioKey,
        mapKey: world.mapKey,
        unitSetKey: world.unitSetKey,
        startYear: world.startYear,
        statRules: statRulesSchema.parse({ stat: world.statRules }).stat,
        unitSet: unitSetSchema.parse(world.unitSet),
        cities: cities.map(stripWorldId),
        nations: nations.map((nation) => {
          if (nation.capitalCityKey === null) throw new Error(`국가 ${nation.id}의 수도가 없습니다.`);
          return { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey };
        }),
        generals: generals.map(({ turnRevision, battleWins, captures, ...general }) => {
          void turnRevision;
          void battleWins;
          void captures;
          return stripWorldId(general);
        }),
        diplomacies: diplomacies.map(stripWorldId),
        ...(await loadCommandState(tx, worldId)),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
