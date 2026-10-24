import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { warFixture } from '../apps/engine/test/warFixture';
import { resourceHash } from '../apps/engine/src/replay';
import { visibilityFixture } from '../apps/server/test/visibilityFixture';
import { hashState } from '../packages/shared/src/node/hashState';
import baseline from './fixtures/t4-77-baseline.json';

const fixtures = [
  { name: 'monthly', key: 'monthlyFixture', load: monthlyFixture },
  { name: 'war', key: 'warFixture', load: warFixture },
  { name: 'visibility', key: 'visibilitySubset', load: visibilityFixture },
] as const;

describe('T4-77 S1 작은 고정물', () => {
  it.each(fixtures)('$name 고정물은 S0 기준 해시와 수치가 같다', async ({ name, key, load }) => {
    const initial = await load();
    expect({
      initialStateHash: hashState(initial),
      resourceHash: resourceHash(initial),
      cities: initial.cities.length,
      nations: initial.nations.length,
      generals: initial.generals.length,
      diplomacies: initial.diplomacies.length,
      portraits: initial.generals.filter((general) => general.portraitId !== null).length,
    }).toEqual(baseline.fixtures[key]);
    if (name === 'visibility') expect(hashState(initial)).not.toBe(baseline.fixtures.readFixtureFull.initialStateHash);
  });

  it.each(fixtures)('$name 함수는 부를 때마다 깊은 사본을 준다', async ({ name, key, load }) => {
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.cities[0]!.name = '바꾼도시';
    first.generals.length = 0;
    first.unitSet.crewTypes[0]!.name = '바꾼병종';
    if (name === 'war') delete first.nationTurns;
    expect(hashState(second)).toBe(baseline.fixtures[key].initialStateHash);
    expect(hashState(await load())).toBe(baseline.fixtures[key].initialStateHash);
  });

  it('세 고정물 JSON의 $comment에 core2026 출처와 MIT 고지 위치가 있다', async () => {
    for (const path of [
      '../apps/engine/test/fixtures/monthly-initial.json',
      '../apps/engine/test/fixtures/war-initial.json',
      '../apps/server/test/fixtures/visibility-initial.json',
    ]) {
      const fixture = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as { $comment: string };
      expect(fixture.$comment).toContain('core2026 df6c926');
      expect(fixture.$comment).toContain('MIT (c) 2025 devsam');
      expect(fixture.$comment).toContain('resources/NOTICE.md');
    }
  });
});
