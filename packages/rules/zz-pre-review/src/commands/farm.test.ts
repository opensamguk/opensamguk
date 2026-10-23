import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('farm', () => {
  it('성공', () => verifySuccess('farm'));
  it('실패', () => verifyFailure('farm'));
});
