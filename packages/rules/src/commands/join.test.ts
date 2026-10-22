import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('join', () => {
  it('성공', () => verifySuccess('join'));
  it('실패', () => verifyFailure('join'));
});
