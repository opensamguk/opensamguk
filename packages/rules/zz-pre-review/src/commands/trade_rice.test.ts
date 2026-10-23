import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('trade_rice', () => {
  it('성공', () => verifySuccess('trade_rice'));
  it('실패', () => verifyFailure('trade_rice'));
});
