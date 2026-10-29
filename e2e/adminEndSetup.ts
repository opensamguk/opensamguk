import { createHash, randomUUID } from 'node:crypto';
import type { Page, Locator } from '@playwright/test';
import { expect, type LegalStack } from './legalFixture';
import { clockWorld, clockHuman, executeClock, type ClockWorld } from './adminClockSetup';
import { sanctionAccount } from './adminSanctionSetup';
import { TurnLoop } from '../apps/engine/src/turnLoop';

export async function endActor(page: Page, stack: LegalStack) {
  await stack.restart(null, true);
  return sanctionAccount(stack, page, true);
}
export async function endClock(
  page: Page,
  stack: LegalStack,
  world: ClockWorld,
  userId: string,
  action: 'start' | 'pause' | 'resume',
) {
  const result = await page.request.post(stack.origin + '/trpc/admin.world.requestClock', {
    headers: { Origin: stack.origin },
    timeout: 10_000,
    data: {
      expectedUserId: userId,
      worldId: world.id,
      action,
      reason: '종료 화면 실제 시계 준비',
      idempotencyKey: randomUUID(),
    },
  });
  expect(result.status()).toBe(200);
  await result.body();
  await executeClock(world);
}
export async function endWorld(page: Page, stack: LegalStack, userId: string, releases: Array<() => Promise<unknown>>) {
  const world = await clockWorld(stack, releases, false);
  await endClock(page, stack, world, userId, 'start');
  await clockHuman(page, stack, world, userId);
  await endClock(page, stack, world, userId, 'pause');
  expect(await stack.db.nation.count({ where: { worldId: world.id } })).toBe(21);
  expect(await stack.db.general.count({ where: { worldId: world.id, userId: null } })).toBe(491);
  return world;
}
export async function applyEnd(world: ClockWorld) {
  if (world.hold.lost) throw world.hold.lost;
  let elapsed = 0;
  const result = await new TurnLoop(world.hold.db, world.hold.lease, { elapsedNow: () => elapsed++ * 1000 }).poll();
  expect(result.executions).toEqual([]);
  if (world.hold.lost) throw world.hold.lost;
}
export async function endControls(page: Page, stack: LegalStack, worldId: string) {
  await page.goto(stack.origin + '/admin/worlds');
  await page.getByRole('button', { name: '월드 조회', exact: true }).click();
  const region = page.getByRole('region', { name: '월드 종료 조치', exact: true });
  const recover = region.getByRole('button', { name: '종료 계정과 권한 다시 확인', exact: true });
  if (await recover.isVisible()) await recover.click();
  await region.getByLabel('종료할 월드', { exact: true }).selectOption(worldId);
  await region.getByRole('button', { name: '월드 종료 확인', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '월드 종료 확인', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function confirmEnd(dialog: Locator, name: string, reason = '실제 종료 화면 인수') {
  await dialog.getByLabel('현재 월드 이름 그대로 입력', { exact: true }).fill(name);
  await dialog.getByLabel('종료 사유 (1~200자)', { exact: true }).fill(reason);
  await dialog.getByRole('checkbox', { name: '대상·상태·사유와 종료의 영향을 확인했습니다.', exact: true }).check();
}
export const endSubmit = (dialog: Locator) => dialog.getByRole('button', { name: '월드 종료 요청 확정', exact: true });
export const endQuery = (dialog: Locator) => dialog.getByRole('button', { name: '종료 요청 결과 조회', exact: true });
export function endWorldInvariant(value: object) {
  const preserved = { ...value } as Record<string, unknown>;
  // 이 네 열만 명시 종료가 쓴다. 나머지 World JSON·RNG·설정도 비교에 남긴다.
  for (const key of ['status', 'endedAt', 'clockRevision', 'actionSequence']) delete preserved[key];
  return createHash('sha256').update(JSON.stringify(preserved)).digest('hex');
}
// 게임 행은 한 DB문에서 읽고 heartbeat/lease는 명시적으로 분리한다.
export async function endFootprint(stack: LegalStack, worldId: string, includeWorld = false) {
  const tables = (
    await stack.db.$queryRaw<
      Array<{ table_name: string }>
    >`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='worldId' ORDER BY table_name`
  )
    .map((row) => row.table_name)
    .filter((table) => !['InputEvent', 'AuditLog', 'EngineLease', 'EngineHeartbeat'].includes(table));
  const parts = tables.map((table) => {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    return `SELECT '${table.replaceAll("'", "''")}' AS name,COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t WHERE "worldId"=$1`;
  });
  if (includeWorld) parts.push(`SELECT 'World' AS name,to_jsonb(w)::text AS body FROM "World" w WHERE id=$1`);
  const rows = await stack.db.$queryRawUnsafe<Array<{ name: string; body: string }>>(
    parts.join(' UNION ALL ') + ' ORDER BY name',
    worldId,
  );
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
