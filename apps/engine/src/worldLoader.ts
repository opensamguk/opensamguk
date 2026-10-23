import type { Prisma } from '@opensamguk/db';
import { parsePreset, presetRules, type WorldState } from '@opensamguk/rules';
import { loadCommandState } from './commandPersistence';

export async function loadWorld(tx: Prisma.TransactionClient, worldId: string): Promise<WorldState> {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({
    where: { worldId },
    omit: { notice: true, noticeRevision: true, noticeUpdatedAt: true, noticeUpdatedBy: true },
  });
  const generals = await tx.general.findMany({ where: { worldId }, omit: { noticeSeen: true } });
  const diplomacies = await tx.diplomacy.findMany({
    where: { worldId },
    orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
  });
  const stripWorldId = <T extends { worldId: string }>({ worldId: ignored, ...value }: T) => {
    void ignored;
    return value;
  };
  return {
    ...(world.preset ? { presetRules: presetRules(parsePreset(world.preset)) } : {}),
    startYear: world.startYear,
    cities: Object.fromEntries(cities.map((city) => [city.cityKey, stripWorldId(city)])),
    nations: Object.fromEntries(
      nations.map((nation) => {
        if (nation.capitalCityKey === null) throw new Error(`국가 ${nation.id}의 수도가 없습니다.`);
        return [nation.id, { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey }];
      }),
    ),
    generals: Object.fromEntries(
      generals.map(({ turnRevision, battleWins, captures, ...general }) => {
        void turnRevision;
        // 순위용 누계는 게임 규칙 입력이 아니다. 기존 재생 해시에 섞지 않는다.
        void battleWins;
        void captures;
        return [general.id, stripWorldId(general)];
      }),
    ),
    diplomacies: diplomacies.map(stripWorldId),
    ...(await loadCommandState(tx, worldId)),
  };
}
