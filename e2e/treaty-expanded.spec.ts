import { expect, test } from '@playwright/test';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { createAccount, withE2eDb } from './account';
import { holdLease, releaseHold } from './game';

test('AC-M2-06 두 군주가 실제 통행·정기 원조·도시 이양 조약을 제안하고 수락한다', async ({ browser }) => {
  test.setTimeout(120_000);
  const { worldId } = await withE2eDb(async (db) => {
    const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'expanded-treaty-browser' });
    return saveInitialWorld(db, initial, {
      name: 'E2E 확장 조약',
      turnTermMinutes: 120,
      endYear: 300,
      replayFormat: 3,
      ruleFeatures: ['treaty', 'treaty-break', 'treaty-expanded', 'treaty-trade'],
    });
  });
  const hold = await holdLease(worldId);
  const applyNextInput = async () => {
    if (hold.lost) throw hold.lost;
    let elapsed = 0;
    const batch = await new TurnLoop(hold.db, hold.lease, { elapsedNow: () => elapsed++ * 1000 }).poll();
    expect(batch.executions).toEqual([]);
  };
  const fromContext = await browser.newContext({ viewport: { width: 375, height: 850 } });
  const toContext = await browser.newContext();
  try {
    const fromPage = await fromContext.newPage();
    const toPage = await toContext.newPage();
    const fromEmail = await createAccount(fromPage);
    const toEmail = await createAccount(toPage);
    const nations = await hold.db.nation.findMany({
      where: { worldId, capitalCityKey: { not: null } },
      orderBy: { id: 'asc' },
    });
    const cities = await hold.db.city.findMany({ where: { worldId }, orderBy: { cityKey: 'asc' } });
    const transfer = cities.find(
      (city) =>
        city.kind !== 'PASS' &&
        nations.some((nation) => nation.id === city.nationId && nation.capitalCityKey !== city.cityKey),
    )!;
    const to = nations.find((nation) => nation.id === transfer.nationId)!;
    const relations = await hold.db.diplomacy.findMany({
      where: { worldId, OR: [{ nationA: to.id }, { nationB: to.id }] },
    });
    const from = nations.find(
      (nation) =>
        nation.id !== to.id && relations.every((row) => row.nationA !== nation.id && row.nationB !== nation.id),
    )!;
    const passage = cities.find((city) => city.cityKey === to.capitalCityKey)!;
    expect(passage.kind).not.toBe('PASS');
    for (const [nation, email] of [
      [from, fromEmail],
      [to, toEmail],
    ] as const) {
      const actor = await hold.db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      const ruler = await hold.db.general.findFirstOrThrow({
        where: { worldId, nationId: nation.id, officerLevel: 12 },
      });
      await hold.db.general.update({ where: { worldId_id: { worldId, id: ruler.id } }, data: { userId: actor.id } });
      await hold.db.nation.update({
        where: { worldId_id: { worldId, id: nation.id } },
        data: { isNpc: false, gold: 100_000, rice: 100_000 },
      });
    }
    await controlClock(hold.db, worldId, 'start');
    await fromPage.goto(`/w/${worldId}/diplomacy?tab=write`);
    const form = fromPage.getByRole('form', { name: '조약서 쓰기' });
    await form.getByLabel('상대', { exact: true }).selectOption(String(to.id));
    await form.getByRole('checkbox', { name: '통행 허용', exact: true }).check();
    await form.getByRole('checkbox', { name: `${passage.name} (${to.name})`, exact: true }).check();
    await form.getByLabel('통행 기간(개월)', { exact: true }).fill('6');
    await form.getByRole('checkbox', { name: '정기 원조', exact: true }).check();
    await form.getByRole('combobox', { name: '원조를 보내는 국가', exact: true }).selectOption(String(to.id));
    await form.getByLabel('매달 금', { exact: true }).fill('300');
    await form.getByLabel('매달 쌀', { exact: true }).fill('500');
    await form.getByLabel('원조 기간(개월)', { exact: true }).fill('3');
    await form.getByRole('checkbox', { name: '도시 이양', exact: true }).check();
    const transferChoice = form.getByRole('combobox', { name: '이양할 도시', exact: true });
    await expect(transferChoice.getByRole('option', { name: `${passage.name} (${to.name})`, exact: true })).toHaveCount(
      0,
    );
    await transferChoice.selectOption(String(transfer.cityKey));
    await expect(fromPage.getByTestId('treaty-cost')).toContainText('예상 비용 우리 금');
    expect(await fromPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const propose = form.getByRole('button', { name: '제안 보내기', exact: true });
    await propose.press('Enter');
    const pending = (kind: string) => hold.db.inputEvent.count({ where: { worldId, kind, status: 'PENDING' } });
    await expect.poll(() => pending('treaty.propose')).toBe(1);
    await applyNextInput();
    await expect(fromPage.getByTestId('treaty-requests')).toContainText('제안을 보냈습니다');

    await toPage.goto(`/w/${worldId}/diplomacy?tab=incoming`);
    const card = toPage.getByTestId('treaty-card');
    await expect(card).toContainText(`통행 허용 6개월 · ${passage.name}`);
    await expect(card).toContainText(`정기 원조 3개월 · ${to.name} → ${from.name} · 매달 금 300 · 쌀 500`);
    await expect(card).toContainText(`도시 이양 · ${to.name}의 ${transfer.name} → ${from.name} · 수락 즉시`);
    await card.getByRole('button', { name: '수락', exact: true }).click();
    await expect.poll(() => pending('treaty.respond')).toBe(1);
    await applyNextInput();
    await expect(toPage.getByTestId('treaty-requests')).toContainText('조약을 맺었습니다');
    const current = await hold.db.city.findUniqueOrThrow({
      where: { worldId_cityKey: { worldId, cityKey: transfer.cityKey } },
    });
    expect(current.nationId).toBe(from.id);
    await expect(
      transferChoice.getByRole('option', { name: `${transfer.name} (${from.name})`, exact: true }),
    ).toHaveCount(1);
    await expect(transferChoice).toHaveValue('');
    const stored = await hold.db.treaty.findFirstOrThrow({
      where: { worldId, fromNationId: from.id, toNationId: to.id },
    });
    expect(stored).toMatchObject({
      status: 'ACTIVE',
      clauses: expect.arrayContaining([
        { kind: 'passage', cityKeys: [passage.cityKey], months: 6 },
        { kind: 'tribute', payerNationId: to.id, gold: 300, rice: 500, months: 3 },
        { kind: 'cityTransfer', cityKey: transfer.cityKey, giverNationId: to.id },
      ]),
    });
    await toPage.goto(`/w/${worldId}/diplomacy?tab=active`);
    await expect(toPage.getByTestId('treaty-card')).toContainText('진행 중');
  } finally {
    await Promise.all([fromContext.close(), toContext.close()]);
    await releaseHold(hold);
  }
});
