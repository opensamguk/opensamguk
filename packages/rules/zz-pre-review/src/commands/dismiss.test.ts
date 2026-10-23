import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('dismiss', () => {
  it('성공', () => verifySuccess('dismiss'));
  it('실패', () => verifyFailure('dismiss'));
});
