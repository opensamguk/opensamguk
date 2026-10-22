import { describe, it } from 'vitest';
import { verifySuccess, verifyFailure } from './contracts';

describe('nation_reward', () => {
  it('성공', () => verifySuccess('nation_reward'));
  it('실패', () => verifyFailure('nation_reward'));
});
