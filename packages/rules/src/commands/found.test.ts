import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('found', () => {
  it('성공', () => verifySuccess('found'));
  it('실패', () => verifyFailure('found'));
});
