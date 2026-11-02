import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './t210-fixture';
import type { AppRouter } from '../apps/server/src/router';
import type { inferRouterOutputs } from '@trpc/server';
import { TICKS_PER_MONTH } from '../packages/rules/src/index';
import { isDetailedGeneral } from '../apps/web/src/game/types';
import { officerName } from '../apps/web/src/game/names';
import { createAccount, withE2eDb } from './account';
import { holdLease, releaseHold, query } from './game';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';

// T3-10 · AC-M3-08 표의 값·정렬·모바일 조작을 정식 시나리오로 검사한다.
// 이 시험이 통과해도 전체 반응형 AC를 완료하지 않는다.
const executions = new Set<Promise<unknown>>();
test.use({ isMobile: true, hasTouch: true });
let ownWorld: string | undefined;
let ownEmail: string | undefined;
let hold: Awaited<ReturnType<typeof holdLease>> | undefined;
async function settled() {
  while (executions.size > 0) await Promise.allSettled([...executions]);
}
test.beforeEach(settled);
test.afterEach(async ({ page }) => {
  await page.close();
  await settled();
  if (hold) await releaseHold(hold);
  hold = undefined;
  await withE2eDb(async (db) => {
    if (ownWorld) await db.world.deleteMany({ where: { id: ownWorld } });
    if (ownEmail) await db.user.deleteMany({ where: { email: ownEmail } });
  });
  ownWorld = ownEmail = undefined;
});

async function targetSizes(targets: Locator) {
  return targets.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const label = element.matches('input[type="radio"],input[type="checkbox"]') ? element.closest('label') : null;
      const rect = (label ?? element).getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      return [
        {
          name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40),
          width: rect.width,
          height: rect.height,
        },
      ];
    }),
  );
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function tapTargets(targets: Locator) {
  await expect(targets.first()).toBeVisible();
  const sizes = await targetSizes(targets);
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.filter((size) => size.width < 44 || size.height < 44)).toEqual([]);
}

type Out = inferRouterOutputs<AppRouter>;
const number = (value: number) => value.toLocaleString('ko-KR');
type General = Out['city']['get']['generals'][number] | Out['nation']['get']['generals'][number];
const stats = [
  ['통솔', 'leadership'],
  ['무력', 'strength'],
  ['지력', 'intel'],
  ['정치', 'politics'],
  ['매력', 'charm'],
] as const;
function expectedDetails(general: General, kind: 'city' | 'nation', cities: Map<number, string>) {
  const detailed = isDetailedGeneral(general);
  const hidden = kind === 'city' ? '다른 국가 장수입니다' : '다른 국가 정보';
  const numeric = (value: number | undefined) =>
    detailed ? (value === undefined ? '—' : number(value)) : `— (${hidden})`;
  const army = detailed
    ? 'commandedArmy' in general
      ? general.commandedArmy
      : { troops: general.crew, train: general.train, atmos: general.atmos }
    : undefined;
  const fields: [string, string][] =
    kind === 'nation'
      ? [
          ['직책', detailed ? officerName(general.officerLevel, general.nationId !== null) : '—'],
          ['위치', detailed ? String(cities.get(general.cityKey) ?? general.cityKey) : '—'],
        ]
      : [];
  for (const [label, key] of stats) fields.push([label, numeric(detailed ? general[key] : undefined)]);
  fields.push(['평균 훈련', numeric(army?.train)], ['평균 사기', numeric(army?.atmos)]);
  if (kind === 'nation') {
    const care: string[] = [];
    if (detailed && general.injury > 0) care.push(`부상 ${general.injury}`);
    if (army && army.troops > 0 && army.train < 50) care.push('훈련 부족');
    if (army && army.troops > 0 && army.atmos < 50) care.push('사기 부족');
    fields.push(['관리', care.join('')]);
  }
  return { name: general.name, fields, troops: detailed ? numeric(army?.troops) : '—' };
}
async function assertMobileDetails(
  table: Locator,
  generals: readonly General[],
  kind: 'city' | 'nation',
  cities: Map<number, string>,
) {
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(generals.length);
  await expect
    .poll(() =>
      rows.evaluateAll((els) =>
        els.map((el) => ({
          name: el.querySelector('td')!.firstChild!.textContent,
          fields: Array.from(el.querySelectorAll('dl > div'), (item) => [
            item.querySelector('dt')!.textContent,
            item.querySelector('dd')!.textContent,
          ]),
          troops: el.querySelector('td:last-child')!.textContent,
        })),
      ),
    )
    .toEqual(generals.map((g) => expectedDetails(g, kind, cities)));
}
async function tableGeometry(table: Locator, mobile: boolean) {
  const name = (await table.getAttribute('aria-label')) ?? (await table.locator('caption').textContent());
  expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${name} 표 너비`).toBe(true);
  const wrapper = table.locator('..');
  expect(await wrapper.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${name} 표 바깥상자 너비`).toBe(true);
  expect(
    await table.locator('td.num').evaluateAll((els) => els.every((el) => getComputedStyle(el).whiteSpace === 'nowrap')),
  ).toBe(true);
  if (mobile) {
    await tapTargets(wrapper.locator('button,select,a'));
    for (const input of await wrapper.locator('select').all()) await expect(input).toHaveCSS('font-size', '16px');
  }
}
async function statValue(row: Locator, label: string, value: string, mobile: boolean, index: number) {
  if (mobile)
    await expect(
      row
        .locator('dl > div')
        .filter({ has: row.page().getByText(label, { exact: true }) })
        .locator('dd'),
    ).toHaveText(value);
  else await expect(row.locator('td').nth(index)).toHaveText(value);
}

test('T3-10 정식191년 도시·국가·월간 순위 표의 모든 값·정렬·375px와 초안 보존', async ({ page }, info) => {
  test.setTimeout(120000);
  const execution = (async () => {
    const initial = await loadInitialWorld({
      scenario: 'integration191',
      map: 'integration',
      statRules: 'five-stats',
      portraitMap: '191-map',
      seed: 'mobile-tables-191',
    });
    initial.ruleFeatures = [
      'campaign-v1',
      'five-stats',
      'operational-map',
      'personnel',
      'policy',
      'stratagem-basic',
      'treaty',
    ];
    expect(initial.generals).toHaveLength(491);
    expect(initial.nations).toHaveLength(21);
    ownWorld = (
      await withE2eDb((db) =>
        saveInitialWorld(db, initial, { name: '모바일 표 정식191', turnTermMinutes: 60, endYear: 201 }),
      )
    ).worldId;
    hold = await holdLease(ownWorld);
    await controlClock(hold.db, ownWorld, 'start');
    ownEmail = `tables-${randomUUID()}@example.test`;
    await createAccount(page, ownEmail);
    await page.goto(`/w/${ownWorld}/create`);
    await page.getByLabel('이름', { exact: true }).fill('표검사장수');
    await page.getByRole('button', { name: '장수 만들기', exact: true }).click();
    await expect
      .poll(() =>
        hold!.db.inputEvent.count({ where: { worldId: ownWorld, kind: 'general.create', status: 'PENDING' } }),
      )
      .toBe(1);
    await new TurnLoop(hold.db, hold.lease).advanceTo(0);
    await expect(page.getByRole('heading', { name: '군략도', exact: true })).toBeVisible();
    const first = await hold.db.general.findFirstOrThrow({ where: { worldId: ownWorld, user: { email: ownEmail } } });
    const reservation = await page.request.post('/trpc/turns.set', {
      headers: { Origin: new URL(page.url()).origin },
      data: {
        worldId: ownWorld,
        revision: 0,
        slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...Array.from({ length: 29 }, () => null)],
      },
    });
    expect(reservation.status()).toBe(200);
    await new TurnLoop(hold.db, hold.lease).advanceTo(first.nextTurnTick);
    const actor = await hold.db.general.findFirstOrThrow({ where: { worldId: ownWorld, user: { email: ownEmail } } });
    expect(actor.nationId).toBe(1);
    const main = `/w/${ownWorld}?city=${actor.cityKey}`;
    await page.goto(main);
    const editor = page.getByTestId('turn-editor');
    await editor.getByRole('button', { name: '선택 해제', exact: true }).click();
    await editor.locator('tr[data-slot="30"]').click();
    await editor.getByLabel('명령 찾기').fill('농지 개간');
    await editor.getByRole('radio', { name: '농지 개간', exact: true }).check();
    await editor.getByRole('button', { name: '30번 칸에 넣기', exact: true }).click();
    const turns = await hold.db.generalTurn.findMany({
      where: { worldId: ownWorld, generalId: actor.id },
      orderBy: { slot: 'asc' },
    });
    const city = await query<Out['city']['get']>(page, 'city.get', { worldId: ownWorld, cityKey: actor.cityKey });
    const nation = await query<Out['nation']['get']>(page, 'nation.get', { worldId: ownWorld, nationId: 1 });
    const own = city.generals.find((g) => g.id === actor.id)!;
    expect(isDetailedGeneral(own)).toBe(true);
    const measurements = [];
    for (const width of [375, 390, 768, 1440]) {
      const mobile = width < 768;
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: '소속 장수·도시 펼치기', exact: true }).click();
      const garrison = page.getByRole('table', { name: /^주둔 장수/ });
      const generals = page.getByRole('table', { name: /^소속 장수/ });
      const cities = page.getByRole('table', { name: /^소유 도시/ });
      await expect(generals.locator('tbody tr')).toHaveCount(nation.generals.length);
      for (const table of [garrison, generals, cities]) await tableGeometry(table, mobile);
      await noOverflow(page);
      if (mobile) {
        expect(city.generals.some((g) => !isDetailedGeneral(g))).toBe(true);
        await assertMobileDetails(garrison, city.generals, 'city', new Map());
        await assertMobileDetails(
          generals,
          nation.generals,
          'nation',
          new Map(nation.cities.map((c) => [c.key, c.name])),
        );
        expect(await cities.locator('tbody tr td:first-child').allTextContents()).toEqual(
          nation.cities.map((c) => c.name),
        );
      }
      const ownRow = garrison
        .locator('tbody tr')
        .filter({ has: page.locator('td:first-child').filter({ hasText: '표검사장수' }) });
      if (!isDetailedGeneral(own)) throw new Error('자기 장수 공개 계약 오류');
      for (const [label, key, index] of [
        ['통솔', 'leadership', 2],
        ['무력', 'strength', 3],
        ['지력', 'intel', 4],
        ['정치', 'politics', 5],
        ['매력', 'charm', 6],
      ] as const)
        await statValue(ownRow, label, number(own[key]!), mobile, index);
      if (mobile) {
        const select = generals.locator('..').getByRole('combobox');
        await select.selectOption('intel');
        await expect(generals.locator('..').getByRole('button', { name: /정렬 방향 내림차순, 바꾸기$/ })).toHaveText(
          '내림차순',
        );
        const expected = [...nation.generals]
          .sort((a, b) => {
            const av = isDetailedGeneral(a) ? a.intel : null,
              bv = isDetailedGeneral(b) ? b.intel : null;
            return av === null || bv === null ? (av === bv ? 0 : av === null ? 1 : -1) : bv - av;
          })
          .map((g) => g.name);
        expect(
          await generals
            .locator('tbody tr > td:first-child')
            .evaluateAll((els) => els.map((el) => el.firstChild!.textContent)),
        ).toEqual(expected);
        await page.setViewportSize({ width: 768, height: 900 });
        await expect(generals.getByRole('columnheader', { name: /^지력/ })).toHaveAttribute('aria-sort', 'descending');
        await page.setViewportSize({ width, height: 900 });
        await expect(select).toHaveValue('intel');
        await select.selectOption('');
      }
      measurements.push({ width, cityRows: city.generals.length, nationRows: nation.generals.length });
      await page.screenshot({ path: info.outputPath(`formal-tables-${width}.png`), fullPage: true });
      for (const [name, table] of [
        ['garrison', garrison],
        ['nation', generals],
        ['cities', cities],
      ] as const) {
        await table.locator('caption').scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`formal-${name}-viewport-${width}.png`) });
      }
      await page.getByRole('button', { name: '소속 장수·도시 접기', exact: true }).click();
      await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    }
    expect(
      await hold.db.generalTurn.findMany({
        where: { worldId: ownWorld, generalId: actor.id },
        orderBy: { slot: 'asc' },
      }),
    ).toEqual(turns);
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/w/${ownWorld}/nation/2`);
      const other = await query<Out['nation']['get']>(page, 'nation.get', { worldId: ownWorld, nationId: 2 });
      expect(other.generals.length).toBeGreaterThan(0);
      expect(other.generals.every((g) => !isDetailedGeneral(g))).toBe(true);
      const table = page.getByRole('table', { name: /^소속 장수/ });
      await assertMobileDetails(table, other.generals, 'nation', new Map());
      await expect(
        page.getByRole('note').filter({ hasText: '다른 국가 정보라 장수 수치와 국고는 보이지 않습니다.' }),
      ).toBeVisible();
      await tableGeometry(table, true);
      await noOverflow(page);
    }
    // 첫 월간 정산도 정식 엔진으로 실행한다. 순위 응답을 합성하거나 DB에 순위를 쓰지 않는다.
    await new TurnLoop(hold.db, hold.lease).advanceTo(TICKS_PER_MONTH);
    for (const tab of ['generals', 'nations'] as const) {
      const by = tab === 'generals' ? 'dedication' : 'cities';
      await page.goto(`/w/${ownWorld}/ranking?tab=${tab}&by=${by}`);
      const table = page.getByRole('table', { name: tab === 'generals' ? '장수 순위' : '국가 순위' });
      await expect(table).toBeVisible();
      for (const width of [375, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await tableGeometry(table, width < 768);
        await noOverflow(page);
        if (width < 768) {
          const keys =
            tab === 'generals'
              ? (['dedication', 'experience', 'merit'] as const)
              : (['cities', 'generals', 'power'] as const);
          const labels = tab === 'generals' ? ['공헌', '경험', '전공'] : ['도시', '장수', '국력'];
          for (const [index, key] of keys.entries()) {
            await page
              .getByRole('group', { name: `${tab === 'generals' ? '장수' : '국가'} 순위 정렬` })
              .getByRole('button', { name: new RegExp(`^${labels[index]}(?: ▼)?$`) })
              .click();
            await expect(page).toHaveURL(`/w/${ownWorld}/ranking?tab=${tab}&by=${key}`);
            if (tab === 'generals') {
              const data = await query<Out['ranking']['generals']>(page, 'ranking.generals', {
                worldId: ownWorld,
                by: key,
              });
              await expect(table.locator('tbody').first().locator('tr')).toHaveCount(data.top.length);
              await expect(table.locator('tbody').first().locator('tr td:nth-child(2) > span:first-child')).toHaveText(
                data.top.map((r) => r.name),
              );
              await expect(table.locator('tbody').first().locator('tr td:nth-child(2) dl dd')).toHaveText(
                data.top.flatMap((r) => [number(r.dedication), number(r.experience), number(r.merit)]),
              );
              expect(data.me).not.toBeNull();
              if (data.me) {
                await page.getByRole('button', { name: '내 순위로', exact: true }).click();
                await expect(table.locator('tr[data-me="true"]')).toBeFocused();
              }
            } else {
              const data = await query<Out['ranking']['nations']>(page, 'ranking.nations', {
                worldId: ownWorld,
                by: key,
              });
              await expect(table.locator('tbody tr')).toHaveCount(data.items.length);
              await expect(table.locator('tbody tr td:nth-child(2) > span')).toHaveText(data.items.map((r) => r.name));
              await expect(table.locator('tbody tr td:nth-child(2) dl dd')).toHaveText(
                data.items.flatMap((r) => [number(r.cities), number(r.generals), number(r.power)]),
              );
            }
          }
        }
        await page.screenshot({ path: info.outputPath(`formal-ranking-${tab}-${width}.png`), fullPage: true });
        await table.locator('thead').scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`formal-ranking-${tab}-viewport-${width}.png`) });
      }
    }
    await page.goto(main);
    await expect(editor.getByTestId('draft-state')).toHaveText('저장하지 않은 편집 1건');
    await expect(editor.locator('tr[data-slot="30"]')).toContainText('농지 개간');
    expect(await hold.db.general.count({ where: { worldId: ownWorld, userId: null } })).toBe(491);
    await writeFile(
      info.outputPath('formal-tables-measurements.json'),
      JSON.stringify({ measurements, formalScenario: true, wholeResponsiveAcPassed: false }, null, 2),
    );
  })();
  executions.add(execution);
  void execution.finally(() => executions.delete(execution)).catch(() => undefined);
  await execution;
});
