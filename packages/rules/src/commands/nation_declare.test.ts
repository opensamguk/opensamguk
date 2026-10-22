import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_declare', () => {
  it('성공', () => verifySuccess('nation_declare'));
  it('실패', () => verifyFailure('nation_declare'));
});
