import { describe, expect, it } from 'vitest';
import { buildInitialWorld } from '../world/bootstrap';
import { mapFixture, scenarioFixture, unitFixture } from '../world/validate/testFixtures';
import { statRulesSchema } from '../world/resources';
import { checkReplayOrigin } from '../ruleRegistry';
import { applyRecordedInput, initialReplayState } from '../replay';
import { buildCreatedGeneral, validateGeneralCreation } from './create';
import {
  FIVE_STAT_KEYS,
  FIVE_STAT_RULES,
  FIVE_NPC_STAT_RULES,
  checkStatProfile,
  readGeneralFiveStats,
  fiveStatsSchema,
} from './fiveStats';
import { validatePolicyRecordedInput } from '../policy/replay';

const payload = { name: '새장수', leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55, portraitId: null };
const legacyRules = { total: 165, min: 15, max: 80 };
const legacyPayload = { name: payload.name, leadership: 55, strength: 55, intel: 55, portraitId: null };
it('턴의 능력치 읽기는 정본 스키마와 같은 값·누락·범위 오류를 판정하고 원본을 공유하지 않는다', () => {
  const base = { leadership: 0, strength: 100, intel: 50, politics: 90, charm: 10 };
  const read = readGeneralFiveStats({ ...base, id: 1, name: '원본' });
  expect(read).toEqual(fiveStatsSchema.parse(base));
  read.intel = 40;
  expect(base.intel).toBe(50);
  for (const key of FIVE_STAT_KEYS) {
    for (const value of [undefined, null, -1, 101, 0.5, NaN, Infinity, '50', true, {}, 50n]) {
      const invalid = { ...base, [key]: value };
      const canonical = fiveStatsSchema.safeParse(invalid);
      expect(canonical.success).toBe(false);
      if (canonical.success) throw new Error('잘못된 반례입니다.');
      let actual: unknown;
      try {
        readGeneralFiveStats(invalid);
      } catch (error) {
        actual = error;
      }
      expect(actual).toHaveProperty('issues', canonical.error.issues);
    }
  }
});
function resources(five = true) {
  const scenario = scenarioFixture();
  if (five)
    scenario.generalStats = [
      {
        generalId: 1,
        officerId: 10001,
        sourceId: 'test:1',
        sourceRevision: 'fixture-only',
        stats: { leadership: 0, strength: 100, intel: 50, politics: 90, charm: 10 },
      },
    ];
  return {
    map: mapFixture(),
    scenario,
    unitSet: unitFixture(),
    statRules: { stat: five ? FIVE_STAT_RULES : legacyRules },
    seed: 'five-stats-contract',
  };
}
function origin(five = true) {
  const initial = buildInitialWorld(resources(five));
  return {
    version: five ? 3 : 1,
    initial,
    initialStateHash: 'checked-in-transport',
    resourceHash: 'checked-in-transport',
  };
}

describe('INT-14 / AC-INT-14 5능력치 계약', () => {
  it('사람 생성 275와 15·90 경계를 지킨다', () => {
    expect(validateGeneralCreation(payload, FIVE_STAT_RULES).ok).toBe(true);
    expect(validateGeneralCreation({ ...payload, leadership: 15, strength: 90, intel: 60 }, FIVE_STAT_RULES).ok).toBe(
      true,
    );
    for (const value of [14, 91, 55.5, NaN, Infinity, -1, '55', null])
      expect(validateGeneralCreation({ ...payload, politics: value }, FIVE_STAT_RULES).ok).toBe(false);
    expect(validateGeneralCreation({ ...payload, charm: 56 }, FIVE_STAT_RULES).ok).toBe(false);
  });
  it('일반 NPC의 250·10~85 계약을 사람 생성과 구별한다', () => {
    const npc = { ...payload, leadership: 50, strength: 50, intel: 50, politics: 50, charm: 50 };
    expect(validateGeneralCreation(npc, FIVE_NPC_STAT_RULES).ok).toBe(true);
    expect(validateGeneralCreation(npc, FIVE_STAT_RULES).ok).toBe(false);
    expect(validateGeneralCreation({ ...npc, leadership: 10, strength: 85, intel: 55 }, FIVE_NPC_STAT_RULES).ok).toBe(
      true,
    );
    expect(validateGeneralCreation({ ...npc, leadership: 9, strength: 86, intel: 55 }, FIVE_NPC_STAT_RULES).ok).toBe(
      false,
    );
  });
  it.each(FIVE_STAT_KEYS)('새 판의 %s 누락을 추정하지 않는다', (key) => {
    const value: Record<string, unknown> = { ...payload };
    delete value[key];
    expect(validateGeneralCreation(value, FIVE_STAT_RULES).ok).toBe(false);
  });
  it('intel 이외 필드와 추가 입력을 거부하고 구형 입력은 보존한다', () => {
    expect(validateGeneralCreation({ ...payload, intelligence: 55 }, FIVE_STAT_RULES).ok).toBe(false);
    expect(validateGeneralCreation({ ...payload, userId: 'other' }, FIVE_STAT_RULES).ok).toBe(false);
    expect(validateGeneralCreation(payload, legacyRules).ok).toBe(false);
    expect(validateGeneralCreation(legacyPayload, legacyRules)).toEqual({ ok: true, value: legacyPayload });
    expect(statRulesSchema.parse({ stat: legacyRules })).toEqual({ stat: legacyRules });
  });
  it('역사 인물 0·100과 출처를 받고 ID·누락·중복 대응을 거부한다', () => {
    const input = resources();
    expect(buildInitialWorld(input).generals[0]).toMatchObject(input.scenario.generalStats![0]!.stats);
    for (const rows of [
      [],
      [...input.scenario.generalStats!, ...input.scenario.generalStats!],
      [{ ...input.scenario.generalStats![0]!, generalId: 2 }],
    ])
      expect(() => buildInitialWorld({ ...input, scenario: { ...input.scenario, generalStats: rows } })).toThrow();
    expect(() =>
      buildInitialWorld({
        ...input,
        scenario: { ...input.scenario, generalStats: [{ ...input.scenario.generalStats![0]!, sourceId: '' }] },
      }),
    ).toThrow();
    expect(() => buildInitialWorld({ ...input, statRules: { stat: legacyRules } })).toThrow();
  });
  it('생성 기록의 판과 값이 일치해야 하며 구형 해시에 키를 추가하지 않는다', () => {
    const old = origin(false);
    expect(() => checkReplayOrigin(old)).not.toThrow();
    expect(Object.hasOwn(old.initial.generals[0]!, 'politics')).toBe(false);
    expect(() => checkReplayOrigin(origin())).not.toThrow();
    const bad = origin();
    delete bad.initial.generals[0]!.charm;
    expect(() => checkReplayOrigin(bad)).toThrow();
    const mismatch = origin();
    delete mismatch.initial.ruleFeatures;
    expect(() => checkStatProfile(mismatch.initial)).toThrow();
    expect(buildInitialWorld(resources(false))).toEqual(old.initial);
  });
  it('시드 생성과 재생은 5값을 보존하고 결과 위조를 거부한다', () => {
    const initial = origin().initial;
    const input = {
      payload,
      seed: initial.seed,
      userId: 'human',
      id: 2,
      startYear: initial.startYear,
      monthlyTick: 0,
      tick: 0,
      cityKeys: [1, 2],
      unitSet: initial.unitSet,
    };
    const general = buildCreatedGeneral(input);
    expect(buildCreatedGeneral(input)).toEqual(general);
    const recorded = {
      sequence: 1,
      tick: 0,
      kind: 'general.create',
      generalId: 2,
      status: 'APPLIED' as const,
      payload,
      result: { general },
    };
    const replay = initialReplayState(initial);
    expect(applyRecordedInput(replay, recorded).state.generals[2]).toEqual(general);
    expect(() =>
      applyRecordedInput(replay, { ...recorded, result: { general: { ...general, politics: 56 } } }),
    ).toThrow();
    expect(() => applyRecordedInput(initialReplayState(origin(false).initial), recorded)).toThrow();
    const { tick: ignored, ...policyRecord } = recorded;
    void ignored;
    const policyInput = { ...policyRecord, result: { general, activeTick: 0 } };
    expect(() => validatePolicyRecordedInput(policyInput, true)).toThrow();
    expect(() => validatePolicyRecordedInput(policyInput, true, true)).not.toThrow();
  });
});
