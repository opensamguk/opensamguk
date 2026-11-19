import { isDeepStrictEqual } from 'node:util';
import type { checkWorldReplay } from './features';
import type { Prisma } from '@opensamguk/db';
import {
  campaignStateSchema,
  checkReplayOrigin,
  readCityRuins,
  type WorldView,
  type CityRuinsState,
} from '@opensamguk/rules';

type StoredWorld = Pick<
  Prisma.WorldGetPayload<Record<string, never>>,
  'id' | 'replayFormat' | 'replayOrigin' | 'cityRuinsState'
> & { campaignState?: unknown };

export function readStoredCityRuins(
  world: StoredWorld,
  state: Pick<WorldView, 'cities'> & Partial<Pick<WorldView, 'campaign'>>,
  checkedOrigin?: ReturnType<typeof checkWorldReplay>,
): CityRuinsState | undefined {
  let origin = checkedOrigin;
  if (origin === undefined) {
    const stored: unknown = world.replayOrigin;
    checkReplayOrigin(stored);
    origin = stored;
  } else if (origin !== (world.replayOrigin as unknown)) {
    throw new Error('검증한 생성 기록이 저장 행과 다릅니다.');
  }
  if (world.replayFormat !== 3 || origin.version !== 3) throw new Error('폐허의 재생 형식이나 생성 원장이 다릅니다.');
  const campaign =
    state.campaign ?? (world.campaignState == null ? undefined : campaignStateSchema.parse(world.campaignState));
  return readCityRuins(world.cityRuinsState, { ...state, ...(campaign ? { campaign } : {}) }, origin.initial.cityScale);
}

export async function assertStoredCityRuins(
  tx: Prisma.TransactionClient,
  world: StoredWorld,
  checkedOrigin?: ReturnType<typeof checkWorldReplay>,
): Promise<void> {
  const rows = await tx.city.findMany({ where: { worldId: world.id }, omit: { kind: true } });
  readStoredCityRuins(
    world,
    {
      cities: Object.fromEntries(rows.map((city) => [city.cityKey, city])),
    },
    checkedOrigin,
  );
}

// 호출자가 같은 World 행 잠금과 턴 트랜잭션을 유지한다.
export async function persistCityRuins(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldView,
  next: WorldView,
): Promise<void> {
  const original = readCityRuins(before.cityRuins, before);
  const final = readCityRuins(next.cityRuins, next);
  if (!original && !final) return;
  if (!original || !final) throw new Error('진행 중인 월드의 폐허 기능을 추가하거나 지울 수 없습니다.');
  if (isDeepStrictEqual(original, final)) return;
  const changed = await tx.$executeRaw`
    UPDATE "World" SET "cityRuinsState" = ${JSON.stringify(final)}::jsonb
    WHERE id = ${worldId} AND "cityRuinsState" = ${JSON.stringify(original)}::jsonb
  `;
  if (changed !== 1) throw new Error('저장할 폐허 상태가 바뀌었습니다.');
}
