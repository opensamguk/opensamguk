import { describe, expect, it } from 'vitest';
import { parseCommitMetrics } from './metricFiles';
import type { LoadCommitMetric } from './report';

const metric: LoadCommitMetric = {
  version: 1,
  sampleKind: 'post-commit-upper-bound',
  worldId: '00000000-0000-4000-8000-000000000001',
  tick: 10000,
  sequence: 1,
  kind: 'monthly',
  valid: true,
  dueAt: 60000,
  clockEpochAt: 0,
  commitObservedAt: 60025,
  lagMs: 25,
};

describe('L3 엔진 JSONL 전체 읽기', () => {
  it('모든행과중복을그대로보존한다', () => {
    const line = JSON.stringify(metric) + '\n';
    expect(parseCommitMetrics(line + line)).toEqual([metric, metric]);
  });
  it('명시invalid표본도삭제하지않는다', () => {
    const invalid = { ...metric, valid: false, lagMs: null, invalidReason: 'database-clock' as const };
    expect(parseCommitMetrics(JSON.stringify(invalid) + '\n')).toEqual([invalid]);
  });
  it.each(['', JSON.stringify(metric), JSON.stringify(metric) + '\n\n'])('비어있거나잘린원자료는거부한다', (text) => {
    expect(() => parseCommitMetrics(text)).toThrow(/LOAD_METRIC_/);
  });
  it('잘못된한행을건너뛰거나입력원문을에러에복사하지않는다', () => {
    const canary = 'metric-private-canary';
    let message = '';
    try {
      parseCommitMetrics(JSON.stringify(metric) + '\n{"x":' + canary + '\n');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('LOAD_METRIC_JSONL_INVALID');
    expect(message.includes(canary)).toBe(false);
  });
  it('DTO판이나표본종류를정확commit으로바꾸지않는다', () => {
    expect(() => parseCommitMetrics(JSON.stringify({ ...metric, sampleKind: 'exact-commit' }) + '\n')).toThrow(
      'LOAD_METRIC_DTO_INVALID',
    );
  });
});
