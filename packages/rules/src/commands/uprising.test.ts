import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('uprising', () => {
  it('성공', () => verifySuccess('uprising'));
  it('실패', () => verifyFailure('uprising'));
});
