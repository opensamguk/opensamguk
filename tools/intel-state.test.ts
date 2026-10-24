import { expect, it } from 'vitest';
import { createRng } from '../packages/shared/src/rng';
import { hashState } from '../packages/shared/src/node/hashState';
import { commandWorld } from '../packages/rules/test/commandFixture';
import { cloneWorldWithRegistry } from '../packages/rules/src/model/clone';
import { intelBindings, intelSlices } from '../packages/rules/src/commands/ext/intel';
import { makeSpyCommand } from '../packages/rules/src/commands/ext/intel/spy';
import { createExtStateWithRegistry } from '../packages/rules/src/commands/ext/state';

// Node 해시 모듈은 rules의 실행 코드에 넣지 않고 도구 시험에서만 쓴다.
it('AC-P2-07 V9 첩보 결과는 JSON 왕복 뒤에도 같은 상태 해시다', () => {
  const registry = { slices: intelSlices, bindings: intelBindings };
  const state = commandWorld();
  state.ext = createExtStateWithRegistry({ general: ['spy'], nation: [] }, state, registry)!;
  const spy = makeSpyCommand((view) => cloneWorldWithRegistry(view, registry));
  for (const from of [1, 4, 99]) {
    state.generals[1]!.cityKey = from;
    const result = spy.execute(state, { generalId: 1, tick: 100 }, { cityKey: 2 }, createRng('intel-json'));
    const effect = result.effects[0]!;
    if (effect.kind !== 'world') throw new Error('월드 효과가 필요합니다.');
    const roundtrip: unknown = JSON.parse(JSON.stringify(effect.state));
    expect(hashState(roundtrip)).toBe(hashState(effect.state));
  }
});
