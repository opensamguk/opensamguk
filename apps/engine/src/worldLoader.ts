import type { Prisma } from '@opensamguk/db';
import type { WorldState } from '@opensamguk/rules';

export async function loadWorld(tx: Prisma.TransactionClient, worldId: string): Promise<WorldState> {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({ where: { worldId } });
  const generals = await tx.general.findMany({ where: { worldId } });
  const diplomacies = await tx.diplomacy.findMany({ where: { worldId } });
  const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
    void ignored;
    return value;
  };
  return {
    startYear: world.startYear,
    cities: Object.fromEntries(cities.map((city) => [city.cityKey, stripWorldId(city)])),
    nations: Object.fromEntries(
      nations.map((nation) => {
        if (nation.capitalCityKey === null) throw new Error(`국가 ${nation.id}의 수도가 없습니다.`);
        return [nation.id, { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey }];
      }),
    ),
    generals: Object.fromEntries(
      generals.map(({ turnRevision, ...general }) => {
        void turnRevision;
        return [general.id, stripWorldId(general)];
      }),
    ),
    diplomacies: diplomacies.map(stripWorldId),
  };
}
