import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('goodwill', () => {
  it('성공', () => verifySuccess('goodwill'));
  it('실패', () => verifyFailure('goodwill'));
});
