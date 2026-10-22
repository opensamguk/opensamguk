import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('defence', () => {
  it('성공', () => verifySuccess('defence'));
  it('실패', () => verifyFailure('defence'));
});
