import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('resign', () => {
  it('성공', () => verifySuccess('resign'));
  it('실패', () => verifyFailure('resign'));
});
