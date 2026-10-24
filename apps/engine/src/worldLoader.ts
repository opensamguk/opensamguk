import type { Prisma } from '@opensamguk/db';
import { presetRules, type WorldState } from '@opensamguk/rules';
import { engineFeatures } from './features';
import { loadCommandState } from './commandPersistence';
import { engineResolver, loadExt } from './extState';
import { assertWorldCapabilities } from './capsGate';
import { loadTreaties } from './treatyState';
import { assertPersonnelStorage } from './personnelState';
import { assertNoResidenceAnchors } from './residenceState';

export async function loadWorld(tx: Prisma.TransactionClient, worldId: string): Promise<WorldState> {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const { preset, commands } = engineResolver(world);
  const capabilities = await assertWorldCapabilities(tx, world);
  if (world.replayFormat === 3) await assertPersonnelStorage(tx, worldId, world.ruleFeatures.includes('personnel'));
  if (world.replayFormat === 3 && !world.ruleFeatures.includes('personnel'))
    await assertNoResidenceAnchors(tx, worldId);
  const ext = await loadExt(tx, worldId, commands);
  const cities = await tx.city.findMany({ where: { worldId } });
  const nations = await tx.nation.findMany({
    where: { worldId },
    omit: { notice: true, noticeRevision: true, noticeUpdatedAt: true, noticeUpdatedBy: true },
  });
  const generals = await tx.general.findMany({
    where: { worldId },
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
  let state: WorldState = {
    ...(preset ? { presetRules: presetRules(preset) } : {}),
    ...(world.ruleFeatures?.length ? { ruleFeatures: [...world.ruleFeatures] } : {}),
    ...(ext ? { ext } : {}),
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
    ...(capabilities.kind === 'caps' && 'treaty' in capabilities.selection ? await loadTreaties(tx, worldId) : {}),
  };
  for (const feature of engineFeatures
    .filter((feature) => world.ruleFeatures?.includes(feature.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    state = (await feature.loadWorld?.(tx, worldId, state)) ?? state;
  return state;
}
