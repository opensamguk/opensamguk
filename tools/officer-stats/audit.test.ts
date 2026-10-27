import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { adaptOfficerStats, auditOfficerLedger, ledgerSchema, officerContentHash, sha256Text } from './audit';

const root = new URL('../../', import.meta.url);
const main = await readFile(new URL('resources/scenario/1030.json', root), 'utf8');
const sources = await readFile(new URL('tools/fixtures/int16-selected-officers.json', root), 'utf8');
const original = ledgerSchema.parse(
  JSON.parse(await readFile(new URL('resources/officers/191-five-stats.json', root), 'utf8')),
);
const copy = () => structuredClone(original);

describe('AC-INT-16 191년 인물 출처 원장', () => {
  it('main491개 ID·순서·21국 원문을 보존하며 483명 원장과 보충8명을 대조한다', () => {
    const rows = auditOfficerLedger(main, sources, original, false);
    expect(rows).toHaveLength(491);
    expect(new Set(rows.map((row) => row.generalId)).size).toBe(491);
    expect(rows.every((row) => Object.keys(row.stats).join() === 'leadership,strength,intel,politics,charm')).toBe(
      true,
    );
    expect(JSON.parse(sources).originalSha256).toBe('e4bc491e14733b46a45606273a7bc3a6dd3bc4082e96eb057a2fc00b83cae1c3');
  });

  it.each([
    [1, '劉辯', 20001],
    [2, '劉協', 20002],
    [63, '魯粛', 10974],
    [190, '荀彧', 10670],
    [197, '沈瑩', 10527],
    [233, '禰衡', 20233],
    [262, '于禁', 10013],
    [263, '牛金', 10550],
    [293, '劉表', 10101],
    [294, '劉豹', 10103],
    [354, '典韋', 10066],
    [355, '全禕', 10052],
    [414, '州泰', 10293],
    [415, '周泰', 10173],
  ])('동명이인·다른 숫자 별칭 %i는 해당 인물 %s의 ID에만 연결한다', (id, identity, officerId) => {
    expect(original.rows[Number(id) - 1]).toMatchObject({ identity, officerId });
  });

  it('길평은 사용자가 확정한 팬 제작값과 출처·승인 근거를 함께 남긴다', () => {
    expect(original.rows[5]).toMatchObject({
      name: '길평',
      stats: { leadership: 29, strength: 10, intel: 56, politics: 54, charm: 70 },
      evidence: { kind: 'user-adopted-fan-data', approval: expect.stringContaining('사용자') },
    });
    const forged = copy();
    delete forged.rows[5]!.evidence.approval;
    expect(() => auditOfficerLedger(main, sources, forged, false)).toThrow('확정 근거');
  });

  it('검수 대기 원장을 공개할 수 없고 내용이 바뀌면 이전 리뷰를 재사용할 수 없다', () => {
    const draft = copy();
    draft.review = { status: 'pending' };
    expect(() => auditOfficerLedger(main, sources, draft)).toThrow('독립 리뷰');
    draft.review = {
      status: 'approved',
      reviewer: 'test-only-review-fixture',
      evidence: 'unit fixture only; this is not actual acceptance',
      contentSha256: officerContentHash(draft),
    };
    expect(auditOfficerLedger(main, sources, draft)).toHaveLength(491);
    draft.rows[0]!.evidence.note += 'changed';
    expect(() => auditOfficerLedger(main, sources, draft)).toThrow('독립 리뷰');
  });

  it('누락·중복·다른 인물 결합·출처 수치 위조·원본 변경을 거부한다', () => {
    const missing = copy();
    missing.rows.pop();
    expect(() => auditOfficerLedger(main, sources, missing, false)).toThrow();
    const duplicate = copy();
    duplicate.rows[6] = { ...duplicate.rows[7]!, generalId: 7, name: '가규' };
    expect(() => auditOfficerLedger(main, sources, duplicate, false)).toThrow('중복');
    const forged = copy();
    forged.rows[196]!.officerId = 10274;
    expect(() => auditOfficerLedger(main, sources, forged, false)).toThrow('출처와');
    const wrongStat = copy();
    wrongStat.rows[6]!.stats.politics++;
    expect(() => auditOfficerLedger(main, sources, wrongStat, false)).toThrow('출처와');
    expect(() => auditOfficerLedger(main + '\n', sources, original, false)).toThrow('main 시나리오');
    expect(() => auditOfficerLedger(main, sources + '\n', original, false)).toThrow('출처 사본');
  });

  it('v1 intelligence는 어댑터에서만 바꾸며 누락·NaN·비정수·범위 밖·추가 intel을 거부한다', () => {
    const value = { leadership: 0, strength: 100, intelligence: 50, politics: 33, charm: 90 };
    expect(adaptOfficerStats(value)).toEqual({ leadership: 0, strength: 100, intel: 50, politics: 33, charm: 90 });
    for (const invalid of [
      { ...value, politics: undefined },
      { ...value, charm: Number.NaN },
      { ...value, intelligence: 2.5 },
      { ...value, strength: 101 },
      { ...value, intel: 50 },
    ])
      expect(() => adaptOfficerStats(invalid)).toThrow();
    expect(sha256Text(main)).toBe(original.mainSha256);
  });
});
