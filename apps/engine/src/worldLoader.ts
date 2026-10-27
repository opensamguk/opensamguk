import type { Prisma } from '@opensamguk/db';
import { presetRules, readOperationalMap, attachOperationalKinds, type WorldState } from '@opensamguk/rules';
import { engineFeatures } from './features';
import { loadCommandState } from './commandPersistence';
import { engineResolver, loadExt } from './extState';
import { assertWorldCapabilities } from './capsGate';
import { loadTreaties } from './treatyState';
import { assertPersonnelStorage } from './personnelState';
import { assertNoResidenceAnchorsInRows } from './residenceState';
import { storedGeneralStats } from './generalStats';

export async function loadWorld(tx: Prisma.TransactionClient, worldId: string): Promise<WorldState> {
  const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
  const capabilities = await assertWorldCapabilities(tx, world);
  return loadWorldAfterCapabilityCheck(tx, world, capabilities);
}

// 호출자는 같은 트랜잭션의 World 행을 잠그고 바로 앞에서 capability 검사를 마쳐야 한다.
// 입력을 처리하지 않은 일반 턴에서만 같은 사본을 재사용하며 다음 턴에는 다시 DB에서 검사한다.
export async function loadWorldAfterCapabilityCheck(
  tx: Prisma.TransactionClient,
  world: Prisma.WorldGetPayload<Record<string, never>>,
  capabilities: Awaited<ReturnType<typeof assertWorldCapabilities>>,
): Promise<WorldState> {
  const worldId = world.id;
  const { preset, commands } = engineResolver(world);
  if (world.replayFormat === 3) await assertPersonnelStorage(tx, worldId, world.ruleFeatures.includes('personnel'));
  const ext = await loadExt(tx, worldId, commands);
  const cities = await tx.city.findMany({ where: { worldId } });
  const operationalMap = readOperationalMap(world.operationalMap, world.ruleFeatures, world.replayOrigin);
  const nations = await tx.nation.findMany({
    where: { worldId },
    omit: { notice: true, noticeRevision: true, noticeUpdatedAt: true, noticeUpdatedBy: true },
  });
  const generals = await tx.general.findMany({
    where: { worldId },
    omit: { noticeSeen: true, defaultPolicy: true, lastActiveTick: true, lastActiveAt: true },
  });
  if (world.replayFormat === 3 && !world.ruleFeatures.includes('personnel')) assertNoResidenceAnchorsInRows(generals);
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
    cities: Object.fromEntries(
      attachOperationalKinds(cities.map(stripWorldId), operationalMap).map((city) => [city.cityKey, city]),
    ),
    nations: Object.fromEntries(
      nations.map((nation) => {
        if (nation.capitalCityKey === null) throw new Error(`국가 ${nation.id}의 수도가 없습니다.`);
        return [nation.id, { ...stripWorldId(nation), capitalCityKey: nation.capitalCityKey }];
      }),
    ),
    generals: Object.fromEntries(
      generals.map(({ turnRevision, battleWins, captures, residenceTick, ...general }) => {
        void turnRevision;
        void residenceTick;
        // 순위용 누계는 게임 규칙 입력이 아니다. 기존 재생 해시에 섞지 않는다.
        void battleWins;
        void captures;
        return [
          general.id,
          storedGeneralStats(stripWorldId(general), world.ruleFeatures?.includes('five-stats') ?? false),
        ];
      }),
    ),
    diplomacies: diplomacies.map(stripWorldId),
    ...(await loadCommandState(tx, worldId, world)),
    ...(capabilities.kind === 'caps' && 'treaty' in capabilities.selection ? await loadTreaties(tx, worldId) : {}),
  };
  for (const feature of engineFeatures
    .filter((feature) => world.ruleFeatures?.includes(feature.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
    state = (await feature.loadWorld?.(tx, worldId, state)) ?? state;
  return state;
}
