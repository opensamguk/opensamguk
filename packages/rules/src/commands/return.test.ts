import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('return', () => {
  it('성공', () => verifySuccess('return'));
  it('실패', () => verifyFailure('return'));
});
