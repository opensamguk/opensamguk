import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('donate', () => {
  it('성공', () => verifySuccess('donate'));
  it('실패', () => verifyFailure('donate'));
});
