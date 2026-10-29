import { describe, expect, it } from 'vitest';
import { assertActionCoverage } from './worker';
import { loadDatabaseUrl } from './server';

describe('L4 독립 DB witness', () => {
  const valid = {
    worldId: 'world',
    lastSequence: 4,
    turns: [
      { sequence: 2, tick: 500 },
      { sequence: 4, tick: 10001 },
    ],
    months: [{ sequence: 3, tick: 10000 }],
    inputs: [{ sequence: 1 }],
  };
  it('실제 root로그/월정산/입력 sequence 분할로 전체 원장을 확인한다', () => {
    expect(assertActionCoverage(valid)).toEqual([
      { worldId: 'world', sequence: 2, tick: 500, kind: 'turn' },
      { worldId: 'world', sequence: 3, tick: 10000, kind: 'monthly' },
      { worldId: 'world', sequence: 4, tick: 10001, kind: 'turn' },
    ]);
  });
  it('metric을 함께 잃어도 DB sequence 공백을 놓치지 않는다', () => {
    expect(() => assertActionCoverage({ ...valid, turns: valid.turns.slice(0, 1) })).toThrow(
      'LOAD_DATABASE_SEQUENCE_MISSING',
    );
  });
  it('중복·다른 종류의 재사용·누락/null sequence를 거부한다', () => {
    expect(() => assertActionCoverage({ ...valid, inputs: [{ sequence: 2 }] })).toThrow();
    expect(() => assertActionCoverage({ ...valid, turns: [{ sequence: null, tick: 0 }] })).toThrow();
    expect(() => assertActionCoverage({ ...valid, lastSequence: 3 })).toThrow();
  });
  it('전용 DB와 postgres 내부호스트만 받으며 잘못된 URL 원문을 노출하지 않는다', () => {
    const runId = 'a'.repeat(32),
      url = `postgresql://load:canary@postgres/opensamguk_load_${runId}_test`;
    expect(loadDatabaseUrl({ LOAD_RUN_ID: runId, DATABASE_URL: url })).toBe(url);
    expect(() => loadDatabaseUrl({ LOAD_RUN_ID: runId, DATABASE_URL: url.replace('postgres/', '127.0.0.1/') })).toThrow(
      'LOAD_DEDICATED_DATABASE_REQUIRED',
    );
    expect(() => loadDatabaseUrl({ LOAD_RUN_ID: runId, DATABASE_URL: 'private-canary-not-url' })).toThrow(
      /^LOAD_DEDICATED_DATABASE_REQUIRED$/,
    );
  });
});
