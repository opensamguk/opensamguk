import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('join_random', () => {
  it('성공', () => verifySuccess('join_random'));
  it('실패', () => verifyFailure('join_random'));
});
