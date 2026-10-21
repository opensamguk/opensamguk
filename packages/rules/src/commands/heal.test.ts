import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('heal', () => {
  it('성공', () => verifySuccess('heal'));
  it('실패', () => verifyFailure('heal'));
});
