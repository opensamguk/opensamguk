import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildInitialWorld } from '../packages/rules/src/index';
import { validateWorldResources } from '../packages/rules/src/world/validate/index';
import { hashState } from '../packages/shared/src/node/hashState';
import fixture from './fixtures/t4-46-scenarios.json';
import {
  convertScenariosToSql,
  readyScenarioRows,
  scenarioRows,
  SCENARIO_BODY_TAG,
  SCENARIO_CONTENT_TAG,
  type ScenarioRow,
} from './resources-sql/generate-scenarios';
import { BODY_TAG, CONTENT_TAG } from './resources-sql/convert';

const root = new URL('../', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
const materials = {
  map: await read('resources/map/che.json'),
  unitSet: await read('resources/unitset/basic.json'),
  statRules: await read('resources/scenario/default.json'),
  portraitMap: await read('resources/portraits/rtk14-map.json'),
};
interface ScenarioCase extends ScenarioRow {
  originalText: string;
  correction: {
    nationIndex: number;
    cityListIndex: number;
    cityName: string;
    keptIndex: number;
    removedIndex: number;
  } | null;
  expected: { cities: number; nations: number; generals: number; startYear: number };
  initialHashes: Record<string, string>;
  validationWarnings: Array<{ slot: string; code: string }>;
}
const cases = fixture.scenarios.filter((row) => row.support === 'ready') as unknown as ScenarioCase[];
const input: Record<string, string> = Object.fromEntries(
  await Promise.all(
    cases.map(async ({ key }) => [key, await readFile(new URL(`resources/scenario/${key}.json`, root), 'utf8')]),
  ),
);
const notice = await readFile(new URL('resources/NOTICE.md', root), 'utf8');
const convert = (texts = input, rows: readonly ScenarioRow[] = scenarioRows, sourceNotice = notice) =>
  convertScenariosToSql(texts, sourceNotice, materials, rows);
const sql = convert();
const contents = () =>
  [...sql.matchAll(/resource_content := \$t4_46_content\$([\s\S]*?)\$t4_46_content\$::jsonb;/g)].map(
    (match) => JSON.parse(match[1]!) as { id: string },
  );

describe('T4-46 / AC-P2-24 A9 출처와 합성', () => {
  it('S0 원작 tree에서 대조한 83키·blob·sha256을 고정한다', () => {
    const expected = `0 1 2 900 901 902 903 904 905 906 908 910 911 912 913 914 915 916
1010 1020 1021 1030 1031 1040 1041 1050 1060 1070 1080 1090 1100 1110 1120
2010 2011 2012 2020 2030 2040 2050 2060 2070 2080 2090 2100 2101 2102 2110
2120 2121 2130 2131 2140 2141 2150 2151 2160 2171 2180 2190 2191 2200 2210
2220 2221 2300 2400 2401 2500 2501 2600 2601 2700 2701 2702 2703 2704 2800
2801 2900 2901 2903 2904`.split(/\s+/);
    expect(fixture.commit).toBe('df6c9269fa1e2862418ba9da481c8dd2d758d6c5');
    expect(fixture.inventorySHA256).toBe('d9b6dc75f77ab12b8dca9c0ebee56e6f5bfc3a046172a59fae1f75cac846b739');
    expect(scenarioRows.map(({ key }) => key)).toEqual(expected);
    expect(scenarioRows).toHaveLength(83);
    expect(hashState(scenarioRows.map(({ key, path, blob, sha256 }) => ({ key, path, blob, sha256 })))).toBe(
      'e6bcbe2c3bf251b02c488e20c09aea65d83d9959d068dbe0dcecb463a5757284',
    );
    for (const row of scenarioRows) {
      expect(row.path).toBe(`resources/scenario/scenario_${row.key}.json`);
      expect(row.blob).toMatch(/^[a-f0-9]{40}$/);
      expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('S0 준비 9종만 생성하고 기존1·방랑대기2·미검증71은 남겨 둔다', () => {
    const counts = scenarioRows.reduce<Record<string, number>>((sum, row) => {
      sum[row.support] = (sum[row.support] ?? 0) + 1;
      return sum;
    }, {});
    expect(counts).toEqual({ ready: 9, existing: 1, blocked: 2, unverified: 71 });
    expect(scenarioRows.filter(({ support }) => support === 'existing').map(({ key }) => key)).toEqual(['1030']);
    expect(scenarioRows.filter(({ support }) => support === 'blocked').map(({ key }) => key)).toEqual(['1050', '1080']);
    const bundles = {
      A: ['1010', '1020', '1040', '1060', '1070', '1090', '1100', '1110', '1120'],
      B: ['1050', '1080'],
      C: ['1021', '1031', '1041'],
      existing: ['1030'],
      D: [
        '0',
        '1',
        '2',
        '900',
        '901',
        '902',
        '903',
        '904',
        '905',
        '906',
        '908',
        '910',
        '911',
        '912',
        '913',
        '914',
        '915',
        '916',
      ],
    };
    for (const [bundle, keys] of Object.entries(bundles))
      expect(scenarioRows.filter((row) => row.bundle === bundle).map(({ key }) => key)).toEqual(keys);
    expect(scenarioRows.filter(({ bundle }) => bundle === 'E')).toHaveLength(50);
    expect(readyScenarioRows().map(({ key }) => key)).toEqual([
      '1010',
      '1020',
      '1040',
      '1060',
      '1070',
      '1090',
      '1100',
      '1110',
      '1120',
    ]);
    expect(contents().map(({ id }) => id)).toEqual(readyScenarioRows().map(({ key }) => key));
    for (const row of scenarioRows.filter((row) => row.support !== 'ready')) {
      expect(row.reason.trim()).not.toBe('');
      expect(row.resourceKey).toBeNull();
      expect(row.contentHash).toBeNull();
    }
    expect(convert({ ...input, '1050': 'invalid JSON', '2010': 'invalid JSON' })).toBe(sql);
    expect(fixture.$comment).toContain('MIT (c) 2025 devsam');
  });

  it.each(cases)('S1 $key 원작 바이트와 하비 최소 수정만 보존한다', (row) => {
    expect(createHash('sha256').update(row.originalText).digest('hex')).toBe(row.sha256);
    const original = JSON.parse(row.originalText) as Record<string, unknown>;
    const copy = JSON.parse(input[row.key]!) as Record<string, unknown>;
    expect(copy.$comment).toContain(`core2026 df6c926 / ${row.path}; MIT (c) 2025 devsam`);
    expect(copy.id).toBe(row.key);
    delete copy.$comment;
    delete copy.id;
    if (row.correction) {
      const change = row.correction;
      const cities = (copy.nation as unknown[][])[change.nationIndex]![change.cityListIndex] as string[];
      expect(cities[change.keptIndex]).toBe('하비');
      expect(cities.filter((name) => name === '하비')).toHaveLength(1);
      cities.splice(change.removedIndex, 0, change.cityName);
    }
    expect(copy).toEqual(original);
    expect(hashState(JSON.parse(input[row.key]!))).toBe(row.contentHash);
    const comment = JSON.parse(input[row.key]!).$comment as string;
    const canonical = { $comment: comment, id: row.key, ...JSON.parse(row.originalText) };
    if (row.correction) {
      const change = row.correction;
      canonical.nation[change.nationIndex][change.cityListIndex].splice(change.removedIndex, 1);
    }
    expect(input[row.key]!.replaceAll('\r\n', '\n')).toBe(JSON.stringify(canonical, null, 2) + '\n');
  });

  it.each(cases)('S2 $key 실제 검증기와 합성의 행 수·시작 연도를 확인한다', (row) => {
    const scenario = JSON.parse(input[row.key]!);
    const report = validateWorldResources({ ...materials, scenario });
    expect(report.status).toBe('pass');
    const warnings = Object.entries(report).flatMap(([slot, value]) =>
      typeof value === 'object' ? value.issues.map(({ code }) => ({ slot, code })) : [],
    );
    expect(warnings).toEqual(row.validationWarnings);
    const initial = buildInitialWorld({ ...materials, scenario, seed: 't4-46-a' });
    expect({
      cities: initial.cities.length,
      nations: initial.nations.length,
      generals: initial.generals.length,
      startYear: initial.startYear,
    }).toEqual(row.expected);
  });

  it.each(
    cases.flatMap((row) =>
      Object.entries(row.initialHashes).map(([seed, expected]) => ({ key: row.key, seed, expected })),
    ),
  )('S3 $key $seed 두 합성이 독립 고정 해시와 같다', ({ key, seed, expected }) => {
    const scenario = JSON.parse(input[key]!);
    expect(hashState(buildInitialWorld({ ...materials, scenario, seed }))).toBe(expected);
    expect(hashState(buildInitialWorld({ ...materials, scenario, seed }))).toBe(expected);
  });

  it('S4 생성 SQL 바이트·숫자 정렬·단일 DO와 출처를 보존한다', async () => {
    expect(
      (await readFile(new URL('packages/db/sql/resources-scenarios.sql', root), 'utf8')).replaceAll('\r\n', '\n'),
    ).toBe(sql);
    expect(convert()).toBe(sql);
    expect(
      convert(
        Object.fromEntries(
          Object.entries(input).map(([key, raw]) => [key, raw.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]),
        ),
      ),
    ).toBe(sql);
    expect(sql).not.toContain('\r');
    expect(sql).toContain('Copyright (c) 2025 devsam');
    expect(sql).toContain('tools/fixtures/t4-46-scenarios.json');
    const body = sql.replace(/^--.*\n/gm, '').replace(/\$t4_46_content\$[\s\S]*?\$t4_46_content\$/g, '');
    expect(body.match(/DO \$t4_46_init\$/g)).toHaveLength(1);
    expect(body.match(/ON CONFLICT \("kind", "name", "version"\) DO NOTHING/g)).toHaveLength(9);
    expect(body.match(/IF NOT EXISTS/g)).toHaveLength(9);
    expect(body).not.toMatch(/DO UPDATE|\bCOMMIT\b|\bROLLBACK\b/);
    for (const row of cases) expect(sql).toContain(row.source!.replaceAll("'", "''"));
  });

  it.each(['1030', 'che', 'basic', 'default', 'rtk14-map'])('S4 내장 키 %s를 거부한다', (key) => {
    expect(() => convert({ ...input, [key]: '{}' })).toThrow('내장 자원');
  });

  it.each([SCENARIO_CONTENT_TAG, SCENARIO_BODY_TAG, CONTENT_TAG, BODY_TAG])(
    'S4 %s 태그 충돌은 키만 내고 거부한다',
    (tag) => {
      const raw = JSON.stringify({ ...JSON.parse(input['1010']!), secret: `숨긴 원문 ${tag}` });
      expect(() => convert({ ...input, '1010': raw })).toThrow('구분자 충돌: SCENARIO/1010/1');
      expect(() => convert({ ...input, '1010': raw })).not.toThrow('숨긴 원문');
    },
  );

  it.each(['{"x":"\\u0000"}', '{"x\\u0000":1}', '{"x":[{"a":"\\u0000"}]}'])('S4 중첩 NUL을 거부한다 (%#)', (raw) => {
    expect(() => convert({ ...input, '1010': raw })).toThrow('NUL 문자: SCENARIO/1010/1');
  });

  it.each(['{"a":"\0"}', '{"숨긴 원문":'])('S4 잘못된 JSON 내용을 출력하지 않는다 (%#)', (raw) => {
    expect(() => convert({ ...input, '1010': raw })).toThrow('JSON 오류: SCENARIO/1010/1');
    expect(() => convert({ ...input, '1010': raw })).not.toThrow('숨긴 원문');
  });

  it('S4 source와 JSON의 작은따옴표를 보존한다', () => {
    const content = { ...JSON.parse(input['1010']!), $comment: "Source: 'quoted' source" };
    const source = "original's 'source'";
    const rows = scenarioRows.map((row) =>
      row.key === '1010' ? { ...row, source, contentHash: hashState(content) } : row,
    );
    const quoted = convert({ ...input, '1010': JSON.stringify(content) }, rows);
    expect(quoted).toContain("'original''s ''source'''");
    const raw = [
      ...quoted.matchAll(/resource_content := \$t4_46_content\$([\s\S]*?)\$t4_46_content\$::jsonb;/g),
    ][0]![1]!;
    expect(JSON.parse(raw)).toEqual(content);
  });

  it('S4 source·NOTICE NUL과 상수 해시 불일치를 거부한다', () => {
    expect(() =>
      convert(
        input,
        scenarioRows.map((row) => (row.key === '1010' ? { ...row, source: 'x\0' } : row)),
      ),
    ).toThrow('NUL 문자');
    expect(() => convert(input, scenarioRows, 'x\0')).toThrow('출처에 NUL');
    expect(() => convert({ ...input, '1010': JSON.stringify({ ...JSON.parse(input['1010']!), extra: 1 }) })).toThrow(
      '상수 해시 불일치',
    );
    expect(() => convert({ ...input, '1010': undefined! })).toThrow('원문이 없습니다');
  });
});
