import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BODY_TAG,
  CONTENT_TAG,
  convertResourcesToSql,
  requirePassingReport,
  RESOURCE_INPUTS,
  type ResourceTexts,
} from './convert';
import { INITIAL_NOTICE_FIXTURE, verifyInitialNotice } from './notice';
const root = new URL('../../', import.meta.url);
const input: ResourceTexts = { map: '{}', scenario: '{}', unitSet: '{}', statRules: '{}', portraitMap: '{}' };
const notice = verifyInitialNotice(await readFile(new URL(INITIAL_NOTICE_FIXTURE, root), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('tools/fixtures/t4-77-baseline.json', root), 'utf8')) as {
  resources: Record<string, { contentHash: string }>;
  resourcesInitSqlSha256: string;
};
const sql = await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8');
function changedMap(value: unknown): ResourceTexts {
  return { ...input, map: JSON.stringify(value) };
}
describe('T4-77 S2a 초기화 SQL', () => {
  it('커밋한 초기화 SQL은 삭제 직전 sha256과 LF 끝 형식을 보존한다', () => {
    expect(createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex')).toBe(
      baseline.resourcesInitSqlSha256,
    );
    expect(sql).not.toContain('\r');
    expect(sql.endsWith('\n')).toBe(true);
    expect(sql.endsWith('\n\n')).toBe(false);
  });

  it.each(RESOURCE_INPUTS)('$kind 원본 전체 값과 S0 해시·바이트를 보존한다', (resource) => {
    const expected = Object.values(baseline.resources)[RESOURCE_INPUTS.indexOf(resource)]!;
    expect(resource.contentHash).toBe(expected.contentHash);
    expect(sql.split(`'${expected.contentHash}'`)).toHaveLength(3);
  });

  it.each([CONTENT_TAG, BODY_TAG])('원본 내용의 %s 구분자 충돌을 키만 적어 거부한다', (tag) => {
    const modified = { ...JSON.parse(input.map), extra: `비공개 원문 ${tag}` };
    expect(() => convertResourcesToSql(changedMap(modified), notice)).toThrow('구분자 충돌: MAP/che/1');
    expect(() => convertResourcesToSql(changedMap(modified), notice)).not.toThrow('비공개 원문');
  });

  it.each([
    ['값', '{"secret":"숨긴값\\u0000"}'],
    ['키', '{"숨긴키\\u0000":1}'],
    ['중첩 배열', '{"a":[{"b":"\\u0000"}]}'],
  ])('%s의 NUL을 키만 적어 거부한다', (_, raw) => {
    expect(() => convertResourcesToSql({ ...input, map: raw }, notice)).toThrow('NUL 문자: MAP/che/1');
  });

  it.each(['{"a":"\0"}', '{"숨긴원문":'])('날 NUL이나 잘못된 JSON을 내용 없이 거부한다 (%#)', (raw) => {
    const convert = () => convertResourcesToSql({ ...input, map: raw }, notice);
    expect(convert).toThrow('JSON 오류: MAP/che/1');
    expect(convert).not.toThrow('숨긴원문');
  });

  it.each(['fail', 'incomplete'] as const)('%s 보고는 통과로 세지 않는다', (status) => {
    expect(() => requirePassingReport({ status })).toThrow(`검증 실패: ${status}`);
  });

  it('pass 보고만 허용한다', () => {
    expect(() => requirePassingReport({ status: 'pass' })).not.toThrow();
  });
});
