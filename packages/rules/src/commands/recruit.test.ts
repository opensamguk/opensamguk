import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('recruit', () => {
  it('성공', () => verifySuccess('recruit'));
  it('실패', () => verifyFailure('recruit'));
});
