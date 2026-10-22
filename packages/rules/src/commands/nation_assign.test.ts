import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_assign', () => {
  it('성공', () => verifySuccess('nation_assign'));
  it('실패', () => verifyFailure('nation_assign'));
});
