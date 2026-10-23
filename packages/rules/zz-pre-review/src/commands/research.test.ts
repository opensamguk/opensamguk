import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('research', () => {
  it('성공', () => verifySuccess('research'));
  it('실패', () => verifyFailure('research'));
});
