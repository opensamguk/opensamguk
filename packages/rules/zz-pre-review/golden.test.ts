import { expect, it } from 'vitest';
import { hashState } from '../../shared/src/node/hashState';
import { commandInitial as preInitial, testUnits as preUnits } from './test/commandFixture';
import { initialReplayState as preInitialReplay, runReplayAction as preRun } from './src/replay';
import { commandInitial, testUnits } from '../test/commandFixture';
import { initialReplayState, runReplayAction } from '../src/replay';
import { createCommandResolver } from '../src/commands/resolve';
import { createExtStateWithRegistry, cloneExtStateWithRegistry } from '../src/commands/ext/state';
import { commandWorld } from '../test/commandFixture';

function months(init: () => any, run: (r: any) => any) {
  let replay = init();
  const hashes: string[] = [];
  while (replay.monthlyTick < 120000) {
    const prior = replay.monthlyTick;
    replay = run(replay);
    if (replay.monthlyTick !== prior) hashes.push(hashState(replay));
  }
  return hashes;
}

it('pre-change 0115e6b and HEAD produce identical 12-month hashes', () => {
  const pre = months(() => preInitialReplay(preInitial()), (r) => preRun(r, 't4-02-golden', preUnits));
  const head = months(() => initialReplayState(commandInitial()), (r) => runReplayAction(r, 't4-02-golden', testUnits));
  const headNull = months(
    () => initialReplayState(commandInitial()),
    (r) => runReplayAction(r, 't4-02-golden', testUnits, createCommandResolver(null)),
  );
  console.log('PRE_LAST', pre.length, pre.at(-1));
  expect(head).toEqual(pre);
  expect(headNull).toEqual(pre);
  // second seed, not used by the implementer
  const pre2 = months(() => preInitialReplay(preInitial()), (r) => preRun(r, 'review-seed-2', preUnits));
  const head2 = months(
    () => initialReplayState(commandInitial()),
    (r) => runReplayAction(r, 'review-seed-2', testUnits, createCommandResolver(null)),
  );
  expect(head2).toEqual(pre2);
}, 300000);

it('aliasing probe: shared object inside one slice survives create/clone', () => {
  const inner = { n: 1 };
  const registry = {
    slices: [{ key: 's', create: () => ({ a: inner, b: inner }), clone: (v: any) => structuredClone(v), validate: (v: unknown): v is any => true }],
    bindings: [{ commandKey: 't', target: 'general' as const, sliceKeys: ['s'] }],
  };
  const ext = createExtStateWithRegistry({ general: ['t'], nation: [] }, commandWorld(), registry as any)!;
  const cloned = cloneExtStateWithRegistry(ext, registry as any);
  const s = cloned.s as any;
  console.log('ALIAS_AFTER_CLONE', s.a === s.b);
  s.a.n = 2;
  const roundTrip = JSON.parse(JSON.stringify(ext)).s;
  roundTrip.a.n = 2;
  console.log('LIVE_B', s.b.n, 'ROUNDTRIP_B', roundTrip.b.n);
});
