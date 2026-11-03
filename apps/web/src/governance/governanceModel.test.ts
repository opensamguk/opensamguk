import { expect, it } from 'vitest';
import {
  censureTargets,
  offerCheck,
  readBp,
  realmScope,
  splitOffers,
  vassalActions,
  type OfferDraft,
} from './governanceModel';
import { testView } from './testView';

const roles = { monarch: false, emperor: false, chancellor: false, grandMarshal: false, minister: false };
const draft = (value: Partial<OfferDraft>): OfferDraft => ({
  authority: 'OWN',
  target: '',
  direction: 'DEMAND',
  gold: '5',
  rice: '0',
  ...value,
});

it('T4-94 AC-P2-31 공납 비율 입력은 소수 둘째 자리까지 만분율 정수로만 읽는다', () => {
  expect(readBp('5')).toBe(500);
  expect(readBp('5.5')).toBe(550);
  expect(readBp('0.07')).toBe(7);
  expect(readBp('100')).toBe(10_000);
  for (const bad of ['', '-1', '5.555', '1e2', 'abc', '1000']) expect(readBp(bad)).toBeNull();
});

it('T4-94 AC-P2-31 위임 직위는 자국이 하위국이거나 그 아래 계열인 관계를 해제·면제하지 못한다', () => {
  const direct = testView().vassals[0]!; // 1국 → 2국 (황제국 직접)
  const lower = testView().vassals[1]!; // 2국 → 3국
  // 3국 승상: 2국 아래 계열이라 1→2 해제가 막힌다.
  const fromBranch = testView({ roles: { ...roles, chancellor: true }, ownNationId: 3 });
  expect(vassalActions(fromBranch, direct).release?.reason).toMatch(/해제할 수 없습니다/);
  // 2국 사도: 자국이 하위국이라 면제가 막힌다.
  const ministerVassal = testView({ roles: { ...roles, minister: true }, ownNationId: 2 });
  expect(vassalActions(ministerVassal, direct).remit?.reason).toMatch(/면제할 수 없습니다/);
  // 계열 밖 4국의 승상·사도는 직접 관계만 다룬다.
  const outsider = testView({ roles: { ...roles, chancellor: true, minister: true }, ownNationId: 4 });
  expect(vassalActions(outsider, direct)).toMatchObject({ release: { reason: null }, remit: { reason: null } });
  expect(vassalActions(outsider, lower)).toMatchObject({ release: null, remit: null });
  // 상위국 군주의 해제와 황제의 면제는 그대로 된다.
  const overlord = testView({ roles: { ...roles, monarch: true }, ownNationId: 2 });
  expect(vassalActions(overlord, lower).release).toEqual({ reason: null });
  expect(vassalActions(overlord, direct)).toMatchObject({ release: null, renounce: { reason: null } });
  const emperor = testView({ roles: { ...roles, monarch: true, emperor: true }, ownNationId: 1 });
  expect(vassalActions(emperor, direct)).toMatchObject({ release: { reason: null }, remit: { reason: null } });
  expect(vassalActions(emperor, lower)).toMatchObject({ release: null, remit: null });
  // 이미 이탈을 요청한 관계는 다시 요청하지 않는다.
  expect(vassalActions(overlord, { ...direct, renouncePending: true }).renounce?.reason).toMatch(/이미/);
});

it('T4-94 AC-P2-31 봉신 탭 앞자리는 내 계열과 내가 당사국이거나 행동할 수 있는 관계만 고르고 나머지는 남긴다', () => {
  const ids = (rows: readonly { id: number }[]) => rows.map((row) => row.id);
  // 독립 4국 장수: 내 계열은 4국 하나, 앞자리 관계 없음, 전체는 그대로.
  const alone = realmScope(testView());
  expect(alone).toMatchObject({ root: 4, tops: [1, 4, 5] });
  expect([...alone.members]).toEqual([4]);
  expect([ids(alone.mine), ids(alone.others)]).toEqual([[], [1, 2]]);
  // 3국 장수: 최상위 1국 아래 계열 전부가 내 계열이다.
  const branch = realmScope(testView({ ownNationId: 3 }));
  expect(branch.root).toBe(1);
  expect([...branch.members].sort()).toEqual([1, 2, 3]);
  expect([ids(branch.mine), ids(branch.others)]).toEqual([[1, 2], []]);
  // 계열 밖 4국 승상은 해제할 수 있는 황제국 직접 관계만 앞에 둔다.
  const chancellor = realmScope(testView({ roles: { ...roles, chancellor: true } }));
  expect([ids(chancellor.mine), ids(chancellor.others)]).toEqual([[1], [2]]);
  // 재야는 내 계열이 없고 모든 관계가 전체 쪽에 남는다.
  const neutral = realmScope(testView({ ownNationId: null, realmNationId: null }));
  expect([neutral.root, neutral.members.size]).toEqual([null, 0]);
  expect([ids(neutral.mine), ids(neutral.others)]).toEqual([[], [1, 2]]);
});

it('T4-94 AC-P2-31 봉신 제안은 명의·방향·공개 계열로 막을 이유를 보이고 통과하면 서버 입력을 만든다', () => {
  const monarch4 = testView({ roles: { ...roles, monarch: true }, ownNationId: 4 });
  expect(offerCheck(monarch4, draft({ target: '2' })).reasons).toContain('국2에는 이미 상위 국가가 있습니다.');
  expect(offerCheck(monarch4, draft({ target: '4' })).reasons).toContain('자기 국가에는 제안할 수 없습니다.');
  expect(offerCheck(monarch4, draft({ target: '5', gold: '15.01' })).reasons[0]).toMatch(/15.00%/);
  expect(offerCheck(monarch4, draft({ authority: 'EMPIRE', target: '5' })).reasons[0]).toMatch(/황제나 승상/);
  // 4국이 3국 아래로 들어가면 깊이 3: 상한 3은 통과, 상한 2는 막힌다.
  const ok = offerCheck(monarch4, draft({ target: '3', direction: 'REQUEST', gold: '2.5', rice: '1' }));
  expect(ok.reasons).toEqual([]);
  expect(ok.payload).toEqual({
    type: 'vassal.offer',
    authority: 'OWN',
    targetNationId: 3,
    direction: 'REQUEST',
    goldBp: 250,
    riceBp: 100,
  });
  const shallow = testView({ ...monarch4, limits: { ...monarch4.limits, maxDepth: 2 } });
  expect(offerCheck(shallow, draft({ target: '3', direction: 'REQUEST' })).payload).toBeNull();
  // 황제는 황실 명의로 요구만 보낸다. 황제국은 하위가 되지 않는다.
  const emperor = testView({ roles: { ...roles, monarch: true, emperor: true }, ownNationId: 1 });
  expect(offerCheck(emperor, draft({ authority: 'EMPIRE', target: '5', direction: 'REQUEST' })).reasons).toContain(
    '황실 명의로는 요구(상대가 봉신이 됨)만 보낼 수 있습니다.',
  );
  expect(offerCheck(emperor, draft({ authority: 'EMPIRE', target: '5' })).payload?.type).toBe('vassal.offer');
  expect(offerCheck(emperor, draft({ target: '5', direction: 'REQUEST' })).reasons[0]).toMatch(/황제국은/);
  // 황제가 없을 때 하위 계열 아래로 들어가려 하면 순환이다.
  const noThrone = testView({
    roles: { ...roles, monarch: true },
    ownNationId: 1,
    throne: { emperorGeneralId: null, emperorNationId: null, sinceTick: 0 },
  });
  expect(offerCheck(noThrone, draft({ target: '3', direction: 'REQUEST' })).reasons).toContain(
    '서로 같은 계열이라 계약하면 순환이 생깁니다.',
  );
});

it('T4-94 AC-P2-31 받은 제안은 당사자 몫만, 견책 대상은 황제국 계열 밖만 고른다', () => {
  const offers = [
    {
      id: 1,
      kind: 'VASSAL' as const,
      authority: 'OWN' as const,
      fromNationId: 5,
      sourceMonarchId: 50,
      actorId: 50,
      targetNationId: 4,
      direction: 'DEMAND' as const,
      goldBp: 100,
      riceBp: 0,
      expiresTick: 40_000,
    },
    {
      id: 2,
      kind: 'COURT' as const,
      fromNationId: 1,
      sourceMonarchId: 10,
      actorId: 10,
      targetGeneralId: 40,
      office: 'minister' as const,
      expiresTick: 40_000,
    },
  ];
  const monarch = testView({ roles: { ...roles, monarch: true }, ownNationId: 4, viewerGeneralId: 40, offers });
  expect(splitOffers(monarch).received.map((row) => row.id)).toEqual([1, 2]);
  // 군주가 아닌 4국 장수는 국가 앞 제안을 받지 않는다.
  const subject = testView({ ownNationId: 4, viewerGeneralId: 40, offers });
  expect(splitOffers(subject)).toMatchObject({ received: [{ id: 2 }], sent: [{ id: 1 }] });
  expect(censureTargets(testView()).map((row) => row.id)).toEqual([4, 5]);
  expect(censureTargets(testView({ throne: { emperorGeneralId: null, emperorNationId: null, sinceTick: 0 } }))).toEqual(
    [],
  );
});
