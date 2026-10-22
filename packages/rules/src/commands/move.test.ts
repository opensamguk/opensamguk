import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('move', () => {
  it('성공', () => verifySuccess('move'));
  it('실패', () => verifyFailure('move'));
});
