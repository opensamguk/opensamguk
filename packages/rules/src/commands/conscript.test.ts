import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('conscript', () => {
  it('성공', () => verifySuccess('conscript'));
  it('실패', () => verifyFailure('conscript'));
});
