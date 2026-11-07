import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import fixture from './fixtures/t4-46-scenarios.json';
import { scenarioRows, type ScenarioRow } from './resources-sql/generate-scenarios';

const root = new URL('../', import.meta.url);
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

describe('T4-46 / AC-P2-24 추가 시나리오의 출처와 합성', () => {
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

  it.each(cases)('S1 $key 원작 바이트와 승인된 최소 수정만 보존한다', (row) => {
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
    if (row.unitSet === 'che') {
      expect(copy).toMatchObject({
        lastNationRecruitmentLockYear: 183,
        requiredUnitSet: 'che',
      });
      delete copy.lastNationRecruitmentLockYear;
      delete copy.requiredUnitSet;
      if (!Object.hasOwn(original, 'diplomacy')) delete copy.diplomacy;
      if (row.key === '1021') {
        expect(copy.openingCityProfile).toBe('legacy-research-70');
        delete copy.openingCityProfile;
        const cities = (copy.nation as unknown[][]).find(([name]) => name === '도겸')![8] as string[];
        expect(cities).toEqual(['서주', '하비', '광릉']);
        cities.splice(1, 2, '하비.광릉');
      } else {
        expect(original.startYear).toBeUndefined();
        expect(copy.startYear).toBe(180);
        delete copy.startYear;
      }
    }
    expect(copy).toEqual(original);
    expect(hashState(JSON.parse(input[row.key]!))).toBe(row.contentHash);
    const comment = JSON.parse(input[row.key]!).$comment as string;
    const canonical = { $comment: comment, id: row.key, ...JSON.parse(row.originalText) };
    if (row.correction) {
      const change = row.correction;
      canonical.nation[change.nationIndex][change.cityListIndex].splice(change.removedIndex, 1);
    }
    if (row.unitSet === 'che') {
      if (row.key === '1021') {
        const cities = (canonical.nation as unknown[][]).find(([name]) => name === '도겸')![8] as string[];
        cities.splice(1, 1, '하비', '광릉');
      }
      if (!Object.hasOwn(canonical, 'diplomacy')) Object.assign(canonical, { diplomacy: [] });
      Object.assign(canonical, {
        ...(row.key === '1021' ? { openingCityProfile: 'legacy-research-70' } : { startYear: 180 }),
        lastNationRecruitmentLockYear: 183,
        requiredUnitSet: 'che',
      });
    }
    expect(input[row.key]!.replaceAll('\r\n', '\n')).toBe(JSON.stringify(canonical, null, 2) + '\n');
  });
});
