import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('train', () => {
  it('성공', () => verifySuccess('train'));
  it('실패', () => verifyFailure('train'));
});
