import { describe, expect, it } from 'vitest';
import { comparePaths, issue, ReportBuilder } from './issues';

describe('T4-76 진단 상한', () => {
  it('보이지 않는 뒤쪽 오류도 실패 판정에 남는다', () => {
    const out = new ReportBuilder('MAP');
    for (let i = 0; i < 1000; i++) out.add(issue('city-name-blank', { kind: 'city', index: i }, {}, 'warning'));
    out.add(issue('link-missing-city', { kind: 'city', index: 1001 }));
    const result = out.finish(null);
    expect(result).toMatchObject({ status: 'fail', truncated: true });
    expect(result.issues).toHaveLength(1000);
    expect(result.issues.every((item) => item.severity === 'warning')).toBe(true);
  });
  it('숫자 경로와 코드 단위 키 순서를 고정한다', () => {
    const paths = [['x', 10], ['x', 2], ['x', 'a'], ['z'], ['가']];
    expect(paths.sort(comparePaths)).toEqual([['x', 2], ['x', 10], ['x', 'a'], ['z'], ['가']]);
  });
});
