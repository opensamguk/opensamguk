import { expect, test } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { createAccount, withE2eDb } from './account';
import { createGeneralByApi, holdLease, mutate, query, releaseHold, stubPortraits, turns } from './game';

test('AC-M3-12 군주의 지방 임명·교체·해임, 장수 이동과 375px 관직 화면', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const features = ['office-effects', 'personnel'];
  const { worldId } = await withE2eDb(async (db) => {
    const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'e2e-office-residence' });
    return saveInitialWorld(db, initial, {
      name: 'E2E 관직 주재',
      turnTermMinutes: 60,
      endYear: 300,
      replayFormat: 3,
      ruleFeatures: features,
    });
  });
  const hold = await holdLease(worldId);
  const rulerContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const memberContext = await browser.newContext();
  const ruler = await rulerContext.newPage();
  const member = await memberContext.newPage();
  const loop = new TurnLoop(hold.db, hold.lease);
  async function withEngine<T>(work: () => Promise<T>) {
    const controller = new AbortController();
    const running = (async () => {
      try {
        while (!controller.signal.aborted) {
          if (hold.lost) throw hold.lost;
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
  try {
    await Promise.all([stubPortraits(ruler), stubPortraits(member), createAccount(ruler), createAccount(member)]);
    await controlClock(hold.db, worldId, 'start');
    const [rulerGeneral, memberGeneral] = await withEngine(() =>
      Promise.all([createGeneralByApi(ruler, worldId, '관직군주'), createGeneralByApi(member, worldId, '관직장수')]),
    );
    const cities = await hold.db.city.findMany({
      where: { worldId, nationId: { not: null }, OR: [{ kind: null }, { kind: { not: 'PASS' } }] },
      orderBy: { cityKey: 'asc' },
    });
    const home = cities.find((city) =>
      cities.some((neighbor) => neighbor.nationId === city.nationId && city.connections.includes(neighbor.cityKey)),
    )!;
    const neighbor = cities.find((city) => city.nationId === home.nationId && home.connections.includes(city.cityKey))!;
    const { startYear } = await hold.db.world.findUniqueOrThrow({
      where: { id: worldId },
      select: { startYear: true },
    });
    const candidate = await hold.db.general.findFirstOrThrow({
      where: {
        worldId,
        nationId: home.nationId,
        userId: null,
        officerLevel: { lte: 1 },
        activeFromYear: { lte: startYear },
      },
      orderBy: { id: 'asc' },
    });
    await hold.db.general.updateMany({
      where: { worldId, nationId: home.nationId, officerLevel: 12 },
      data: { officerLevel: 1 },
    });
    for (const [id, officerLevel] of [
      [rulerGeneral.id, 12],
      [memberGeneral.id, 1],
      [candidate.id, 1],
    ] as const) {
      await hold.db.general.update({
        where: { worldId_id: { worldId, id } },
        data: { cityKey: home.cityKey, nationId: home.nationId, officerLevel, strength: 80, intel: 80 },
      });
    }
    const boardUrl = `/w/${worldId}/nation/personnel`;
    const cityUrl = `/w/${worldId}/city/${home.cityKey}`;
    const appoint = (page: typeof ruler, generalId: number) =>
      mutate(page, 'personnel.appoint', {
        worldId,
        requestId: crypto.randomUUID(),
        generalId,
        officerLevel: 4,
        cityKey: home.cityKey,
      });

    await member.goto(boardUrl);
    const memberPanel = member.getByRole('region', { name: '지방 관직' });
    await memberPanel.getByRole('button', { name: /지방 관직 임명/ }).click();
    await expect(memberPanel.getByRole('note')).toHaveText('군주만 임명·해임할 수 있습니다.');
    await expect(appoint(member, memberGeneral.id)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await ruler.goto(boardUrl);
    const panel = ruler.getByRole('region', { name: '지방 관직' });
    await expect(panel.getByRole('group', { name: '태수' })).toHaveCount(0);
    const selectCity = panel.getByLabel('담당 도시');
    await selectCity.selectOption(String(home.cityKey));
    const mayor = panel.getByRole('group', { name: '태수' });
    const strategist = panel.getByRole('group', { name: '군사' });
    await mayor.getByLabel('임명할 장수').selectOption(String(memberGeneral.id));
    const assignMayor = mayor.getByRole('button', { name: '태수 임명' });
    await assignMayor.focus();
    expect((await selectCity.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await assignMayor.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await panel.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(375);
    await ruler.screenshot({ path: info.outputPath('office-mobile.png') });
    await ruler.setViewportSize({ width: 1280, height: 800 });
    await ruler.screenshot({ path: info.outputPath('office-desktop.png') });
    await ruler.setViewportSize({ width: 375, height: 812 });
    await withEngine(async () => {
      await assignMayor.press('Enter');
      await expect(mayor.getByText('관직장수 · 주재')).toBeVisible();
    });
    await strategist.getByLabel('임명할 장수').selectOption(String(candidate.id));
    await withEngine(async () => {
      await strategist.getByRole('button', { name: '군사 임명' }).click();
      await expect(strategist.getByText(`${candidate.name} · 주재`)).toBeVisible();
    });
    await member.goto(cityUrl);
    const offices = member.getByRole('region', { name: '관직 주재' });
    await expect(offices.getByText('태수 관직장수 · 주재')).toBeVisible();
    await expect(offices.getByText(`군사 ${candidate.name} · 주재`)).toBeVisible();
    await member.screenshot({ path: info.outputPath('city-office-desktop.png') });
    await member.setViewportSize({ width: 375, height: 812 });
    expect(await offices.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(375);
    await member.screenshot({ path: info.outputPath('city-office-mobile.png') });
    const { revision } = await turns(member, worldId);
    const move = await mutate<{ ok: boolean }>(member, 'turns.set', {
      worldId,
      revision,
      slots: [{ commandKey: 'move', args: { cityKey: neighbor.cityKey } }, ...Array.from({ length: 29 }, () => null)],
    });
    expect(move.ok).toBe(true);
    const own = () => hold.db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: memberGeneral.id } } });
    await loop.advanceTo((await own()).nextTurnTick);
    await expect(offices.getByText('태수 관직장수 · 부재')).toBeVisible();
    const publicRead = await query<{ officers: unknown[] }>(member, 'city.get', { worldId, cityKey: home.cityKey });
    expect(publicRead.officers).toContainEqual({
      generalId: memberGeneral.id,
      name: '관직장수',
      officerLevel: 4,
      resident: false,
    });
    expect(await own()).toMatchObject({ cityKey: neighbor.cityKey, officerLevel: 4, officerCityKey: home.cityKey });

    await ruler.reload();
    await selectCity.selectOption(String(home.cityKey));
    await expect(mayor.getByText('관직장수 · 부재')).toBeVisible();
    await withEngine(async () => {
      await strategist.getByRole('button', { name: '군사 해임' }).click();
      await expect(strategist.getByText('빈 자리')).toBeVisible();
    });
    await mayor.getByLabel('임명할 장수').selectOption(String(candidate.id));
    const replace = mayor.getByRole('button', { name: '교체 임명' });
    await replace.press('Enter');
    const confirm = mayor.getByRole('button', { name: '교체 확인' });
    await expect(confirm).toBeFocused();
    await withEngine(async () => {
      await confirm.press('Enter');
      await expect(mayor.getByText(`${candidate.name} · 주재`)).toBeVisible();
    });
    expect(await own()).toMatchObject({ officerLevel: 1, officerCityKey: null });
    await withEngine(async () => {
      await mayor.getByRole('button', { name: '태수 해임' }).click();
      await expect(mayor.getByText('빈 자리')).toBeVisible();
    });
    await member.reload();
    await expect(offices.getByText('태수 없음')).toBeVisible();

    const advisor = ruler.locator('tr[data-level="11"]');
    if (await advisor.getByRole('button', { name: '해임', exact: true }).isVisible()) {
      await withEngine(async () => {
        await advisor.getByRole('button', { name: '해임', exact: true }).click();
        await expect(advisor.getByText('빈 자리')).toBeVisible();
      });
    }
    await advisor.getByRole('button', { name: '참모 임명할 장수 고르기' }).click();
    await page.getByRole('group', { name: '참모 임명 후보' }).locator(`[data-general-id="${candidate.id}"]`).click();
    await withEngine(async () => {
      await advisor.getByRole('button', { name: '임명', exact: true }).click();
      await expect(advisor.getByText(candidate.name, { exact: true })).toBeVisible();
    });
    await member.reload();
    await expect(offices.getByText(`참모 ${candidate.name} · 주재`)).toBeVisible();
    const events = await hold.db.inputEvent.findMany({ where: { worldId, kind: 'personnel.appoint' } });
    expect(events).toHaveLength(4);
  } finally {
    await Promise.all([rulerContext.close(), memberContext.close()]);
    await releaseHold(hold);
  }
});
