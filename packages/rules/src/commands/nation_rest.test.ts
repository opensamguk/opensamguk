import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_rest', () => {
  it('성공', () => verifySuccess('nation_rest'));
  it('실패', () => verifyFailure('nation_rest'));
});
