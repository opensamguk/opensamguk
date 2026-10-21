import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('morale', () => {
  it('성공', () => verifySuccess('morale'));
  it('실패', () => verifyFailure('morale'));
});
