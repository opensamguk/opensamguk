import { test, expect, mutate, randomUUID, hashState, calls, type Offer } from './campaign-offer-fixture';

// INT-11 AC-INT-11. 전용 공개 dist 구성에서만 열거하고 실행한다.
test.describe.configure({ timeout: 120_000, retries: 0 });

test('AC-INT-11 A 이전 표시→실제 NPC commit→명시적 최신 조회→POST 한 번', async ({ offer }) =>
  offer.run(async () => {
    const [main, control] = offer.worlds;
    const page = offer.users[0]!.page;
    const old = offer.deliveredBoard!;
    expect(old.revision).toBe((await offer.snapshot(main!)).state.campaign!.revision);
    const npc = offer.candidate(old);
    const checkDraft = await offer.draft();
    await expect(offer.panel().getByRole('button', { name: `${npc.name}에게 제안`, exact: true })).toBeVisible();
    const releasePolls = await offer.holdPolls();
    await offer.npcCommit();
    const before = await offer.snapshot(main!);
    expect(before.state.campaign!.revision).toBeGreaterThan(old.revision);
    const posts = offer.observePosts();
    const gate = await offer.gateRead(npc.name);
    await gate.click();
    const fresh = await gate.seen;
    expect(fresh.revision).toBe(before.state.campaign!.revision);
    expect(fresh.actorId).toBe(492);
    expect(fresh.candidates).toContain(npc.id);
    gate.release();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]!.status).toBe(200);
    const input = posts[0]!.input;
    expect(input).toMatchObject({
      worldId: main!.id,
      expectedUserId: offer.users[0]!.id,
      payload: { type: 'offer', targetId: npc.id, relation: 'LIEUTENANT', revision: fresh.revision },
    });
    await offer.advance(main!, main!.tick);
    const event = await offer.input(input.requestId);
    expect(event.status).toBe('APPLIED');
    expect(event.result).toMatchObject({ cost: 500 });
    // 실제 난수의 수락/거절 어느 쪽도 허용하며 결과를 사전 선택하지 않는다.
    expect(typeof (event.result as { accepted: unknown }).accepted).toBe('boolean');
    const after = await offer.snapshot(main!);
    expect(after.state.generals[492]!.gold).toBe(before.state.generals[492]!.gold - 500);
    expect(after.state.generals[492]!.rice).toBe(before.state.generals[492]!.rice);
    expect(after.state.campaign!.attempts.filter((a) => a.masterId === 492 && a.personId === npc.id)).toHaveLength(1);
    await expect(offer.panel()).not.toContainText('요청 접수를 확인하는 중입니다.');
    expect(posts).toHaveLength(1);
    await checkDraft();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    releasePolls();
    offer.journal.push({
      case: 'A',
      stale: old.revision,
      fresh: fresh.revision,
      requestId: input.requestId,
      result: event.result,
      baselineHash: hashState(await offer.snapshot(control!)),
    });
  }));

test('AC-INT-11 B 최신 실제 조회 후 NPC commit은409·접수0·비용0', async ({ offer }) =>
  offer.run(async () => {
    const main = offer.worlds[0]!;
    const before = await offer.board();
    const npc = offer.candidate(before);
    const checkDraft = await offer.draft();
    const posts = offer.observePosts();
    const count = await main.hold.db.inputEvent.count({ where: { worldId: main.id } });
    const gate = await offer.gateRead(npc.name);
    await gate.click();
    const fresh = await gate.seen;
    await offer.npcCommit();
    expect((await offer.board()).revision).toBeGreaterThan(fresh.revision);
    gate.release();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]!.status).toBe(409);
    await expect(offer.panel()).toContainText('휘하 현황을 다시 불러오세요.');
    expect(await main.hold.db.inputEvent.count({ where: { worldId: main.id } })).toBe(count);
    expect(hashState(await offer.snapshot(main))).toBe(hashState(await offer.snapshot(offer.worlds[1]!)));
    expect(posts).toHaveLength(1);
    await checkDraft();
    offer.journal.push({ case: 'B', snapshotRevision: fresh.revision, submitted: posts[0]!.input, status: 409 });
  }));

test('AC-INT-11 C 선행 정상 입력 뒤 engine STALE은 비용·시도·후속 RNG에 영향0', async ({ offer }) =>
  offer.run(async () => {
    const [main, control] = offer.worlds;
    // 같은 실제 NPC commit을 두 월드에서 먼저 확정한다. 접수 뒤 NPC가 먼저 실행된다고 가정하지 않는다.
    await offer.npcCommit();
    await offer.users[0]!.page.reload();
    const board = await offer.board();
    const npc = offer.candidate(board);
    const posts = offer.observePosts();
    const gate = await offer.gateRead(npc.name);
    await gate.click();
    const fresh = await gate.seen;
    const formRequests: string[] = [];
    for (const world of [main!, control!]) {
      const b = await offer.board(world, 1);
      const requestId = randomUUID();
      formRequests.push(requestId);
      await mutate(offer.users[1]!.page, 'campaign.unit', {
        worldId: world.id,
        requestId,
        payload: { type: 'form', commanderId: 493, crewType: b.armyTypes[0]!.id, revision: b.revision },
      });
    }
    expect((await offer.board()).revision).toBe(fresh.revision);
    gate.release();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]!.status).toBe(200);
    const requestId = posts[0]!.input.requestId;
    expect((await offer.input(requestId)).status).toBe('PENDING');
    for (const world of [main!, control!]) await offer.advance(world, world.tick);
    expect(await offer.input(requestId)).toMatchObject({ status: 'REJECTED', result: { code: 'STALE_REVISION' } });
    for (const [index, world] of [main!, control!].entries())
      expect(
        await world.hold.db.inputEvent.findFirstOrThrow({
          where: { worldId: world.id, idempotencyKey: `campaign:${formRequests[index]}` },
        }),
      ).toMatchObject({ status: 'APPLIED' });
    const left = await offer.snapshot(main!),
      right = await offer.snapshot(control!);
    expect(left.state.campaign).toEqual(right.state.campaign);
    for (const id of [492, 493]) {
      expect(left.state.generals[id]!.gold).toBe(right.state.generals[id]!.gold);
      expect(left.state.generals[id]!.rice).toBe(right.state.generals[id]!.rice);
    }
    // 같은 후속 NPC 제안을 두 월드에서 실제 처리해 거부 입력의 난수·비용 영향을 검사한다.
    const results: unknown[] = [];
    for (const world of [main!, control!]) {
      const b = await offer.board(world);
      const id = randomUUID();
      await mutate(offer.users[0]!.page, 'campaign.relationship', {
        worldId: world.id,
        requestId: id,
        expectedUserId: offer.users[0]!.id,
        payload: { type: 'offer', targetId: npc.id, relation: 'LIEUTENANT', revision: b.revision },
      });
      await offer.advance(world, world.tick);
      const event = await world.hold.db.inputEvent.findFirstOrThrow({
        where: { worldId: world.id, idempotencyKey: `campaign:${id}` },
      });
      expect(event.status).toBe('APPLIED');
      results.push(event.result);
    }
    expect(results[0]).toEqual(results[1]);
    expect((await offer.snapshot(main!)).state.campaign).toEqual((await offer.snapshot(control!)).state.campaign);
    for (const world of [main!, control!]) {
      const after = await offer.snapshot(world);
      expect(after.state.generals[492]!.gold).toBe(left.state.generals[492]!.gold - 500);
      expect(after.state.generals[492]!.rice).toBe(left.state.generals[492]!.rice);
    }
    expect(posts).toHaveLength(1);
    offer.journal.push({ case: 'C', requestId, stale: 'STALE_REVISION', nextActualResults: results });
  }));

test('AC-INT-11 D A 최신 조회 후 B 쿠키로 바뀌면403·접수0', async ({ offer }) =>
  offer.run(async () => {
    const main = offer.worlds[0]!;
    const npc = offer.candidate(await offer.board());
    const posts = offer.observePosts();
    const count = await main.hold.db.inputEvent.count({ where: { worldId: main.id } });
    const before = hashState(await offer.snapshot(main));
    const gate = await offer.gateRead(npc.name);
    await gate.click();
    expect((await gate.seen).actorId).toBe(492);
    await offer.switchTo(1); // POST 생성 전에 쿠키를 바꾼다.
    gate.release();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ cookieIsB: true, status: 403, input: { expectedUserId: offer.users[0]!.id } });
    await expect(offer.panel()).toContainText('로그인한 계정이 바뀌었습니다.');
    expect(await main.hold.db.inputEvent.count({ where: { worldId: main.id } })).toBe(count);
    expect(hashState(await offer.snapshot(main))).toBe(before);
    expect(posts).toHaveLength(1);
    offer.journal.push({
      case: 'D',
      requestId: posts[0]!.input.requestId,
      cookieIsB: true,
      status: 403,
      addedInputs: 0,
    });
  }));

test('AC-INT-11 E 응답 소실 후 수동 재전송도 기존UUID·payload·expectedA로 B 접수0', async ({ offer }) =>
  offer.run(async () => {
    const main = offer.worlds[0]!;
    const page = offer.users[0]!.page;
    const npc = offer.candidate(await offer.board());
    const posts = offer.observePosts();
    let first: Offer | undefined;
    let firstAdmitted = false;
    await page.route('**/trpc/**', (route) =>
      offer.track(
        (async () => {
          if (offer.scope.signal.aborted) return route.abort('aborted');
          const call = calls(route.request()).find((c) => c.path === 'campaign.relationship');
          if (first || route.request().method() !== 'POST' || !call) return route.fallback();
          first = call.input as Offer;
          const response = await offer.scope.work('manual offer route fetch', () => route.fetch());
          expect(response.status()).toBe(200);
          firstAdmitted = true;
          await offer.switchTo(1);
          await route.abort('failed'); // 실제 접수 응답을 소실시킨다. 응답 데이터는 합성하지 않는다.
        })(),
      ),
    );
    const gate = await offer.gateRead(npc.name);
    await gate.click();
    await gate.seen;
    gate.release();
    await expect(offer.panel().getByRole('button', { name: '같은 요청 다시 보내기', exact: true })).toBeVisible();
    expect(firstAdmitted).toBe(true);
    const admitted = await offer.input(first!.requestId);
    expect(admitted).toMatchObject({ userId: offer.users[0]!.id, status: 'PENDING' });
    const count = await main.hold.db.inputEvent.count({ where: { worldId: main.id } });
    const before = hashState(await offer.snapshot(main));
    const resources = (await offer.snapshot(main)).state.generals[492]!;
    await offer.panel().getByRole('button', { name: '같은 요청 다시 보내기', exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ cookieIsB: true, status: 403 });
    expect(posts[0]!.input).toEqual(first);
    await expect(offer.panel()).toContainText('로그인한 계정이 바뀌었습니다.');
    expect(await main.hold.db.inputEvent.count({ where: { worldId: main.id } })).toBe(count);
    expect(hashState(await offer.snapshot(main))).toBe(before);
    expect(
      await main.hold.db.inputEvent.count({
        where: { worldId: main.id, userId: offer.users[1]!.id, idempotencyKey: `campaign:${first!.requestId}` },
      }),
    ).toBe(0);
    await offer.switchTo(0);
    await offer.advance(main, main.tick);
    expect(await offer.input(first!.requestId)).toMatchObject({ status: 'APPLIED', result: { cost: 500 } });
    const after = await offer.snapshot(main);
    expect(after.state.generals[492]!.gold).toBe(resources.gold - 500);
    expect(after.state.generals[492]!.rice).toBe(resources.rice);
    expect(after.state.campaign!.attempts.filter((a) => a.masterId === 492 && a.personId === npc.id)).toHaveLength(1);
    expect(
      await main.hold.db.inputEvent.count({
        where: { worldId: main.id, idempotencyKey: `campaign:${first!.requestId}` },
      }),
    ).toBe(1);
    expect(posts).toHaveLength(1);
    offer.journal.push({
      case: 'E',
      requestId: first!.requestId,
      samePayload: true,
      cookieIsB: true,
      manualStatus: 403,
      bAdmission: 0,
    });
  }));
