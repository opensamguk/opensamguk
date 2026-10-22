import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_peace', () => {
  it('성공', () => verifySuccess('nation_peace'));
  it('실패', () => verifyFailure('nation_peace'));
});
