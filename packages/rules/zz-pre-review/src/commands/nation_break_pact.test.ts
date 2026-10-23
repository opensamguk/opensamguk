import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_break_pact', () => {
  it('성공', () => verifySuccess('nation_break_pact'));
  it('실패', () => verifyFailure('nation_break_pact'));
});
