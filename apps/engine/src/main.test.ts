import { describe, expect, it } from 'vitest';
import { LeaseLostError } from './lease';
import { engineFailureMessage } from './main';

describe('엔진 오류 출력', () => {
  it('알려진 실행권 상실은 이름과 이유를 출력한다', () => {
    expect(engineFailureMessage(new LeaseLostError())).toBe('[engine] LeaseLostError: 엔진 실행권을 잃었습니다.');
  });

  it('DB 오류에 포함된 연결 정보는 출력하지 않는다', () => {
    const sensitive = 'postgresql://example:private@db.invalid/game';
    expect(engineFailureMessage(new Error(sensitive))).toBe(
      '[engine] 실행 실패. 월드 ID·DB 연결·migration·실행권을 확인하세요.',
    );
  });
});
