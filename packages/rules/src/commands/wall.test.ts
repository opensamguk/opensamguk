import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('wall', () => {
  it('성공', () => verifySuccess('wall'));
  it('실패', () => verifyFailure('wall'));
});
