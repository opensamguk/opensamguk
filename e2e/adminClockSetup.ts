import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, type LegalStack } from './legalFixture';
import { holdLease, type LeaseHold } from './game';
import { releaseLease } from '../apps/engine/src/lease';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';

export type ClockWorld = { id: string; hold: LeaseHold };
export async function clockWorld(stack: LegalStack, releases: Array<() => Promise<unknown>>, running = true) {
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'clock-ui-' + randomUUID(),
  });
  initial.ruleFeatures = [
    'campaign-assignment-v2',
    'campaign-v1',
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
    'stratagem-basic',
    'treaty',
  ];
  expect(initial.nations).toHaveLength(21);
  expect(initial.generals).toHaveLength(491);
  const { worldId: id } = await saveInitialWorld(stack.db, initial, {
    name: '시계 정식191 ' + randomUUID(),
    turnTermMinutes: 60,
    endYear: 201,
  });
  const hold = await holdLease(id);
  releases.push(async () => {
    hold.done.abort();
    const errors: unknown[] = [];
    for (const work of [
      async () => {
        await hold.renewal;
        if (hold.lost) throw hold.lost;
      },
      () => releaseLease(hold.db, hold.lease),
      () => hold.db.$disconnect(),
    ])
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, '자기 시계 월드 실행권 정리 실패');
  });
  if (running) await controlClock(hold.db, id, 'start');
  return { id, hold };
}
export async function executeClock(world: ClockWorld) {
  if (world.hold.lost) throw world.hold.lost;
  const { clockTick } = await world.hold.db.world.findUniqueOrThrow({
    where: { id: world.id },
    select: { clockTick: true },
  });
  await new TurnLoop(world.hold.db, world.hold.lease).advanceTo(clockTick);
  if (world.hold.lost) throw world.hold.lost;
}
export async function clockHuman(page: Page, stack: LegalStack, world: ClockWorld, userId: string) {
  const request = page.request.post(stack.origin + '/trpc/general.create', {
    headers: { Origin: stack.origin },
    timeout: 15_000,
    data: {
      worldId: world.id,
      name: '시계사람',
      portraitId: null,
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
    },
  });
  void request.catch(() => undefined);
  try {
    await expect
      .poll(() =>
        stack.db.inputEvent.count({ where: { worldId: world.id, userId, kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    await executeClock(world);
    expect((await request).status()).toBe(200);
    const human = await stack.db.general.findUniqueOrThrow({
      where: { worldId_userId: { worldId: world.id, userId } },
    });
    expect(await stack.db.generalTurn.count({ where: { worldId: world.id, generalId: human.id } })).toBe(30);
  } finally {
    await Promise.allSettled([request]);
  }
}
export async function clockGameRows(stack: LegalStack, worldId: string, includeWorld = false) {
  const hash = createHash('sha256'),
    excluded = new Set(['InputEvent', 'AuditLog', 'EngineLease', 'EngineHeartbeat']);
  const tables = await stack.db.$queryRaw<
    Array<{ table_name: string }>
  >`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='worldId' ORDER BY table_name`;
  for (const { table_name: table } of tables) {
    if (excluded.has(table)) continue;
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const [row] = await stack.db.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM ${quoted} t WHERE "worldId"=$1`,
      worldId,
    );
    hash.update(table + '\n' + row!.body + '\n');
  }
  if (includeWorld) {
    const [row] = await stack.db.$queryRaw<
      Array<{ body: string }>
    >`SELECT to_jsonb(w)::text AS body FROM "World" w WHERE id=${worldId}`;
    hash.update(row!.body);
  }
  return hash.digest('hex');
}
export async function clockControls(page: Page, stack: LegalStack, worldId: string) {
  await page.goto(stack.origin + '/admin/worlds');
  const controls = page.getByRole('region', { name: '월드 시계 조치', exact: true });
  if (await controls.getByRole('button', { name: '계정과 권한 다시 확인', exact: true }).isVisible())
    await controls.getByRole('button', { name: '계정과 권한 다시 확인', exact: true }).click();
  await page.getByRole('button', { name: '월드 조회', exact: true }).click();
  await controls.getByLabel('조치할 월드', { exact: true }).selectOption(worldId);
  return controls;
}
