import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_seize', () => {
  it('성공', () => verifySuccess('nation_seize'));
  it('실패', () => verifyFailure('nation_seize'));
});
