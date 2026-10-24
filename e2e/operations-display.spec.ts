import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { InspectionRow, OperationDetail } from '../apps/web/src/operations/contract';
import { createAccount, withE2eDb } from './account';
import { createGeneralByApi, idleWorld, mutate, query, releaseIdleWorld, startEngine } from './game';

// T2-12 · AC-M2-15 화면 증거 보완. 준비 부족의 미흡 표시와 작전·감찰 공개 범위를 실제 API와 화면으로 본다.
// 계약은 AppRouter의 operation·inspection 라우터다. 응답 가로채기, 가짜 응답, 초상 stub은 쓰지 않는다.
// 장수 생성 요청을 처리한 뒤 엔진을 멈춘다. 판정은 예턴만 본 예상이라 실제 출병·전투 실행의 증거가 아니다.
// 이 시험은 부모가 배정한 격리 슬롯에서만 돌리고 그 전에는 증거로 세지 않는다.
// 기록: docs/plans/T2-12.md "작전판 표시 증거 보완" 절.

// 원 e2e/operations.spec.ts와 같은 값이다. 새로 늘린 시간이 아니다.
test.describe.configure({ timeout: 180_000 });

const TICKS_PER_MONTH = 10_000;
// 기준값은 시험이 정한 상수다. 응답의 min에서 가져오지 않는다.
const MIN = { crew: 1000, train: 60, atmos: 60 };

interface Readiness {
  crew: number;
  train: number;
  atmos: number;
}
interface GameDate {
  year: number;
  month: number;
}
interface City {
  key: number;
  name: string;
  nationId: number | null;
}
interface Member {
  page: Page;
  generalId: number;
  name: string;
}
type SlotInput = { commandKey: string; args?: Record<string, unknown> } | null;
interface StoredTurn {
  commandKey: string;
  args: unknown;
  explicit: boolean;
}
// AppRouter 출력의 칸 모양. args가 선택 값이다.
interface ApiTurn {
  commandKey: string;
  args?: unknown;
  explicit: boolean;
}
interface Label {
  kind: 'empty' | 'rest' | 'command';
  text: string;
}
interface Prepared extends Label {
  input: SlotInput;
}

const EMPTY_TURN: StoredTurn = { commandKey: 'rest', args: {}, explicit: false };
const EMPTY_SLOT_TITLE = '비워 둔 칸입니다. 그 장수의 기본 방침대로 실행합니다.';

const monthIndex = (date: GameDate) => date.year * 12 + date.month - 1;
const monthAfter = (date: GameDate, count: number): GameDate => {
  const at = monthIndex(date) + count;
  return { year: Math.floor(at / 12), month: (at % 12) + 1 };
};
const shortDate = (date: GameDate) => `${date.year}.${date.month}`;
const stored = (input: SlotInput): StoredTurn =>
  input === null ? EMPTY_TURN : { commandKey: input.commandKey, args: input.args ?? {}, explicit: true };
const pick = (turn: ApiTurn): StoredTurn => ({
  commandKey: turn.commandKey,
  args: turn.args ?? {},
  explicit: turn.explicit,
});
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cityName = (cities: City[], key: number) => {
  const city = cities.find((c) => c.key === key);
  if (!city) throw new Error(`world.map에 없는 도시입니다: ${key}`);
  return city.name;
};

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  } finally {
    await releaseIdleWorld();
  }
});

// 원 operations.spec의 member와 같은 순서로 만든다. 초상 stub은 부르지 않는다.
// 시험 fixture 전용: 이 시험이 실제 general.create로 만든 장수 행 하나의 소속·직책·도시·병력만 정한다.
async function member(browser: Browser, world: string, nationId: number, officerLevel: number): Promise<Member> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await createAccount(page);
  const stop = await startEngine(world);
  const general = await (async () => {
    try {
      return await createGeneralByApi(page, world);
    } finally {
      await stop();
    }
  })();
  await withE2eDb(async (db) => {
    const city = await db.city.findFirstOrThrow({ where: { worldId: world, nationId }, select: { cityKey: true } });
    await db.general.update({
      where: { worldId_id: { worldId: world, id: general.id } },
      data: { nationId, officerLevel, cityKey: city.cityKey, crew: 0 },
    });
  });
  return { page, generalId: general.id, name: general.name };
}

// 시험 fixture 전용: 이 시험이 만든 장수 행 하나의 다음 턴 tick과 병력·훈련·사기만 바꾼다.
// 다른 열, 다른 장수, 월드 시계, 예상·판정·로그 값은 쓰지 않는다.
async function shape(world: string, generalId: number, data: Readiness & { nextTurnTick: number }) {
  await withE2eDb((db) => db.general.update({ where: { worldId_id: { worldId: world, id: generalId } }, data }));
}

async function setup(page: Page) {
  await createAccount(page);
  const world = await idleWorld(page);
  const map = await query<{ cities: City[]; nations: Array<{ id: number }> }>(page, 'world.map', { worldId: world });
  const summary = await query<{ gameDate: GameDate }>(page, 'world.summary', { worldId: world });
  const [ours, theirs] = map.nations;
  const target = map.cities.find((c) => c.nationId === theirs!.id)!;
  const home = map.cities.find((c) => c.nationId === ours!.id)!;
  const other = map.cities.find((c) => c.key !== target.key && c.key !== home.key)!;
  return {
    world,
    ours: ours!.id,
    theirs: theirs!.id,
    cities: map.cities,
    target,
    home,
    other,
    targetDate: monthAfter(summary.gameDate, 17),
  };
}

// 시각 기준은 world.summary 한 응답이다. 생성 뒤 엔진을 멈춘 상태에서 다음 달 첫 tick을 정한다.
async function clock(page: Page, world: string) {
  const summary = await query<{ gameDate: GameDate; nowTick: number }>(page, 'world.summary', { worldId: world });
  const nextTurnTick = (Math.floor(summary.nowTick / TICKS_PER_MONTH) + 1) * TICKS_PER_MONTH;
  return { gameDate: summary.gameDate, nowTick: summary.nowTick, nextTurnTick };
}

// 실제 turns.set으로 30칸을 저장하고 turns.get이 넣은 값 그대로 돌려주는지 본다.
async function saveQueue(page: Page, world: string, inputs: SlotInput[]) {
  expect(inputs).toHaveLength(30);
  const before = await query<{ revision: number }>(page, 'turns.get', { worldId: world });
  const saved = await mutate<{ ok: boolean }>(page, 'turns.set', {
    worldId: world,
    revision: before.revision,
    slots: inputs,
  });
  expect(saved.ok).toBe(true);
  const after = await query<{ slots: StoredTurn[] }>(page, 'turns.get', { worldId: world });
  expect(after.slots.map(pick)).toEqual(inputs.map(stored));
}

// 장수마다 따로 정한 30칸. 모병 수량이 장수마다 달라 줄이 섞이면 글자로 드러난다.
// 기대 글자는 명령 이름과 인자를 시험이 직접 적은 값이다. 화면의 slotLabel·describeArgs에서 만들지 않는다.
function queue(base: number, move: City, target: City): Prepared[] {
  return Array.from({ length: 30 }, (_, i): Prepared => {
    if (i === 29)
      return {
        input: { commandKey: 'attack', args: { cityKey: target.key } },
        kind: 'command',
        text: `출병 ${target.name}`,
      };
    switch (i % 6) {
      case 0:
        return {
          input: { commandKey: 'recruit', args: { amount: base + i, crewType: 1 } },
          kind: 'command',
          text: `모병 수량 ${base + i} · 병종 번호 1`,
        };
      case 1:
        return { input: { commandKey: 'train' }, kind: 'command', text: '훈련' };
      case 2:
        return { input: null, kind: 'empty', text: '빈 칸' };
      case 3:
        return {
          input: { commandKey: 'move', args: { cityKey: move.key } },
          kind: 'command',
          text: `이동 ${move.name}`,
        };
      case 4:
        return { input: { commandKey: 'rest' }, kind: 'rest', text: '휴식' };
      default:
        return { input: { commandKey: 'morale' }, kind: 'command', text: '사기진작' };
    }
  });
}

// T2-05 직책 표 (12 군주, 11 참모, 5~10 수뇌, 나머지 일반).
const officerText = (level: number) => (level >= 12 ? '군주' : level === 11 ? '참모' : level >= 5 ? '수뇌' : '일반');

// 시험이 준비하지 않은 국가원(원 fixture NPC 등)의 앞 5칸 대조표. DB에 저장된 칸에서 글자를 정한다.
// 표에 없는 명령이나 인자 모양이면 짐작하지 않고 실패한다.
const NO_ARG_NAMES: Record<string, string> = {
  train: '훈련',
  morale: '사기진작',
  farm: '농지 개간',
  commerce: '상업 투자',
  security: '치안 강화',
  settle: '정착 장려',
};
const CITY_ARG_NAMES: Record<string, string> = { attack: '출병', move: '이동' };
const RECRUIT_NAMES: Record<string, string> = { recruit: '모병', conscript: '징병' };
function knownLabel(turn: StoredTurn, cities: City[]): Label {
  if (!turn.explicit) return { kind: 'empty', text: '빈 칸' };
  const args = (turn.args ?? {}) as Record<string, unknown>;
  const keys = Object.keys(args).sort().join(',');
  const noArg = NO_ARG_NAMES[turn.commandKey];
  const cityArg = CITY_ARG_NAMES[turn.commandKey];
  const recruit = RECRUIT_NAMES[turn.commandKey];
  if (turn.commandKey === 'rest' && keys === '') return { kind: 'rest', text: '휴식' };
  if (noArg && keys === '') return { kind: 'command', text: noArg };
  if (cityArg && keys === 'cityKey' && typeof args.cityKey === 'number')
    return { kind: 'command', text: `${cityArg} ${cityName(cities, args.cityKey)}` };
  if (recruit && keys === 'amount,crewType')
    return { kind: 'command', text: `${recruit} 수량 ${String(args.amount)} · 병종 번호 ${String(args.crewType)}` };
  throw new Error(`감찰 대조표에 없는 예턴입니다: ${turn.commandKey}`);
}

interface Snapshot {
  id: number;
  name: string;
  officerLevel: number;
  userId: string | null;
  cityKey: number;
  crew: number;
  train: number;
  atmos: number;
  turns: StoredTurn[];
}

// 이 월드 한 국가의 장수 전원과 앞 5칸을 DB에서 읽기만 한다. 감찰 응답과 따로 만든 대조 기준이다.
async function nationSnapshot(world: string, nationId: number): Promise<Snapshot[]> {
  return withE2eDb(async (db) => {
    const generals = await db.general.findMany({
      where: { worldId: world, nationId },
      select: {
        id: true,
        name: true,
        officerLevel: true,
        userId: true,
        cityKey: true,
        crew: true,
        train: true,
        atmos: true,
      },
      orderBy: { id: 'asc' },
    });
    const rows = await db.generalTurn.findMany({
      where: { worldId: world, generalId: { in: generals.map((g) => g.id) }, slot: { lt: 5 } },
      select: { generalId: true, slot: true, commandKey: true, args: true, explicit: true },
    });
    return generals.map((general) => ({
      ...general,
      turns: Array.from({ length: 5 }, (_, slot) => {
        const row = rows.find((r) => r.generalId === general.id && r.slot === slot);
        return row ? { commandKey: row.commandKey, args: row.args, explicit: row.explicit } : EMPTY_TURN;
      }),
    }));
  });
}

// 감찰 행 머리 글자. NPC는 이름 뒤에 NPC 표지가 붙는다(InspectionPage.tsx:119-127).
const headText = (g: Snapshot) => (g.userId === null ? `${g.name} NPC` : g.name);

const timelineOf = (page: Page) => page.getByTestId('operation-timeline');

// 출병을 0번 칸에 두면 그 앞에서 바뀌는 칸이 없어 예상값은 fixture로 정한 값 그대로다(timeline.ts:89-93, forecast.ts:18-19).
// 출병 tick은 다음 달 첫 tick이고 목표는 지금+17개월 첫 tick이라 늦음이 될 수 없다. 출병이 있어 없음도 될 수 없다.
interface Shortage {
  label: string;
  short: keyof Readiness;
  current: Readiness;
  shown: [string, string, string];
}
const SHORTAGES: Shortage[] = [
  { label: '병력', short: 'crew', current: { crew: 100, train: 100, atmos: 100 }, shown: ['100', '100', '100'] },
  { label: '훈련', short: 'train', current: { crew: 1000, train: 10, atmos: 100 }, shown: ['1,000', '10', '100'] },
  { label: '사기', short: 'atmos', current: { crew: 1000, train: 100, atmos: 10 }, shown: ['1,000', '100', '10'] },
];

test.describe('작전판 표시', () => {
  for (const c of SHORTAGES) {
    test(`${c.label}만 기준보다 낮고 출병이 목표 전이면 서버와 화면 모두 미흡이다`, async ({
      browser,
      page,
    }, testInfo) => {
      // 시험 값 자체의 확인. 고른 하나만 기준 미달이고 나머지 둘은 기준 이상이다.
      for (const key of ['crew', 'train', 'atmos'] as const) expect(c.current[key] < MIN[key]).toBe(key === c.short);

      const s = await setup(page);
      const actor = await member(browser, s.world, s.ours, 5);
      const now = await clock(actor.page, s.world);
      const ahead = monthIndex(s.targetDate) - monthIndex(now.gameDate);
      expect(ahead).toBeGreaterThan(1);
      expect(ahead).toBeLessThanOrEqual(30);
      const firstTick = (Math.floor(now.nowTick / TICKS_PER_MONTH) + ahead) * TICKS_PER_MONTH;

      await shape(s.world, actor.generalId, { nextTurnTick: now.nextTurnTick, ...c.current });
      const sortieOnly = Array.from({ length: 30 }, (_, i): SlotInput =>
        i === 0 ? { commandKey: 'attack', args: { cityKey: s.target.key } } : null,
      );
      await saveQueue(actor.page, s.world, sortieOnly);
      const op = await mutate<{ id: string }>(actor.page, 'operation.create', {
        worldId: s.world,
        targetCityKey: s.target.key,
        targetYear: s.targetDate.year,
        targetMonth: s.targetDate.month,
        min: MIN,
        memberIds: [actor.generalId],
      });

      const detail = await query<OperationDetail>(actor.page, 'operation.get', { worldId: s.world, id: op.id });
      expect(detail.min).toEqual(MIN);
      expect(detail.targetDate).toEqual(s.targetDate);
      expect(detail.targetTick).toBe(firstTick);
      expect(detail.target.cityKey).toBe(s.target.key);
      expect(detail.timeline.map((m) => m.generalId)).toEqual([actor.generalId]);
      expect(detail.members).toBe(1);
      expect(detail.ready).toBe(0);
      const line = detail.timeline[0]!;
      expect(line.beyondWindow).toBe(false);
      expect(line.sortie?.slot).toBe(0);
      expect(line.sortie?.tick).toBe(now.nextTurnTick);
      expect(line.sortie!.tick).toBeLessThan(firstTick);
      expect(line.sortie?.date).toEqual(monthAfter(now.gameDate, 1));
      expect(line.sortie?.turn.commandKey).toBe('attack');
      expect(line.sortie?.turn.args).toEqual({ cityKey: s.target.key });
      expect(line.expected).toEqual(c.current);
      expect(line.verdict).toBe('WEAK');

      await actor.page.goto(`/w/${s.world}/operations/${op.id}`);
      await expect(actor.page.getByText('기준 병력 1,000 · 훈련 60 · 사기 60', { exact: true })).toBeVisible();
      await expect(actor.page.getByText('준비 0 / 참여 1', { exact: true })).toBeVisible();
      const row = timelineOf(actor.page).locator(`tbody tr[data-general-id="${actor.generalId}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-verdict', 'WEAK');
      const verdict = row.locator('td').first();
      await expect(verdict.locator('[data-tone]')).toHaveText('△ 미흡');
      await expect(verdict.locator('[data-tone]')).toHaveAttribute('data-tone', 'warning');
      await expect(verdict.locator('span.num')).toHaveText(
        `예상 병력 ${c.shown[0]} · 훈련 ${c.shown[1]} · 사기 ${c.shown[2]}`,
      );
      // 기준 미달 값만 경고 글꼴(굵기 600)이고 나머지 둘은 보통 굵기다(OperationDetailPage.tsx:241,283-290).
      const values = verdict.locator('span.num > span');
      await expect(values).toHaveText(c.shown);
      for (const [i, key] of (['crew', 'train', 'atmos'] as const).entries())
        await expect(values.nth(i)).toHaveCSS('font-weight', key === c.short ? '600' : '400');

      // 출병 칸은 목표 전 6개월 밖이라 기본 열에 없다. 앞의 달을 펼친 뒤 1번 칸에 출병과 목표 도시가 보인다.
      await expect(row.locator('td[data-slot="1"]')).toHaveCount(0);
      await actor.page.getByRole('button', { name: /^앞의 \d+개월 더 보기$/ }).click();
      await expect(row.locator('td[data-slot="1"]')).toHaveText(`출병 ${s.target.name}`);
      await row.screenshot({ path: testInfo.outputPath(`weak-${c.short}.png`) });
    });
  }

  test('일반 참여자는 다른 참여자의 30칸 명령과 인자를 보고 직책자는 감찰로 국가원 전원을 보며 나머지는 거부된다', async ({
    browser,
    page,
  }, testInfo) => {
    const s = await setup(page);
    const chief = await member(browser, s.world, s.ours, 5);
    const viewer = await member(browser, s.world, s.ours, 1);
    const shown = await member(browser, s.world, s.ours, 1);
    const outside = await member(browser, s.world, s.ours, 1);
    const foreign = await member(browser, s.world, s.theirs, 5);
    const now = await clock(chief.page, s.world);

    // 장수마다 따로 정한 예턴과 병력·훈련·사기. 모병 수량 대역(4000·2000·1000·9000)이 장수를 가른다.
    const prepared = [
      { who: chief, level: 5, readiness: { crew: 1400, train: 71, atmos: 72 }, queue: queue(4000, s.home, s.target) },
      { who: viewer, level: 1, readiness: { crew: 1100, train: 41, atmos: 42 }, queue: queue(2000, s.home, s.target) },
      { who: shown, level: 1, readiness: { crew: 1200, train: 51, atmos: 52 }, queue: queue(1000, s.other, s.target) },
      {
        who: outside,
        level: 1,
        readiness: { crew: 1300, train: 61, atmos: 62 },
        queue: queue(9000, s.other, s.target),
      },
    ];
    for (const p of prepared) {
      await shape(s.world, p.who.generalId, { nextTurnTick: now.nextTurnTick, ...p.readiness });
      await saveQueue(
        p.who.page,
        s.world,
        p.queue.map((q) => q.input),
      );
    }
    const shownQueue = prepared[2]!.queue;
    const op = await mutate<{ id: string }>(chief.page, 'operation.create', {
      worldId: s.world,
      targetCityKey: s.target.key,
      targetYear: s.targetDate.year,
      targetMonth: s.targetDate.month,
      min: MIN,
      memberIds: [viewer.generalId, shown.generalId],
    });

    // 일반 참여자가 받은 작전 응답. 두 참여자만 있고 다른 참여자의 30칸이 저장한 값과 같다.
    const detail = await query<OperationDetail>(viewer.page, 'operation.get', { worldId: s.world, id: op.id });
    expect(detail.timeline.map((m) => m.generalId).sort((a, b) => a - b)).toEqual(
      [viewer.generalId, shown.generalId].sort((a, b) => a - b),
    );
    for (const p of [prepared[1]!, prepared[2]!]) {
      const line = detail.timeline.find((m) => m.generalId === p.who.generalId)!;
      expect(line.isMe).toBe(p.who === viewer);
      expect(line.name).toBe(p.who.name);
      expect(line.cells).toHaveLength(30);
      expect(line.cells.map((cell) => cell.slot)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(line.cells.map((cell) => cell.tick)).toEqual(
        Array.from({ length: 30 }, (_, i) => now.nextTurnTick + i * TICKS_PER_MONTH),
      );
      expect(line.cells.map((cell) => cell.date)).toEqual(
        Array.from({ length: 30 }, (_, i) => monthAfter(now.gameDate, 1 + i)),
      );
      expect(line.cells.map((cell) => pick(cell.turn))).toEqual(p.queue.map((q) => stored(q.input)));
    }
    // 응답 createdBy에는 만든 수뇌의 이름이 있으므로 수뇌는 이름이 아닌 예턴 수량 대역으로 본다.
    const raw = JSON.stringify(detail);
    expect(raw).not.toContain(outside.name);
    expect(raw).not.toMatch(/"amount":(9|4)\d{3}\b/);

    // 일반 참여자의 화면. 다른 참여자 줄을 펼쳐 30칸의 칸 번호·연월·명령·인자를 하나씩 본다.
    await viewer.page.goto(`/w/${s.world}/operations/${op.id}`);
    const timeline = timelineOf(viewer.page);
    await expect(timeline.locator('tbody > tr')).toHaveCount(2);
    await expect(timeline.locator(`tbody tr[data-general-id="${viewer.generalId}"] th`)).toContainText('(나)');
    const row = timeline.locator(`tbody tr[data-general-id="${shown.generalId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('th')).not.toContainText('(나)');
    await expect(row.locator('ol')).toHaveCount(0);
    const toggle = row.getByRole('button', { name: `${shown.name}의 예턴 30칸 모두 보기` });
    await expect(toggle).toHaveText('30칸 모두 보기');
    await toggle.click();
    await expect(row.getByRole('button', { name: `${shown.name}의 예턴 30칸 접기` })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const list = row.getByRole('list', { name: `${shown.name}의 예턴 30칸` });
    await expect(list.locator(':scope > li')).toHaveCount(30);
    for (const [i, q] of shownQueue.entries()) {
      const item = list.locator(`:scope > li[data-slot="${i + 1}"]`);
      await expect(item).toHaveText(`${i + 1}번 칸 ${shortDate(monthAfter(now.gameDate, 1 + i))} ${q.text}`);
      await expect(item).toHaveAttribute('data-kind', q.kind);
    }
    await expect(list.locator(':scope > li[data-slot="3"] [title]')).toHaveAttribute('title', EMPTY_SLOT_TITLE);
    await expect(list.locator(':scope > li[data-slot="30"]')).toContainText(`출병 ${s.target.name}`);
    // 작전 밖 국가원과 만든 수뇌의 줄·예턴은 오지 않는다.
    await expect(timeline.locator(`tbody tr[data-general-id="${outside.generalId}"]`)).toHaveCount(0);
    await expect(timeline.locator(`tbody tr[data-general-id="${chief.generalId}"]`)).toHaveCount(0);
    await expect(timeline).not.toContainText(outside.name);
    await expect(timeline).not.toContainText(/수량 (9|4)\d{3}/);
    await row.screenshot({ path: testInfo.outputPath('participant-30-slots.png') });

    // 일반 참여자는 감찰을 받지 못한다.
    await expect(query(viewer.page, 'inspection.members', { worldId: s.world })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await viewer.page.goto(`/w/${s.world}/nation/inspection`);
    await expect(viewer.page.getByText('감찰은 직책자만 봅니다')).toBeVisible();
    await expect(viewer.page.getByTestId('inspection-table')).toHaveCount(0);

    // 같은 국가의 비참여 일반 장수와 다른 국가 직책자는 작전을 받지 못한다.
    for (const denied of [outside, foreign]) {
      await expect(query(denied.page, 'operation.get', { worldId: s.world, id: op.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await denied.page.goto(`/w/${s.world}/operations/${op.id}`);
      await expect(denied.page.getByText('볼 수 없는 작전입니다')).toBeVisible();
      await expect(timelineOf(denied.page)).toHaveCount(0);
    }

    // 감찰 대조 기준. 원 fixture NPC를 포함한 이 국가 장수 전원을 DB에서 읽는다.
    const snapshot = await nationSnapshot(s.world, s.ours);
    const ids = snapshot.map((g) => g.id);
    for (const p of prepared) expect(ids).toContain(p.who.generalId);
    expect(ids).not.toContain(foreign.generalId);
    expect(snapshot.some((g) => g.userId === null)).toBe(true);
    for (const p of prepared) {
      const g = snapshot.find((x) => x.id === p.who.generalId)!;
      expect({ officerLevel: g.officerLevel, crew: g.crew, train: g.train, atmos: g.atmos }).toEqual({
        officerLevel: p.level,
        ...p.readiness,
      });
      expect(g.turns).toEqual(p.queue.slice(0, 5).map((q) => stored(q.input)));
    }

    // 감찰 API. 국가원 전원이 오고 값과 앞 5칸이 DB와 같다.
    const inspection = await query<{ items: InspectionRow[] }>(chief.page, 'inspection.members', {
      worldId: s.world,
    });
    expect(inspection.items.map((r) => r.generalId).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    for (const g of snapshot) {
      const item = inspection.items.find((r) => r.generalId === g.id)!;
      expect({
        name: item.name,
        officerLevel: item.officerLevel,
        isHuman: item.isHuman,
        cityKey: item.cityKey,
        crew: item.crew,
        train: item.train,
        atmos: item.atmos,
      }).toEqual({
        name: g.name,
        officerLevel: g.officerLevel,
        isHuman: g.userId !== null,
        cityKey: g.cityKey,
        crew: g.crew,
        train: g.train,
        atmos: g.atmos,
      });
      expect(item.turns.map(pick)).toEqual(g.turns);
    }

    // 감찰 화면. 장수 이름으로 줄을 골라 직책·도시·병력·훈련·사기·앞 5칸 글자를 본다.
    await chief.page.goto(`/w/${s.world}/nation/inspection`);
    const table = chief.page.getByTestId('inspection-table');
    await expect(table).toBeVisible();
    const rows = table.locator('tbody > tr');
    await expect(rows).toHaveCount(snapshot.length);
    for (const g of snapshot) {
      const mine = prepared.find((p) => p.who.generalId === g.id);
      const labels: Label[] = mine ? mine.queue.slice(0, 5) : g.turns.map((turn) => knownLabel(turn, s.cities));
      const header = new RegExp(`^${escapeRegExp(g.name)}(?: NPC)?$`);
      const line = rows.filter({ has: chief.page.locator('th[scope="row"]', { hasText: header }) });
      await expect(line).toHaveCount(1);
      await expect(line.locator('th')).toHaveText(headText(g));
      const cells = line.locator('td');
      await expect(cells.nth(0)).toHaveText(officerText(g.officerLevel));
      await expect(cells.nth(1)).toHaveText(cityName(s.cities, g.cityKey));
      await expect(cells.nth(2)).toHaveText(g.crew.toLocaleString('ko-KR'));
      await expect(cells.nth(3)).toHaveText(String(g.train));
      await expect(cells.nth(4)).toHaveText(String(g.atmos));
      const turns = cells.nth(5).locator('ol > li');
      await expect(turns).toHaveText(labels.map((l) => l.text));
      for (const [i, l] of labels.entries()) await expect(turns.nth(i)).toHaveAttribute('data-kind', l.kind);
    }
    await table.screenshot({ path: testInfo.outputPath('inspection-nation.png') });

    // 다른 국가 직책자의 감찰에는 이 국가 장수가 하나도 없다.
    const theirs = await query<{ items: InspectionRow[] }>(foreign.page, 'inspection.members', { worldId: s.world });
    expect(theirs.items.some((r) => ids.includes(r.generalId))).toBe(false);
    // 장수 이름은 월드 안에서 DB로 유일하지 않다. General에는 이름 unique가 없고(schema.prisma:254-255)
    // 이름 중복 거절은 입력으로 만드는 장수의 NAME_TAKEN(inputs.ts:185)뿐이며 시나리오 장수는 바로 넣는다(persistence.ts:88).
    // 그래서 부분 글자 부재 대신 다른 국가 표의 행 머리 전체를 그 국가 DB 기준과 맞추고, 이 국가원 이름이 행 머리에
    // 나온 횟수가 다른 국가에 같은 이름의 장수가 있는 수와 같은지 센다.
    const foreignSnapshot = await nationSnapshot(s.world, s.theirs);
    expect(foreignSnapshot.map((g) => g.id)).toContain(foreign.generalId);
    await foreign.page.goto(`/w/${s.world}/nation/inspection`);
    const foreignHeads = foreign.page.getByTestId('inspection-table').locator('tbody > tr > th[scope="row"]');
    await expect(foreignHeads).toHaveCount(foreignSnapshot.length);
    const heads = (await foreignHeads.allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
    expect([...heads].sort()).toEqual(foreignSnapshot.map(headText).sort());
    for (const g of snapshot) {
      const shownAs = heads.filter((text) => text === g.name || text === `${g.name} NPC`).length;
      expect(shownAs).toBe(foreignSnapshot.filter((f) => f.name === g.name).length);
    }
  });
});
