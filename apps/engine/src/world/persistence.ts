import type { PrismaClient, Prisma } from '@opensamguk/db';
import type { WorldInit } from '@opensamguk/rules';
import { statRulesSchema, unitSetSchema } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { loadCommandState } from '../commandPersistence';

export async function saveInitialWorld(
  db: PrismaClient,
  state: WorldInit,
  options: { name: string; turnTermMinutes: number },
) {
  if (
    !options.name.trim() ||
    !Number.isSafeInteger(options.turnTermMinutes) ||
    options.turnTermMinutes < 1 ||
    options.turnTermMinutes > 2_147_483_647
  ) {
    throw new Error('월드 이름과 턴 간격(1~2147483647분)을 확인하세요.');
  }
  const stateHash = hashState(state);
  const world = await db.$transaction(
    async (tx) => {
      const world = await tx.world.create({
        data: {
          name: options.name,
          turnTermMinutes: options.turnTermMinutes,
          scenarioKey: state.scenarioKey,
          mapKey: state.mapKey,
          unitSetKey: state.unitSetKey,
          seed: state.seed,
          startYear: state.startYear,
          initialStateHash: stateHash,
          replayOrigin: {
            version: 1,
            initial: state,
            resourceHash: hashState({
              scenarioKey: state.scenarioKey,
              mapKey: state.mapKey,
              unitSetKey: state.unitSetKey,
              statRules: state.statRules,
              unitSet: state.unitSet,
            }),
            initialStateHash: stateHash,
          } as unknown as Prisma.InputJsonValue,
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
      await tx.general.createMany({ data: state.generals.map((general) => ({ ...general, worldId })) });
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
      const cities = await tx.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } });
      const nations = await tx.nation.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
      const generals = await tx.general.findMany({ where: { worldId }, orderBy: { id: 'asc' } });
      const diplomacies = await tx.diplomacy.findMany({
        where: { worldId },
        orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
      });
      const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
        void ignored;
        return value;
      };
      return {
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
        generals: generals.map(({ turnRevision, ...general }) => {
          void turnRevision;
          return stripWorldId(general);
        }),
        diplomacies: diplomacies.map(stripWorldId),
        ...(await loadCommandState(tx, worldId)),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
