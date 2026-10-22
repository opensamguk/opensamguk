import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('rest', () => {
  it('성공', () => verifySuccess('rest'));
  it('실패', () => verifyFailure('rest'));
});
