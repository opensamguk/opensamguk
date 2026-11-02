import { expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import { loadInitialWorld } from '../apps/engine/src/world/resources';
import {
  applyCampaignOrder,
  applyRecordedInput,
  buildCreatedGeneral,
  initialReplayState,
  resolverForRuleFeatures,
  runGeneralTurn,
} from '../packages/rules/src/index';
import { creationFeatures } from '../apps/server/src/admin/worldCreateOptions';

// 정식 자원의 순수 연결 검사다. 실제 PostgreSQL/HTTP/Chromium 인수와 구분한다.
it('AC-INT-19B 정식191년21국491명에서 사람 생성·정상출사·NPC지시를 재생하며 다른491명을 보존한다', async () => {
  const initial = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'int19-formal-pure',
  });
  expect(initial.generals).toHaveLength(491);
  expect(initial.nations).toHaveLength(21);
  const original = structuredClone(initial),
    originHash = hashState(initial);
  initial.ruleFeatures = [...creationFeatures];
  const replay = initialReplayState(initial, { policy: { version: 1, turnTermMinutes: 60 } });
  expect(replay.state.campaign).not.toHaveProperty('orders');
  const payload = {
    name: '지시수신',
    portraitId: null,
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
  };
  const general = buildCreatedGeneral({
    payload,
    seed: initial.seed,
    userId: 'int19-human',
    id: 492,
    startYear: initial.startYear,
    monthlyTick: 0,
    tick: 0,
    cityKeys: initial.cities.filter((city) => city.kind === 'CITY').map((city) => city.cityKey),
    unitSet: initial.unitSet,
  });
  const created = applyRecordedInput(replay, {
    sequence: 1,
    tick: 0,
    generalId: general.id,
    kind: 'general.create',
    status: 'APPLIED',
    payload,
    result: { general, activeTick: 0 },
  });
  const nation = initial.nations[0]!;
  const joined = runGeneralTurn(
    created.state,
    { generalId: 492, tick: 1, unitSet: initial.unitSet },
    { commandKey: 'join', args: { nationId: nation.id }, explicit: true },
    initial.seed,
    { turnRevision: 0 },
    resolverForRuleFeatures(created.state),
    { offices: created.offices! },
  );
  expect(joined.result).not.toHaveProperty('code');
  const state = joined.state,
    before = hashState(state),
    originalSlots = hashState(created.turns);
  const request = { type: 'request', revision: state.campaign!.revision };
  const context = {
    tick: 2,
    userId: 'int19-human',
    userActive: true,
    turns: created.turns,
    revisions: created.revisions,
    resolver: resolverForRuleFeatures(state)!,
    unitSet: initial.unitSet,
  };
  const result = applyCampaignOrder(state, request, 492, context);
  if (!result.ok) throw new Error(result.message);
  expect(result.state.campaign!.orders!.items[0]).toMatchObject({ recipientId: 492, status: 'PENDING' });
  expect(result.state.campaign!.orders!.items[0]!.issuerId).toBe(
    initial.generals.find((person) => person.nationId === nation.id && person.officerLevel === 12)!.id,
  );
  expect(hashState(state)).toBe(before);
  expect(hashState(created.turns)).toBe(originalSlots);
  for (const source of initial.generals) expect(result.state.generals[source.id]).toEqual(state.generals[source.id]);
  const replayed = applyRecordedInput(
    { ...created, state, offices: joined.personnel!.offices },
    {
      sequence: 2,
      tick: 2,
      generalId: 492,
      kind: 'campaign.order',
      status: 'APPLIED',
      payload: request,
      result: { ...result.result, tick: 2 },
    },
  );
  expect(replayed.state).toEqual(result.state);
  expect(replayed.turns).toEqual(created.turns);
  expect(initial).toEqual({ ...original, ruleFeatures: [...creationFeatures] });
  const unchangedOrigin = { ...initial };
  if (Object.hasOwn(original, 'ruleFeatures')) unchangedOrigin.ruleFeatures = original.ruleFeatures!;
  else delete unchangedOrigin.ruleFeatures;
  expect(hashState(unchangedOrigin)).toBe(originHash);
});
