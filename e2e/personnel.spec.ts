import { expect, test, type Browser, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { createAccount, withE2eDb } from './account';
import {
  ApiError,
  createGeneralByApi,
  holdLease,
  mutate,
  query,
  releaseHold,
  stubPortraits,
  type OwnGeneral,
  type LeaseHold,
} from './game';

// T2-06 · AC-M2-05, AC-M2-16 화면: 인사부, 국가 예턴 12칸, 메인 발령 제안 상자.
// 인사·방침을 원생성한 월드의 실행권을 시험이 쥔다. 수락 뒤에도 엔진을 멈춘 채 처리 중을 볼 수 있다.
// T2-05 API(personnel.*, offers.*, nationTurns.*)가 없는 서버에서는 시험 전체를 건너뛴다. 그동안의 결과는 증거가 아니다.

test.describe.configure({ mode: 'serial', timeout: 240_000 });

interface Seat {
  page: Page;
  general: OwnGeneral;
}

let world: string;
let ruler: Seat;
let member: Seat;
let nationId: number;
let hold: LeaseHold | undefined;

async function personnelWorld(): Promise<string> {
  const initial = await loadInitialWorld({ scenario: '1030', map: 'che', seed: `e2e-personnel-${Date.now()}` });
  const { worldId } = await withE2eDb((db) =>
    saveInitialWorld(db, initial, {
      name: 'E2E 인사 대기 월드',
      turnTermMinutes: 1,
      endYear: 300,
      replayFormat: 3,
      ruleFeatures: ['personnel', 'policy'],
    }),
  );
  hold = await holdLease(worldId);
  await withE2eDb((db) => controlClock(db, worldId, 'start'));
  return worldId;
}

async function hasPersonnelApi(page: Page, worldId: string): Promise<boolean> {
  try {
    await query(page, 'offers.mine', { worldId });
    return true;
  } catch (error) {
    // tRPC는 없는 프로시저를 NOT_FOUND로 답한다. 다른 거부(인사 기능 이전 월드 등)는 API가 있다는 뜻이다.
    return !(error instanceof ApiError && error.code === 'NOT_FOUND');
  }
}

async function seat(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubPortraits(page);
  await createAccount(page);
  return page;
}

// 엔진이 접수를 처리할 동안만 돌린다.
async function withEngine<T>(work: () => Promise<T>): Promise<T> {
  if (!hold) throw new Error('인사 시험 월드의 실행권이 없습니다.');
  const lease = hold;
  const loop = new TurnLoop(lease.db, lease.lease);
  const controller = new AbortController();
  const running = (async () => {
    try {
      while (!controller.signal.aborted) {
        if (lease.lost) throw lease.lost;
        await loop.poll(controller.signal);
        await delay(100, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  void running.catch(() => undefined);
  try {
    return await work();
  } finally {
    controller.abort();
    await running;
  }
}

// 시험용 국가 배치. 인사 시드 도우미가 없어 엔진이 멈춘 대기 월드에서 DB로 군주와 일반 장수를 같은 국가에 둔다.
async function placeInNation() {
  await withE2eDb(async (db) => {
    const nation = await db.nation.findFirstOrThrow({ where: { worldId: world }, orderBy: { id: 'asc' } });
    nationId = nation.id;
    await db.general.updateMany({
      where: { worldId: world, nationId: nation.id, officerLevel: { gte: 5 } },
      data: { officerLevel: 1 },
    });
    const cityKey =
      nation.capitalCityKey ??
      (await db.city.findFirstOrThrow({ where: { worldId: world, nationId: nation.id } })).cityKey;
    await db.general.update({
      where: { worldId_id: { worldId: world, id: ruler.general.id } },
      data: { nationId: nation.id, officerLevel: 12, cityKey },
    });
    await db.general.update({
      where: { worldId_id: { worldId: world, id: member.general.id } },
      data: { nationId: nation.id, officerLevel: 1, cityKey },
    });
  });
}

// 엔진이 멈춘 채 일반 장수에게 PENDING 발령을 하나 만든다. 표 모양은 T2-05 계획의 AssignmentOffer다.
async function insertOffer(): Promise<{ cityKey: number; cityName: string }> {
  return withE2eDb(async (db) => {
    const target = await db.city.findFirstOrThrow({
      where: { worldId: world, nationId, NOT: { cityKey: (await cityOf(member.general.id)).cityKey } },
    });
    const w = await db.world.findUniqueOrThrow({ where: { id: world }, select: { clockTick: true } });
    await db.$executeRaw`DELETE FROM "AssignmentOffer" WHERE "worldId" = ${world} AND "targetGeneralId" = ${member.general.id} AND "status" = 'PENDING'`;
    await db.$executeRaw`
      INSERT INTO "AssignmentOffer" ("id", "worldId", "nationId", "issuerGeneralId", "targetGeneralId", "cityKey", "status", "createdTick", "expiresTick")
      VALUES (${`${w.clockTick}-${ruler.general.id}-${member.general.id}-${Date.now()}`}, ${world}, ${nationId}, ${ruler.general.id}, ${member.general.id}, ${target.cityKey}, 'PENDING', ${w.clockTick}, ${w.clockTick + 1_000_000})`;
    return { cityKey: target.cityKey, cityName: target.name };
  });
}

async function cityOf(generalId: number) {
  return withE2eDb((db) =>
    db.general.findUniqueOrThrow({
      where: { worldId_id: { worldId: world, id: generalId } },
      select: { cityKey: true, dedication: true },
    }),
  );
}

const offerBox = (page: Page) => page.getByRole('region', { name: '발령 제안' });
const notice = (page: Page) => page.getByTestId('personnel-notice');

test.beforeAll(async ({ browser }) => {
  const first = await seat(browser);
  world = await personnelWorld();
  const second = await seat(browser);
  await withEngine(async () => {
    ruler = { page: first, general: await createGeneralByApi(first, world) };
    member = { page: second, general: await createGeneralByApi(second, world) };
  });
  test.skip(!(await hasPersonnelApi(first, world)), 'T2-05 인사 API가 아직 서버에 없다');
  await placeInNation();
});
test.afterAll(async () => {
  if (hold) await releaseHold(hold);
  hold = undefined;
});

test('권한: 일반 장수는 인사 칸이 잠기고 서버가 준 이유를 본다', async () => {
  const { page } = member;
  const board = await query<{ appoint: { ok: false; reason: string } }>(page, 'personnel.officers', { worldId: world });
  expect(board.appoint).toEqual({ ok: false, reason: '군주만 임명·해임할 수 있습니다.' });
  await page.goto(`/w/${world}/nation/personnel`);
  await expect(page.getByRole('heading', { level: 1, name: '인사부' })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page
    .getByRole('button', { name: /임명|해임/ })
    .first()
    .click();
  await expect(page.getByRole('note').first()).toHaveText(board.appoint.reason);
  const before = await withE2eDb((db) => db.inputEvent.count({ where: { worldId: world } }));
  for (const path of ['personnel.appoint', 'personnel.dismiss'])
    await expect(
      mutate(page, path, {
        worldId: world,
        requestId: crypto.randomUUID(),
        generalId: member.general.id,
        ...(path === 'personnel.appoint' ? { officerLevel: 5 } : {}),
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  expect(await withE2eDb((db) => db.inputEvent.count({ where: { worldId: world } }))).toBe(before);
  await page.goto(`/w/${world}/nation/turns`);
  await expect(page.getByText('국가 예턴 권한이 없습니다')).toBeVisible();
});

test('임명: 군주가 수뇌를 임명하면 수뇌가 국가 예턴 12칸을 편집한다', async () => {
  const { page } = ruler;
  await page.goto(`/w/${world}/nation/personnel`);
  const row = page.locator('tr[data-level]').filter({ hasText: '빈 자리' }).last();
  await row.getByRole('combobox').selectOption(String(member.general.id));
  await row.getByRole('button', { name: '임명' }).click();
  await expect(row.getByRole('status')).toHaveText('처리 중');
  await withEngine(() => expect(notice(page)).toContainText('직책을', { timeout: 30_000 }));

  await member.page.goto(`/w/${world}/nation/turns`);
  const editor = member.page.getByTestId('turn-editor');
  await expect(editor.locator('tr[data-slot]')).toHaveCount(12);
  await expect(editor).not.toHaveAttribute('data-readonly', 'true');
  await expect(editor.locator('[data-readonly]')).toHaveCount(0);
  await expect(editor.getByTestId('draft-state')).toHaveText('저장된 목록');
  await editor.getByRole('button', { name: '저장 (사용 불가)', exact: true }).click();
  await expect(editor.getByRole('note')).toHaveText('바꾼 칸이 없습니다.');

  const ownOffice = async () => {
    const { tabs } = await query<{
      tabs: Array<{
        holder: { generalId: number } | null;
        edit: { ok: boolean };
        revision: number;
        slots: Array<{ commandKey: string; args: unknown }>;
      }>;
    }>(member.page, 'nationTurns.get', { worldId: world });
    const tab = tabs.find((candidate) => candidate.holder?.generalId === member.general.id);
    expect(tab).toBeDefined();
    expect(tab!.edit.ok).toBe(true);
    expect(tab!.slots).toHaveLength(12);
    return tab!;
  };
  const before = await ownOffice();
  expect(before.slots.every((slot) => slot.commandKey === 'nation_rest')).toBe(true);
  await editor.getByRole('button', { name: '밀기', exact: true }).click();
  await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  await expect(editor.getByRole('button', { name: '저장', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await expect(editor.getByTestId('draft-state')).toHaveText('저장된 목록');
  const saved = await ownOffice();
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.slots).toEqual(before.slots);
});

test('국가 칸 저장: 고친 뒤 해임·재임명되면 저장이 거부되고 빈 12칸을 다시 받는다', async () => {
  const { page } = member;
  await page.goto(`/w/${world}/nation/turns`);
  const editor = page.getByTestId('turn-editor');
  await editor.getByRole('button', { name: '밀기' }).click();
  await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');

  const tab = (
    await query<{ tabs: Array<{ officerLevel: number; holder: { generalId: number } | null }> }>(
      ruler.page,
      'nationTurns.get',
      { worldId: world },
    )
  ).tabs.find((t) => t.holder?.generalId === member.general.id)!;
  await withEngine(async () => {
    await mutate(ruler.page, 'personnel.dismiss', {
      worldId: world,
      requestId: crypto.randomUUID(),
      generalId: member.general.id,
    });
    await mutate(ruler.page, 'personnel.appoint', {
      worldId: world,
      requestId: crypto.randomUUID(),
      generalId: member.general.id,
      officerLevel: tab.officerLevel,
    });
  });

  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByTestId('office-changed')).toBeVisible();
  await expect(page.getByTestId('draft-state')).toHaveText('저장된 목록');
  await page.reload();
  await expect(page.getByTestId('draft-state')).toHaveText('저장된 목록');
});

test('대기와 화면 상태 보존: 엔진을 멈춘 채 수락하면 처리 중이고 연타해도 요청은 하나다', async () => {
  const { page } = member;
  const { cityName, cityKey } = await insertOffer();
  await page.goto(`/w/${world}?city=${cityKey}`);
  // 개인 예턴 초안을 하나 만들어 둔다.
  const editor = page.getByTestId('turn-editor');
  await editor.locator('tr[data-slot="1"]').click();
  await editor.getByLabel('명령 찾기').fill('휴식');
  await editor.getByRole('radio', { name: '휴식' }).check();
  await editor.getByRole('button', { name: /에 넣기$/ }).click();
  await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');

  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('offers.respond')) sent.push(r.postData() ?? '');
  });
  await offerBox(page).getByRole('button', { name: '수락' }).click();
  await expect(offerBox(page).getByRole('status')).toHaveText('처리 중');
  await offerBox(page).getByRole('button', { name: /수락/ }).click();
  await offerBox(page).getByRole('button', { name: /거절/ }).click();
  await page.waitForTimeout(1_000);
  expect(sent).toHaveLength(1);

  await withEngine(() => expect(notice(page)).toContainText(`발령을 수락해 ${cityName}`, { timeout: 30_000 }));
  await expect(offerBox(page)).toHaveCount(0);
  await expect(page.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
  expect(new URL(page.url()).searchParams.get('city')).toBe(String(cityKey));
  expect((await cityOf(member.general.id)).cityKey).toBe(cityKey);
});

test('거절: 결과의 공헌 감소 안내 뒤 상자가 사라진다', async () => {
  const { page } = member;
  await insertOffer();
  await page.goto(`/w/${world}`);
  const before = (await cityOf(member.general.id)).dedication;
  await offerBox(page).getByRole('button', { name: '거절' }).click();
  await withEngine(() => expect(notice(page)).toContainText('발령을 거절했습니다. 공헌이', { timeout: 30_000 }));
  const after = (await cityOf(member.general.id)).dedication;
  await expect(notice(page)).toHaveText(`발령을 거절했습니다. 공헌이 ${before - after} 줄었습니다.`);
  await expect(offerBox(page)).toHaveCount(0);
});

test('재접속: 처리 중에 새로 고치면 다시 처리 중이고 결과 안내는 한 번만 뜬다', async () => {
  const { page } = member;
  await insertOffer();
  await page.goto(`/w/${world}`);
  await offerBox(page).getByRole('button', { name: '수락' }).click();
  await expect(offerBox(page).getByRole('status')).toHaveText('처리 중');
  await page.reload();
  await expect(offerBox(page).getByRole('status')).toHaveText('처리 중');
  await withEngine(() => expect(notice(page)).toContainText('발령을 수락해', { timeout: 30_000 }));
  await page.reload();
  await expect(offerBox(page)).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);
});

test('탭을 닫은 사이 끝난 접수: 다시 들어오면 결과 안내가 한 번 보인다', async () => {
  const { page } = member;
  await insertOffer();
  await page.goto(`/w/${world}`);
  await offerBox(page).getByRole('button', { name: '수락' }).click();
  await expect(offerBox(page).getByRole('status')).toHaveText('처리 중');
  const context = page.context();
  await page.close();
  await withEngine(() =>
    expect
      .poll(
        () =>
          withE2eDb(
            (db) =>
              db.$queryRaw<Array<{ n: bigint }>>`
                SELECT count(*) AS n FROM "AssignmentOffer"
                WHERE "worldId" = ${world} AND "targetGeneralId" = ${member.general.id} AND "status" = 'PENDING'`,
          ).then((rows) => Number(rows[0]?.n ?? 0)),
        { timeout: 30_000 },
      )
      .toBe(0),
  );

  const again = await context.newPage();
  await stubPortraits(again);
  await again.goto(`/w/${world}`);
  await expect(notice(again)).toContainText('발령을 수락해');
  await again.reload();
  await expect(notice(again)).toHaveCount(0);
  member = { ...member, page: again };
});

test('개인 칸 회귀: 메인의 개인 30칸 편집은 그대로다', async () => {
  const { page } = member;
  await page.goto(`/w/${world}`);
  await expect(page.getByRole('grid', { name: '예턴 30칸' }).locator('tr[data-slot]')).toHaveCount(30);
});
