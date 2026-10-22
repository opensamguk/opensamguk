import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('settle', () => {
  it('성공', () => verifySuccess('settle'));
  it('실패', () => verifyFailure('settle'));
});
