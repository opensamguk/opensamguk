import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('invite', () => {
  it('성공', () => verifySuccess('invite'));
  it('실패', () => verifyFailure('invite'));
});
