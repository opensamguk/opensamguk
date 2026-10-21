import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('attack', () => {
  it('성공', () => verifySuccess('attack'));
  it('실패', () => verifyFailure('attack'));
});
