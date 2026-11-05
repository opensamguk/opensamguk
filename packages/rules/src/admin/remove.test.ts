import { expect, it } from 'vitest';
import { commandInitial, testUnits } from '../../test/commandFixture';
import { applyRecordedInput, initialReplayState, nextGameAction } from '../replay';
import { emptyCampaignState } from '../campaign/state';
import { ruleRegistry } from '../ruleRegistry';
import { lineageAlive } from '../lineage/eligibility';
import { commandRegistry } from '../commands/registry';
import { lineageFixture } from '../lineage/testFixture';
import { assertLineageStorage } from '../lineage/invariants';
import { governanceFixture } from '../governance/testFixture';
import { assertGovernanceFinal } from '../governance/reconcile';
import { buildIntelRecord } from '../commands/ext/intel/base';
import { decideAdminGameAction } from './apply';

const context = { userActive: true, admin: true, sanctioned: false, replayFormat: 3, worldStatus: 'RUNNING', tick: 10 };
const payload = { version: 1, reason: '장수 내보내기 검증', action: { kind: 'admin.general.remove', generalId: 3 } };
function fixture() {
  const initial = commandInitial();
  initial.generals[2]!.userId = 'human';
  initial.generals[2]!.officerLevel = 11;
  initial.generals[2]!.nextTurnTick = 10;
  return initialReplayState(initial);
}

it('AC-INT-23 내보내기는 기록과 재산을 남기고 소속·조작권·병력을 해제하며 같은 tick으로 재생된다', () => {
  const replay = fixture();
  const original = structuredClone(replay);
  const outcome = decideAdminGameAction(replay, payload, context);
  expect(outcome.status).toBe('APPLIED');
  const next = applyRecordedInput(
    replay,
    {
      sequence: 1,
      tick: 10,
      generalId: null,
      kind: payload.action.kind,
      payload,
      status: outcome.status,
      result: outcome.result,
    },
    ruleRegistry,
    { unitSet: testUnits },
  );
  expect(next.state.generals[3]).toMatchObject({
    userId: null,
    nationId: null,
    officerLevel: 0,
    crew: 0,
    removedAt: 10,
    gold: original.state.generals[3]!.gold,
    activeFromYear: original.state.generals[3]!.activeFromYear,
  });
  const city = original.state.cities[original.state.generals[3]!.cityKey]!;
  expect(next.state.cities[city.cityKey]!.population).toBe(Math.min(city.populationMax, city.population + 10));
  expect(lineageAlive(next.state, 3)).toBe(false);
  expect(nextGameAction(next)).not.toMatchObject({ generalId: 3 });
  expect(replay).toEqual(original);
  expect(decideAdminGameAction(next, payload, context)).toMatchObject({
    status: 'REJECTED',
    result: { code: 'TARGET_MISSING' },
  });
  expect(() =>
    applyRecordedInput(
      replay,
      {
        sequence: 1,
        tick: 11,
        generalId: null,
        kind: payload.action.kind,
        payload,
        status: outcome.status,
        result: outcome.result,
      },
      ruleRegistry,
    ),
  ).toThrow('변경 전후');
});

it('AC-INT-23 군주 내보내기를 거부하고 처리 tick이 없는 실행은 실패한다', () => {
  const replay = fixture();
  expect(
    decideAdminGameAction(replay, { ...payload, action: { ...payload.action, generalId: 1 } }, context),
  ).toMatchObject({ status: 'REJECTED', result: { code: 'INVALID_VALUE' } });
  expect(() =>
    decideAdminGameAction(replay, payload, {
      userActive: true,
      admin: true,
      sanctioned: false,
      replayFormat: 3,
      worldStatus: 'RUNNING',
    }),
  ).toThrow('처리 tick');
});

it('AC-INT-23 소유하거나 지휘하던 부곡을 해산하고 다른 지휘관의 도시로도 병력을 돌려준다', () => {
  const replay = fixture();
  for (const general of Object.values(replay.state.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0 });
  Object.assign(replay.state.generals[3]!, { userId: null, nationId: 1, cityKey: 1 });
  Object.assign(replay.state.generals[4]!, { userId: null, nationId: 1, cityKey: 3 });
  const campaign = emptyCampaignState(replay.state, 'remove-test', 'command-test');
  campaign.links = [
    { masterId: 1, personId: 3, relation: 'LIEUTENANT' },
    { masterId: 3, personId: 4, relation: 'LIEUTENANT' },
  ];
  campaign.units = [
    { id: 1, ownerId: 1, commanderId: 3, troops: 100, crewType: 1100, train: 50, atmos: 50 },
    { id: 2, ownerId: 3, commanderId: 4, troops: 200, crewType: 1100, train: 50, atmos: 50 },
  ];
  campaign.nextUnitId = 3;
  replay.state.campaign = campaign;
  const outcome = decideAdminGameAction(replay, payload, context);
  expect(outcome.status).toBe('APPLIED');
  expect(outcome.replay.state.campaign).toMatchObject({ revision: 1, units: [], links: [] });
  expect(outcome.replay.state.cities[1]!.population).toBe(replay.state.cities[1]!.population + 100);
  expect(outcome.replay.state.cities[3]!.population).toBe(replay.state.cities[3]!.population + 200);
  campaign.revision = 2_147_483_647;
  expect(decideAdminGameAction(replay, payload, context)).toMatchObject({
    status: 'REJECTED',
    result: { code: 'INVALID_VALUE' },
    replay,
  });
});

it('AC-INT-23 내보낸 재야 장수에게 등용 명령을 보낼 수 없다', () => {
  const replay = fixture();
  Object.assign(replay.state.generals[4]!, { removedAt: 0, nationId: null });
  expect(commandRegistry.get('invite')!.check(replay.state, { generalId: 1 }, { generalId: 4 })).toMatchObject({
    code: 'BAD_TARGET',
  });
});

it('AC-INT-23 직접 운영 입력도 현재 혼인을 정리하며 가문의 사망·계승 기록으로 바꾸지 않는다', () => {
  const replay = fixture();
  replay.state = lineageFixture();
  delete replay.state.governance;
  replay.state.ruleFeatures = ['lineage-v1'];
  replay.state.generals[3]!.officerLevel = 1;
  replay.state.lineage!.marriages = [{ id: 1, a: 3, b: 4, householdGeneralId: 3, sinceTick: 0 }];
  replay.state.lineage!.nextMarriageId = 2;
  assertLineageStorage(replay.state);
  const outcome = decideAdminGameAction(replay, payload, context);
  expect(outcome.status).toBe('APPLIED');
  expect(outcome.replay.state.lineage).toMatchObject({ revision: 1, marriages: [] });
  expect(outcome.replay.state.lineage!.persons['3']?.exit).toBeFalsy();
  expect(() => assertLineageStorage(outcome.replay.state)).not.toThrow();
  expect(replay.state.lineage!.marriages).toHaveLength(1);
  replay.state.lineage!.revision = 2_147_483_647;
  expect(decideAdminGameAction(replay, payload, context)).toMatchObject({
    status: 'REJECTED',
    result: { code: 'INVALID_VALUE' },
    replay,
  });
});

it('AC-INT-23 조정 직위도 퇴장과 함께 비우며 변경 번호 한도는 전체 조치를 거절한다', () => {
  const replay = fixture();
  replay.state = governanceFixture();
  replay.state.generals[6] = { ...replay.state.generals[1]!, id: 6, name: '조정장수', officerLevel: 1 };
  replay.state.governance!.throne = { emperorGeneralId: 1, emperorNationId: 1, sinceTick: 0 };
  replay.state.governance!.court.minister = { generalId: 6, appointedTick: 0 };
  assertGovernanceFinal(replay.state, 10);
  const input = { ...payload, action: { ...payload.action, generalId: 6 } };
  const outcome = decideAdminGameAction(replay, input, context);
  expect(outcome.status).toBe('APPLIED');
  expect(outcome.replay.state.governance).toMatchObject({ court: { minister: null }, revision: 1 });
  expect(() => assertGovernanceFinal(outcome.replay.state, 10)).not.toThrow();
  replay.state.governance!.revision = 2_147_483_647;
  expect(decideAdminGameAction(replay, input, context)).toMatchObject({
    status: 'REJECTED',
    result: { code: 'INVALID_VALUE' },
    replay,
  });
});

it('AC-INT-23 무주 도시 첩보의 현재 인원수에서 내보낸 장수를 제외한다', () => {
  const replay = fixture();
  Object.assign(replay.state.generals[4]!, { removedAt: 0, nationId: null, cityKey: 3, crew: 0 });
  expect(buildIntelRecord(replay.state, { generalId: 1, tick: 10 }, 3)).toMatchObject({ generals: 0, crew: 0 });
});
