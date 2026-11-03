import { describe, expect, it } from 'vitest';
import { HERITAGE_INSUFFICIENT_MESSAGE } from '../apps/web/src/general/heritage';
import { HERITAGE_ERRORS } from '../packages/rules/src/index';

// 화면은 패키지 경계(docs/architecture/package-boundaries.md) 때문에 rules를 읽지 않고 문구만 따로 둔다.
// 두 층에 걸친 문구 대조는 여기서만 한다.
describe('T4-96 AC-P2-33 유산 화면·rules 문구 계약', () => {
  it('즉시 잔액 부족(CONFLICT) 판정 문구가 서버가 보내는 rules 문구와 같다', () => {
    expect(HERITAGE_INSUFFICIENT_MESSAGE).toBe(HERITAGE_ERRORS.HERITAGE_INSUFFICIENT);
  });
});
