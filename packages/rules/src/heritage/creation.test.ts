import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { buildCreatedGeneral, validateGeneralCreation } from '../general/create';
import { FIVE_STAT_RULES } from '../general/fiveStats';
import { applyRecordedInput, initialReplayState } from '../replay';
import { checkRuleFeatures } from '../ruleRegistry';
import { fiveStatsFeature, policyFeature } from '../ruleFeatures';
import { assertHeritageCreationResult, creationHeritageRecord } from './creation';
import { heritageFeature } from './feature';
import { GENERAL_PERSONALITY_FEATURE } from '../general/personality';

function fixture(five = false) {
  const initial = commandInitial();
  initial.ruleFeatures = [...(five ? ['five-stats'] : []), 'heritage-v1', 'policy'];
  const featureData = { 'heritage-v1': { version: 1 }, policy: { version: 1, turnTermMinutes: 60 } };
  if (five) {
    initial.statRules = FIVE_STAT_RULES;
    initial.generals = initial.generals.map((general) => ({ ...general, politics: 50, charm: 50 }));
  }
  const payload = {
    name: '유산장수',
    leadership: five ? 55 : 70,
    strength: five ? 55 : 70,
    intel: five ? 55 : 60,
    ...(five ? { politics: 55, charm: 55 } : {}),
    portraitId: null,
    heritage: five ? { politics: 3, charm: 3 } : { leadership: 3, intel: 3 },
  };
  const checked = validateGeneralCreation(payload, initial.statRules, false, true);
  if (!checked.ok) throw new Error(checked.message);
  const options = {
    payload: checked.value,
    seed: initial.seed,
    userId: 'heritage-user',
    id: Math.max(...initial.generals.map((general) => general.id)) + 1,
    startYear: initial.startYear,
    monthlyTick: 0,
    tick: 0,
    cityKeys: initial.cities.filter((city) => city.kind !== 'PASS').map((city) => city.cityKey),
    unitSet: initial.unitSet,
  };
  const general = buildCreatedGeneral(options),
    recorded = {
      kind: 'general.create',
      status: 'APPLIED' as const,
      sequence: 1,
      tick: 0,
      generalId: general.id,
      payload: checked.value,
      result: { general, activeTick: 0, heritage: creationHeritageRecord(checked.value.heritage)! },
    };
  const origin = {
    version: 3 as const,
    initial,
    initialStateHash: 'unused-in-feature-check',
    resourceHash: 'unused-in-feature-check',
    featureData,
  };
  return { initial, options, general, recorded, origin };
}

it.each([false, true])('AC-P2-33 %s 능력치 생성의 유산 배분·최종 값을 재생에 고정한다', (five) => {
  const { initial, recorded, general, origin } = fixture(five);
  expect(() => heritageFeature.checkArchive!({ origin, inputs: [recorded] })).not.toThrow();
  expect(() => policyFeature.checkArchive!({ origin, inputs: [recorded] })).not.toThrow();
  if (five) {
    expect(() => fiveStatsFeature.checkArchive!({ origin, inputs: [recorded] })).not.toThrow();
    const tampered = structuredClone(recorded);
    tampered.result.general.politics!++;
    expect(() => fiveStatsFeature.checkArchive!({ origin, inputs: [tampered] })).toThrow();
  }
  const next = applyRecordedInput(initialReplayState(initial, origin.featureData), recorded);
  expect(next.state.generals[general.id]).toEqual(general);
  expect(recorded.result.heritage.cost).toBe(6);
  expect(Object.hasOwn(general, 'heritage')).toBe(false);
  expect(five ? [general.politics, general.charm] : [general.leadership, general.intel]).toEqual(
    five ? [58, 58] : [73, 63],
  );
});

it('INT-26 선택한 성격과 기존 입력을 같은 생성 원장에서 재생한다', () => {
  const { initial, options, recorded, origin } = fixture(true);
  const payload = { ...options.payload, personality: '대의' };
  expect(validateGeneralCreation(payload, initial.statRules, false, true)).toMatchObject({ code: 'BAD_PERSONALITY' });
  expect(
    validateGeneralCreation({ ...payload, personality: '없는 성격' }, initial.statRules, false, true, true),
  ).toMatchObject({ code: 'BAD_PERSONALITY' });
  expect(validateGeneralCreation(payload, initial.statRules, false, true, true)).toMatchObject({ ok: true });
  initial.ruleFeatures!.push(GENERAL_PERSONALITY_FEATURE);
  const replay = initialReplayState(initial, origin.featureData);
  const general = buildCreatedGeneral({ ...options, payload });
  const withPersonality = { ...recorded, payload, result: { ...recorded.result, general } };
  expect(() => heritageFeature.checkArchive!({ origin, inputs: [withPersonality] })).not.toThrow();
  expect(() => fiveStatsFeature.checkArchive!({ origin, inputs: [withPersonality] })).not.toThrow();
  expect(applyRecordedInput(replay, withPersonality).state.generals[general.id]!.personality).toBe('대의');
  expect(applyRecordedInput(replay, recorded).state.generals[general.id]!.personality).toBeNull();
  expect(() =>
    applyRecordedInput(replay, { ...withPersonality, payload: { ...payload, personality: '의협' } }),
  ).toThrow('성격 생성 입력과 결과가 다릅니다.');
});
it('AC-P2-33 유산은 기존 도시·친화·턴 offset 난수 소비를 바꾸지 않는다', () => {
  const { options, general } = fixture();
  const { heritage, ...base } = options.payload;
  expect(heritage).toBeDefined();
  const plain = buildCreatedGeneral({ ...options, payload: base });
  expect([general.cityKey, general.affinity, general.nextTurnTick]).toEqual([
    plain.cityKey,
    plain.affinity,
    plain.nextTurnTick,
  ]);
  expect(Object.hasOwn(plain, 'heritage')).toBe(false);
  expect(validateGeneralCreation(base, { total: 200, min: 10, max: 80 })).toMatchObject({ ok: true });
  expect(validateGeneralCreation(options.payload, { total: 200, min: 10, max: 80 })).toMatchObject({
    ok: false,
    code: 'BAD_HERITAGE',
  });
});
it.each(['cost', 'bonus', 'stats', 'missing'] as const)('AC-P2-33 고정 생성 기록의 %s 위조를 거부한다', (field) => {
  const { initial, recorded, origin } = fixture();
  const bad = structuredClone(recorded);
  if (field === 'cost') bad.result.heritage.cost = 5;
  else if (field === 'bonus') bad.result.heritage.bonus.leadership = 2;
  else if (field === 'stats') bad.result.general.strength++;
  else Reflect.deleteProperty(bad.result, 'heritage');
  expect(() => heritageFeature.checkArchive!({ origin, inputs: [bad] })).toThrow();
  expect(() => applyRecordedInput(initialReplayState(initial, origin.featureData), bad)).toThrow();
});
it('AC-P2-33 끈 판은 배분·결과의 유산 칸을 모두 거부하고 켠 판도 생성 예산을 보존한다', () => {
  const { recorded, origin } = fixture();
  expect(() => assertHeritageCreationResult(recorded.payload, recorded.result, false, false)).toThrow();
  const bad = structuredClone(recorded);
  bad.payload.leadership++;
  bad.result.general.leadership++;
  expect(() => heritageFeature.checkArchive!({ origin, inputs: [bad] })).toThrow();
});
it('AC-P2-33 유산 기능은 정책 기능과 명시한 version1 설정을 요구한다', () => {
  expect(() => checkRuleFeatures(['heritage-v1'])).toThrow();
  expect(() => checkRuleFeatures(['heritage-v1', 'policy'])).not.toThrow();
  const { initial } = fixture();
  expect(() => heritageFeature.checkOrigin!({ initial, data: { version: 1 } })).not.toThrow();
  expect(() => heritageFeature.checkOrigin!({ initial, data: { version: 2 } })).toThrow();
});
