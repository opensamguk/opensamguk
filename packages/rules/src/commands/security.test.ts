import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('security', () => {
  it('성공', () => verifySuccess('security'));
  it('실패', () => verifyFailure('security'));
});
