import { expect, it } from 'vitest';
import { commandLogLines, nationCommandLogLines } from '../apps/engine/src/logParts';
import { createRng } from '../packages/shared/src/index';
import { createCommandResolver } from '../packages/rules/src/commands/resolve';
import { createGovernanceCommandResolver } from '../packages/rules/src/governance/commands';
import { governanceFixture, vassal } from '../packages/rules/src/governance/testFixture';
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

it.each(['BAD_TARGET', 'PROTECTED', 'VASSAL_BOUND'] as const)(
  'AC-INT-29 실제 국가 명령의 %s 실패는 main의 코드 포함 역사 본문을 보존한다',
  (code) => {
    const state = governanceFixture();
    const base = createCommandResolver(null);
    const resolver = code === 'VASSAL_BOUND' ? createGovernanceCommandResolver(base) : base;
    if (code === 'VASSAL_BOUND') state.governance!.vassals = [vassal(1, 2, 1)];
    if (code === 'PROTECTED')
      state.presetRules = {
        protection: { foundUntilMonths: 0, peaceMonths: 12, maxGeneralsPerNation: null },
        npc: { aggression: 1 },
        boost: { smallWorld: null, lateJoin: null },
      };
    const reward = code === 'BAD_TARGET';
    const key = reward ? 'nation_reward' : 'nation_declare';
    const name = reward ? '포상' : '선전포고';
    const result = resolver.run(
      state,
      { generalId: 1, target: 'nation', tick: 0 },
      key,
      reward ? { generalId: 2, resource: 'gold', amount: 10 } : { nationId: 2 },
      createRng('nation-history'),
    );
    expect(result).toMatchObject({ code });
    if (!('code' in result)) throw new Error('국가 명령이 실패해야 합니다.');
    expect(nationCommandLogLines(key, name, result)).toMatchObject([
      { text: `${name}: ${code}: ${result.message}`, partsVersion: 1 },
    ]);
    expect(commandLogLines(result)).toMatchObject([{ code, text: result.message }]);
  },
);
