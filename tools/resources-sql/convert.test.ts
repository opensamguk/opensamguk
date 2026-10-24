import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateWorldResources } from '../../packages/rules/src/world/validate/index';
import { hashState } from '../../packages/shared/src/node/hashState';
import {
  BODY_TAG,
  CONTENT_TAG,
  convertResourcesToSql,
  requirePassingReport,
  RESOURCE_INPUTS,
  type ResourceTexts,
} from './convert';

const root = new URL('../../', import.meta.url);
const input = Object.fromEntries(
  await Promise.all(
    RESOURCE_INPUTS.map(async (resource) => [resource.slot, await readFile(new URL(resource.path, root), 'utf8')]),
  ),
) as ResourceTexts;
const notice = await readFile(new URL('resources/NOTICE.md', root), 'utf8');
const baseline = JSON.parse(await readFile(new URL('tools/fixtures/t4-77-baseline.json', root), 'utf8')) as {
  resources: Record<string, { contentHash: string; lfBytes: number }>;
};
const sql = convertResourcesToSql(input, notice);
const contents = [...sql.matchAll(/resource_content := \$t4_77_content\$([\s\S]*?)\$t4_77_content\$::jsonb;/g)].map(
  (match) => match[1]!,
);

function changedMap(value: unknown): ResourceTexts {
  return { ...input, map: JSON.stringify(value) };
}

describe('T4-77 S2a 초기화 SQL', () => {
  it('다섯 실제 원본은 검증기를 통과하고 원래 외교 경고 하나만 남는다', () => {
    const parsed = Object.fromEntries(Object.entries(input).map(([key, raw]) => [key, JSON.parse(raw)])) as Record<
      keyof ResourceTexts,
      unknown
    >;
    const report = validateWorldResources(parsed);
    expect(report.status).toBe('pass');
    expect(report.scenario.issues.map((issue) => issue.code)).toEqual(['scenario-diplomacy-duplicate']);
    for (const slot of ['map', 'unitSet', 'statRules', 'portraitMap'] as const) expect(report[slot].issues).toEqual([]);
  });

  it('같은 원본의 두 변환과 생성 파일은 같은 바이트다', async () => {
    expect(convertResourcesToSql(input, notice)).toBe(sql);
    const generated = await readFile(new URL('packages/db/sql/resources-init.sql', root), 'utf8');
    expect(generated.replaceAll('\r\n', '\n')).toBe(sql);
    expect(sql).not.toContain('\r');
    expect(sql.endsWith('\n')).toBe(true);
    expect(sql.endsWith('\n\n')).toBe(false);
  });

  it('원본과 NOTICE의 CRLF는 LF 입력과 같은 SQL을 만든다', () => {
    const crlf = Object.fromEntries(
      Object.entries(input).map(([key, raw]) => [key, raw.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]),
    ) as ResourceTexts;
    expect(convertResourcesToSql(crlf, notice.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))).toBe(sql);
  });

  it.each(RESOURCE_INPUTS)('$kind 원본 전체 값과 S0 해시·바이트를 보존한다', (resource) => {
    const index = RESOURCE_INPUTS.indexOf(resource);
    const content = JSON.parse(contents[index]!);
    expect(content).toEqual(JSON.parse(input[resource.slot]));
    expect(hashState(content)).toBe(baseline.resources[resource.path]!.contentHash);
    expect(resource.contentHash).toBe(baseline.resources[resource.path]!.contentHash);
    expect(Buffer.byteLength(contents[index]!)).toBe(baseline.resources[resource.path]!.lfBytes);
  });

  it('로더가 쓰지 않는 원본 칸도 SQL 내용에 남는다', () => {
    expect(JSON.parse(contents[0]!)).toHaveProperty('meta');
    expect(JSON.parse(contents[1]!)).toHaveProperty('general_ex');
    expect(JSON.parse(contents[4]!)).toHaveProperty('ambiguous');
    for (const raw of contents) expect(JSON.parse(raw)).toHaveProperty('$comment');
  });

  it('검증기가 받는 원본이라도 추가 칸으로 S0 해시가 달라지면 거부한다', () => {
    const modified = { ...JSON.parse(input.map), s2aExtra: '내용을 바꾸지 않는다' };
    expect(() => convertResourcesToSql(changedMap(modified), notice)).toThrow('S0 해시 불일치: MAP/che/1');
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

  it('실제 검증기의 fail은 SQL을 만들기 전에 거부한다', () => {
    expect(() => convertResourcesToSql(changedMap(null), notice)).toThrow('검증 실패: MAP/che/1');
  });

  it.each(['fail', 'incomplete'] as const)('%s 보고는 통과로 세지 않는다', (status) => {
    expect(() => requirePassingReport({ status })).toThrow(`검증 실패: ${status}`);
  });

  it('pass 보고만 허용한다', () => {
    expect(() => requirePassingReport({ status: 'pass' })).not.toThrow();
  });

  it('MIT 전문과 초상 출처를 포함한 NOTICE 전체를 글자 그대로 옮긴다', () => {
    const commentedNotice = sql.slice(sql.indexOf('\n') + 1, sql.indexOf(`\n\nDO ${BODY_TAG}`));
    const restored = commentedNotice
      .split('\n')
      .map((line) => (line === '--' ? '' : line.slice(3)))
      .join('\n');
    expect(restored).toBe(notice.replaceAll('\r\n', '\n'));
    expect(restored).toContain('Copyright (c) 2025 devsam');
    expect(restored).toContain('## 초상 메타데이터와 한자 독음 표');
    expect(restored).not.toBe(notice.replace('2025 devsam', '2024 devsam').replaceAll('\r\n', '\n'));
  });

  it('다섯 source는 원 경로와 기존 출처 문구를 그대로 담는다', () => {
    const expected = [
      'resources/map/che.json; Source: core2026 df6c926 / resources/map/map_che.json; MIT (c) 2025 devsam. See resources/NOTICE.md.',
      'resources/scenario/1030.json; Source: core2026 df6c926 / resources/scenario/scenario_1030.json; MIT (c) 2025 devsam. See resources/NOTICE.md.',
      'resources/unitset/basic.json; Source: core2026 df6c926 / resources/unitset/unitset_basic.json; MIT (c) 2025 devsam. See resources/NOTICE.md.',
      'resources/scenario/default.json; Source: core2026 df6c926 / resources/scenario/default.json; MIT (c) 2025 devsam. See resources/NOTICE.md.',
      'resources/portraits/rtk14-map.json; Generated by pnpm portraits:map. Sources and licenses: resources/NOTICE.md. Ambiguous or unmatched names stay null.',
    ];
    for (const source of expected) expect(sql.split(`'${source}'`)).toHaveLength(3);
  });

  it('트랜잭션 명령 없는 단일 DO 안에서 다섯 삽입 뒤 각 행을 대조한다', () => {
    expect(contents).toHaveLength(5);
    const withoutContent = sql.replace(/\$t4_77_content\$[\s\S]*?\$t4_77_content\$/g, '').replace(/^--.*\n/gm, '');
    expect(withoutContent.match(/\bDO\b/g)).toHaveLength(6); // DO 문 하나와 DO NOTHING 다섯이다.
    expect(withoutContent.match(/ON CONFLICT \("kind", "name", "version"\) DO NOTHING;/g)).toHaveLength(5);
    expect(withoutContent.match(/IF NOT EXISTS \(/g)).toHaveLength(5);
    expect(withoutContent.match(/AND "content" = resource_content AND "contentHash" = '[0-9a-f]{64}'/g)).toHaveLength(
      5,
    );
    expect(withoutContent.match(/AND "status" = 'PUBLISHED' AND "source" = /g)).toHaveLength(5);
    expect(withoutContent).not.toMatch(/\b(COMMIT|ROLLBACK)\b|DO UPDATE/);
    const bodyStart = withoutContent.indexOf(`DO ${BODY_TAG}`);
    expect(withoutContent.slice(0, bodyStart).trim()).toBe('');
    expect(withoutContent).toContain(`END;\n${BODY_TAG};\n`);
    const errors = [...withoutContent.matchAll(/RAISE EXCEPTION '([^']+)';/g)].map((match) => match[1]);
    expect(errors).toEqual(RESOURCE_INPUTS.map((resource) => `초기화 자원 충돌: ${resource.kind}/${resource.name}/1`));
  });
});
