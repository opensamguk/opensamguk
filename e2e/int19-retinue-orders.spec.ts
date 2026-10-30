import type { AppRouter } from '../apps/server/src/router';
import type { inferRouterOutputs } from '@trpc/server';
import { test, expect, apiMutate, apiQuery } from './t210-fixture';
import { rngFor } from '../packages/shared/src/index';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { controlClock } from '../apps/engine/src/world/clock';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { holdLease, releaseHold } from './game';

type Orders = inferRouterOutputs<AppRouter>['campaign']['orders'];
type CampaignBoard = inferRouterOutputs<AppRouter>['campaign']['get'];
// 정식 191년 데이터에서 사람 장수끼리의 발송·본인 수락/거절·다음 차례 실행과 NPC 군주 지시 요청을 실제 화면으로 검사한다.
// 권한·제재·재생·NPC 부곡 반례는 tools/int19-orders.integration.test.ts의 실제 PG 검사가 맡는다.
test('AC-INT-19C 정식491명 장수 지시 발송·수락 실행·거절·NPC 군주 요청·재접속·375px', async ({ world }) => {
  test.setTimeout(180000);
  const owner = await world.user('member'),
    target = await world.user('ronin');
  const db = world.hold.db;
  let seed = '';
  for (let index = 0; index < 1000000; index++) {
    const value = `int19-formal-${index}`;
    if (
      [owner, target].every((user) => {
        const rng = rngFor(value, 'create', user.userId);
        rng.next();
        rng.next();
        const offset = rng.int(0, 9999);
        return offset > 0 && offset <= 100;
      })
    ) {
      seed = value;
      break;
    }
  }
  expect(seed).not.toBe('');
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed,
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
  const { worldId } = await saveInitialWorld(db, initial, {
    name: 'INT19 정식 지시 화면',
    turnTermMinutes: 60,
    endYear: 201,
  });
  const hold = await holdLease(worldId);
  const panel = (user: typeof owner) => user.page.getByRole('region', { name: '장수 지시', exact: true });
  let tick = 0;
  const advance = () => new TurnLoop(hold.db, hold.lease).advanceTo(tick);
  const pending = (kind: string) =>
    expect.poll(() => db.inputEvent.count({ where: { worldId, kind, status: 'PENDING' } })).toBe(1);
  const turns = (generalId: number) =>
    db.generalTurn.findMany({ where: { worldId, generalId }, orderBy: { slot: 'asc' } });
  const slots = (rows: Awaited<ReturnType<typeof turns>>) => rows.map(({ commandKey, args }) => ({ commandKey, args }));
  const rest = Array.from({ length: 29 }, () => ({ commandKey: 'rest', args: {} }));
  const revision = async (id: number) =>
    (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id } } })).turnRevision;
  const sendFarm = async (recipientId: number) => {
    await panel(owner).getByLabel('받을 장수').selectOption(String(recipientId));
    await panel(owner).getByLabel('명령 찾기').fill('농지 개간');
    await panel(owner).getByRole('radio', { name: '농지 개간', exact: true }).check();
    await panel(owner).getByRole('button', { name: '보낼 지시에 넣기', exact: true }).click();
    await expect(panel(owner)).toContainText('선택한 지시: 농지 개간');
    await panel(owner).getByRole('button', { name: '지시 보내기', exact: true }).click();
    await pending('campaign.order');
    await advance();
  };
  try {
    await controlClock(db, worldId, 'start');
    for (const [index, user] of [owner, target].entries()) {
      // 생성 응답은 엔진 처리를 잠시 기다리므로 접수를 확인한 뒤 차례를 진행한다.
      // 대기가 길면 정상 응답도 pending이므로 생성 완료는 DB의 장수 행으로 확인한다.
      const created = apiMutate<{ status: string }>(world, user, 'general.create', {
        worldId,
        name: `지시장수${index}`,
        portraitId: null,
        leadership: 55,
        strength: 55,
        intel: 55,
        politics: 55,
        charm: 55,
      });
      await pending('general.create');
      await advance();
      expect(['created', 'pending']).toContain((await created).status);
      await expect.poll(() => db.general.count({ where: { worldId, userId: user.userId } })).toBe(1);
    }
    const humans = await db.general.findMany({
      where: { worldId, userId: { in: [owner.userId, target.userId] } },
      orderBy: { id: 'asc' },
    });
    expect(humans).toHaveLength(2);
    const ownerId = humans[0]!.id,
      targetId = humans[1]!.id;
    for (const user of [owner, target])
      await apiMutate(world, user, 'turns.set', {
        worldId,
        revision: 0,
        slots: [{ commandKey: 'join', args: { nationId: 1 } }, ...rest],
      });
    tick = Math.max(...humans.map((general) => general.nextTurnTick));
    await advance();
    for (const id of [ownerId, targetId])
      expect((await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id } } })).nationId).toBe(1);

    // INT-11 화면에서 검사한 동의 절차를 API로 거쳐 지시장수0을 지시장수1의 직속 상급자로 만든다.
    await apiMutate(world, owner, 'campaign.relationship', {
      worldId,
      requestId: crypto.randomUUID(),
      expectedUserId: owner.userId,
      payload: {
        type: 'offer',
        targetId,
        relation: 'STAFF',
        revision: (await apiQuery<CampaignBoard>(owner, 'campaign.get', { worldId })).revision,
      },
    });
    await pending('campaign.relationship');
    await advance();
    const offerBoard = await apiQuery<CampaignBoard>(target, 'campaign.get', { worldId });
    const offer = offerBoard.offers.find(
      (row) => row.personId === targetId && row.masterId === ownerId && row.status === 'PENDING',
    );
    expect(offer).toBeDefined();
    await apiMutate(world, target, 'campaign.relationship', {
      worldId,
      requestId: crypto.randomUUID(),
      expectedUserId: target.userId,
      payload: { type: 'respond', offerId: offer!.id, accept: true, revision: offerBoard.revision },
    });
    await pending('campaign.relationship');
    await advance();
    expect((await apiQuery<CampaignBoard>(owner, 'campaign.get', { worldId })).links).toContainEqual({
      masterId: ownerId,
      personId: targetId,
      relation: 'STAFF',
    });

    // 수신자의 30칸을 휴식으로 고정해 수락 뒤 다음 한 칸만 지시로 대체되는지 확인한다.
    await apiMutate(world, target, 'turns.set', {
      worldId,
      revision: await revision(targetId),
      slots: [{ commandKey: 'rest', args: {} }, ...rest],
    });
    const targetTurns = await turns(targetId);
    expect(targetTurns).toHaveLength(30);

    for (const user of [owner, target]) await user.page.goto(`/w/${worldId}`);
    await expect(panel(owner)).toBeVisible();
    await sendFarm(targetId);
    await expect(panel(owner)).toContainText('지시장수0 → 지시장수1: 농지 개간');
    await expect(panel(owner)).toContainText('응답 대기');
    // 접수는 수신자의 예약 30칸을 바꾸지 않는다.
    expect(await turns(targetId)).toEqual(targetTurns);

    await target.page.reload();
    const accept = panel(target).getByRole('button', { name: '다음 한 칸으로 수락', exact: true });
    await expect(accept).toBeDisabled();
    await expect(panel(target)).toContainText('현재 다음 예약: 휴식');
    // 동의 확인란은 키보드로도 켤 수 있다.
    await panel(target).getByRole('checkbox', { name: '다음 한 칸을 이 지시로 실행하는 데 동의합니다.' }).focus();
    await target.page.keyboard.press('Space');
    await expect(accept).toBeEnabled();
    await accept.click();
    await pending('campaign.order');
    await advance();
    await expect(panel(target)).toContainText('다음 차례 실행 대기');
    expect(await turns(targetId)).toEqual(targetTurns);

    const due = (await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: targetId } } })).nextTurnTick;
    tick = due;
    await advance();
    await target.page.reload();
    await expect(panel(target)).toContainText('실행 완료');
    const executed = (await apiQuery<Orders>(target, 'campaign.orders', { worldId })).orders[0]!;
    expect(executed).toMatchObject({ issuerId: ownerId, recipientId: targetId, status: 'EXECUTED' });
    expect(await db.generalLog.count({ where: { worldId, generalId: targetId, tick: due, commandKey: 'farm' } })).toBe(
      1,
    );
    // 지시가 다음 한 칸을 대신 사용했고 나머지 예약은 기존처럼 한 칸 당겨졌다.
    const shifted = await turns(targetId);
    expect(shifted).toHaveLength(30);
    expect(slots(shifted).slice(0, 29)).toEqual(slots(targetTurns).slice(1));

    // 두 번째 지시는 수신자가 거절하며 예약을 바꾸지 않는다.
    await owner.page.reload();
    await sendFarm(targetId);
    await target.page.reload();
    const beforeReject = await turns(targetId);
    await panel(target).getByRole('button', { name: '지시 거절', exact: true }).click();
    await pending('campaign.order');
    await advance();
    await expect(panel(target)).toContainText('거절 · 지시를 거절했습니다.');
    expect(await turns(targetId)).toEqual(beforeReject);

    // 직속 상급자가 없는 지시장수0은 현재 동국 NPC 군주에게 지시를 요청하고 본인 응답을 기다린다.
    const sovereign = initial.generals.find((general) => general.nationId === 1 && general.officerLevel === 12)!;
    await owner.page.reload();
    const request = panel(owner).getByRole('button', { name: `${sovereign.name}에게 지시 요청`, exact: true });
    await expect(request).toBeVisible();
    await request.click();
    await pending('campaign.order');
    await advance();
    const requested = (await apiQuery<Orders>(owner, 'campaign.orders', { worldId })).orders.find(
      (row) => row.recipientId === ownerId,
    );
    expect(requested).toMatchObject({ issuerId: sovereign.id, status: 'PENDING' });
    await owner.page.reload();
    await expect(panel(owner)).toContainText(`${sovereign.name} → 지시장수0`);
    await expect(panel(owner).getByRole('button', { name: '다음 한 칸으로 수락', exact: true })).toBeDisabled();

    const inputs = await db.inputEvent.count({ where: { worldId } });
    for (const width of [375, 768, 1440]) {
      await owner.page.setViewportSize({ width, height: 900 });
      await expect(panel(owner)).toBeVisible();
      expect(await owner.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await panel(owner).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    // 화면 크기 변경은 새 입력을 만들지 않는다.
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(inputs);
    await owner.page.setViewportSize({ width: 375, height: 812 });
    await owner.page.screenshot({ path: 'test-results/int19-retinue-orders-mobile.png', fullPage: true });
  } finally {
    await releaseHold(hold);
    await db.world.deleteMany({ where: { id: worldId } });
  }
});
