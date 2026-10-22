import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_aid', () => {
  it('성공', () => verifySuccess('nation_aid'));
  it('실패', () => verifyFailure('nation_aid'));
});
