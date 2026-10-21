import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_capital', () => {
  it('성공', () => verifySuccess('nation_capital'));
  it('실패', () => verifyFailure('nation_capital'));
});
