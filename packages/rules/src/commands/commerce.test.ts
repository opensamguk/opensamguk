import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('commerce', () => {
  it('성공', () => verifySuccess('commerce'));
  it('실패', () => verifyFailure('commerce'));
});
