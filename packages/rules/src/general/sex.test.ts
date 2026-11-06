import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { buildCreatedGeneral, validateGeneralCreation } from './create';
import { assertGeneralSex, applySexLedger, sexLedgerSchema } from './sex';

it('AC-P2-32 새 판의 사람 성별은 직접 고르고 기존 판에는 넣지 못한다', () => {
  const rules = commandInitial().statRules,
    payload = { name: '새장수', leadership: 70, strength: 70, intel: 60, portraitId: null };
  expect(validateGeneralCreation(payload, rules)).toEqual({ ok: true, value: payload });
  for (const sex of [undefined, 'UNKNOWN', 'other', null])
    expect(validateGeneralCreation({ ...payload, ...(sex === undefined ? {} : { sex }) }, rules, true)).toMatchObject({
      ok: false,
      code: 'BAD_SEX',
    });
  for (const sex of ['MALE', 'FEMALE'] as const) {
    expect(validateGeneralCreation({ ...payload, sex }, rules)).toMatchObject({ ok: false, code: 'BAD_SEX' });
    expect(validateGeneralCreation({ ...payload, sex }, rules, true)).toMatchObject({ ok: true, value: { sex } });
  }
  expect(() => assertGeneralSex({ sex: 'UNKNOWN' }, true)).not.toThrow();
  expect(() => assertGeneralSex({}, true)).toThrow();
});

it('AC-P2-32 원장은 ID·이름이 일치하는 확인 인물만 적용하고 같은 이름을 추정하지 않는다', () => {
  const ledger = sexLedgerSchema.parse({
    version: 1,
    scenarios: ['known'],
    review: { status: 'approved', reviewer: '시험', evidence: '합성 원장', contentSha256: '0'.repeat(64) },
    rows: [
      {
        generalId: 2,
        name: '확인인물',
        identity: '試驗',
        sex: 'FEMALE',
        sourceId: 'fixture',
        sourceRevision: `sha256:${'0'.repeat(64)}`,
        evidence: { kind: 'primary-text', quotes: ['시험'], urls: ['https://example.invalid/source'] },
      },
    ],
  });
  const initial = {
      scenarioKey: 'known',
      generals: [
        { id: 2, name: '확인인물' },
        { id: 3, name: '미확인' },
      ],
    },
    before = structuredClone(initial);
  expect(applySexLedger(initial, ledger).map((general) => general.sex)).toEqual(['FEMALE', 'UNKNOWN']);
  for (const scenarioKey of ['known@1', 'known@2']) {
    expect(applySexLedger({ ...initial, scenarioKey }, ledger)).toEqual(applySexLedger(initial, ledger));
    expect(() => applySexLedger({ scenarioKey, generals: [{ id: 2, name: '다른인물' }] }, ledger)).toThrow('ID·이름');
  }
  expect(initial).toEqual(before);
  expect(applySexLedger({ ...initial, scenarioKey: 'other' }, ledger).map((general) => general.sex)).toEqual([
    'UNKNOWN',
    'UNKNOWN',
  ]);
  expect(() => applySexLedger({ ...initial, generals: [{ id: 2, name: '다른인물' }] }, ledger)).toThrow('ID·이름');
  expect(() => applySexLedger({ ...initial, generals: [{ id: 3, name: '미확인' }] }, ledger)).toThrow('ID·이름');
  expect(() => applySexLedger({ ...initial, generals: [{ id: 2, name: '확인인물', sex: 'MALE' }] }, ledger)).toThrow(
    '직접 성별',
  );
  const explicit = {
    scenarioKey: 'private',
    generals: [
      { id: 1, name: '첫째', sex: 'MALE' as const },
      { id: 2, name: '둘째', sex: 'UNKNOWN' as const },
    ],
  };
  expect(applySexLedger(explicit, ledger)).toEqual(explicit.generals);
  expect(() =>
    applySexLedger({ ...explicit, generals: [explicit.generals[0]!, { id: 3, name: '셋째' }] }, ledger),
  ).toThrow('일부만');
  expect(sexLedgerSchema.safeParse({ ...ledger, review: { ...ledger.review, status: 'pending' } }).success).toBe(false);
  expect(sexLedgerSchema.safeParse({ ...ledger, rows: [...ledger.rows, ...ledger.rows] }).success).toBe(false);
  expect(sexLedgerSchema.safeParse({ ...ledger, rows: [{ ...ledger.rows[0], sex: 'UNKNOWN' }] }).success).toBe(false);
});
it('AC-P2-32 성별 선택은 기존 도시·친화도·개인 턴 난수 순서를 바꾸지 않는다', () => {
  const initial = commandInitial(),
    payload = { name: '새장수', leadership: 70, strength: 70, intel: 60, portraitId: null };
  const input = {
    payload,
    seed: initial.seed,
    userId: 'new-player',
    id: 5,
    startYear: initial.startYear,
    monthlyTick: 0,
    tick: 0,
    cityKeys: initial.cities.map((c) => c.cityKey),
    unitSet: initial.unitSet,
  };
  const legacy = buildCreatedGeneral(input);
  for (const sex of ['MALE', 'FEMALE'] as const) {
    const { sex: chosen, ...general } = buildCreatedGeneral({ ...input, payload: { ...payload, sex } });
    expect(chosen).toBe(sex);
    expect(general).toEqual(legacy);
  }
  expect(Object.hasOwn(legacy, 'sex')).toBe(false);
});
