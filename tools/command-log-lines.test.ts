import { expect, it } from 'vitest';
import { commandLogLines } from '../apps/engine/src/logParts';
import { runPolicyCommand } from '../packages/rules/src/policy/execute';
import { commandWorld } from '../packages/rules/test/commandFixture';

it.each(['farm', 'none'] as const)('AC-INT-29 실제 %s 방침의 논리적 줄과 실행 결과를 보존한다', (policy) => {
  const state = commandWorld();
  state.generals[1]!.userId = 'human';
  const turn = runPolicyCommand(state, { generalId: 1, tick: 1 }, policy, 'policy');
  const before = structuredClone(turn);
  const lines = commandLogLines(turn.result);
  expect(lines).toHaveLength(policy === 'none' ? 1 : 2);
  expect(lines.map(({ text }) => text)).toEqual(turn.result.logs.map(({ text }) => text));
  expect(lines.every(({ kind }) => kind === 'success')).toBe(true);
  expect(turn).toEqual(before);
});
