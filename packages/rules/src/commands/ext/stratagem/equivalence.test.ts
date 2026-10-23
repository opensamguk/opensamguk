// S8 기준 파일의 읽기·쓰기는 시험에만 필요하다. 제품 규칙에는 파일 접근을 넣지 않는다.
// eslint-disable-next-line no-restricted-imports
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { format } from 'prettier';
import { createRng, type Rng } from '@opensamguk/shared';
import { commandWorld } from '../../../../test/commandFixture';
import { createCommandResolverWithCommands } from '../../resolve';
import { stratagemCommands } from './index';

const baseSha = '2dccb0f6b85970a858ac44985f36aa47006feed2';
const fixture = new URL('./__fixtures__/equivalence.baseline.json', import.meta.url);
const enabled = { general: stratagemCommands.map((def) => def.key), nation: [] };
const resolver = createCommandResolverWithCommands(enabled, stratagemCommands);
const actor = { generalId: 1, tick: 0 };
const args = { cityKey: 2 };

function world() {
  const state = commandWorld();
  for (const general of Object.values(state.generals)) if (general.id !== 1) general.cityKey = 3;
  Object.assign(state.cities[2]!, {
    agriculture: 900,
    commerce: 800,
    defence: 700,
    wall: 600,
    security: 500,
    level: 4,
  });
  return state;
}

function assertJson(value: unknown, path = '$'): void {
  if (value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))))
    throw new Error(`JSON으로 보존할 수 없는 값: ${path}`);
  if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) assertJson(child, `${path}.${key}`);
}

function capture() {
  const cases = stratagemCommands.flatMap((def) =>
    (['success', 'probability-failure', 'precheck-failure'] as const).map((scenario) => {
      const state = world();
      const seed = scenario === 'probability-failure' ? 'seed-1' : 'stratagem-success';
      if (scenario === 'precheck-failure') Object.assign(state.generals[1]!, { gold: 0, rice: 0 });
      const source = createRng(seed);
      const trace: { call: string; value: number }[] = [];
      const rng: Rng = {
        next() {
          const value = source.next();
          trace.push({ call: 'next', value });
          return value;
        },
        int(min, max) {
          const value = source.int(min, max);
          trace.push({ call: `int(${min},${max})`, value });
          return value;
        },
        pick() {
          throw new Error('계략은 pick을 쓰지 않습니다.');
        },
      };
      const check = def.check(state, actor, args);
      const precheck = def.precheck(state, actor, args);
      const result = resolver.run(state, actor, def.key, args, rng);
      let executeError: string | null = null;
      if (scenario === 'precheck-failure') {
        expect(result).toMatchObject({ code: 'NO_GOLD' });
        expect(trace).toStrictEqual([]);
        try {
          def.execute(state, actor, args, rng);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          executeError = error.message;
        }
        expect(executeError).toBe('금이 부족합니다.');
        expect(trace).toStrictEqual([]);
      } else {
        expect(check).toBeNull();
        expect(precheck).toBeNull();
        expect('code' in result).toBe(false);
        expect(trace[0]?.call).toBe('next');
      }
      const next = [source.next(), source.next(), source.next()];
      if (scenario === 'precheck-failure') {
        const fresh = createRng(seed);
        expect(next).toStrictEqual([fresh.next(), fresh.next(), fresh.next()]);
      }
      return { key: def.key, scenario, seed, result, check, precheck, executeError, trace, next };
    }),
  );
  const record = { baseSha, caseCount: cases.length, cases };
  assertJson(record);
  return record;
}

describe('stratagem B equivalence', () => {
  it('변경 전 열두 결과와 RNG 호출·다음 값을 보존한다', async () => {
    const record = capture();
    expect(record.caseCount).toBe(12);
    if (process.env.STRATAGEM_EQUIVALENCE_WRITE === '1') {
      mkdirSync(new URL('./__fixtures__/', import.meta.url), { recursive: true });
      writeFileSync(fixture, await format(JSON.stringify(record), { parser: 'json', printWidth: 120 }));
    }
    expect(record).toStrictEqual(JSON.parse(readFileSync(fixture, 'utf8')));
  });
});
