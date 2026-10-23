import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('accept_invite', () => {
  it('성공', () => verifySuccess('accept_invite'));
  it('실패', () => verifyFailure('accept_invite'));
});
