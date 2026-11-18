import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { checkRuleFeatures } from '@opensamguk/rules';
import { readArchive, replayArchive, replayToEnd, resourceHashV3 } from './replay';
import { featureArchive, featureRegistry } from '../test/replayFeaturesFixture';
import { endYearArchive, rejectedInput } from '../test/replayFixture';

it('AC-INT-28 current golden replays twelve months and the terminal event', async () => {
  const archive = JSON.parse(await readFile(new URL('../test/fixtures/replay-v3.json', import.meta.url), 'utf8'));
  expect(replayArchive(archive, 12)).toEqual(
    archive.months.map(({ tick, stateHash }: { tick: number; stateHash: string }) => ({ tick, stateHash })),
  );
  expect(replayToEnd(archive)).toEqual(archive.end);
});
it('AC-INT-28 five input combinations use the complete registry', async () => {
  const hashes = [];
  for (const inputs of [[], ['test-a'], ['test-b'], ['test-a', 'test-b'], ['test-a', 'test-c']]) {
    const archive = await featureArchive(inputs);
    expect(replayArchive(archive, 12, featureRegistry)).toEqual(
      archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
    );
    hashes.push(archive.months.at(-1)!.stateHash);
    expect(archive.origin.initial).not.toHaveProperty('ruleFeatures');
  }
  expect(new Set(hashes).size).toBe(5);
});
it.each([
  [],
  null,
  'test-a',
  ['Test-a'],
  ['test-a', 'test-a'],
  ['test-b', 'test-a'],
  ['unknown'],
  ['test-c'],
  ['test-b', 'test-d'],
])('registry rejects malformed dependency/conflict/order list %j', (value) => {
  expect(() => checkRuleFeatures(value, featureRegistry)).toThrow();
});
it('F6-F10 resource data changes the resource hash and is validated', async () => {
  const archive = await featureArchive(['test-a']);
  const old = archive.origin.resourceHash;
  archive.origin.featureData!['test-a'] = 'fixture';
  archive.origin.resourceHash = resourceHashV3(archive.origin);
  expect(archive.origin.resourceHash).not.toBe(old);
  expect(replayArchive(archive, 12, featureRegistry)).toHaveLength(12);
  archive.origin.featureData!['test-a'] = 'wrong';
  archive.origin.resourceHash = resourceHashV3(archive.origin);
  expect(() => readArchive(archive, featureRegistry)).toThrow();
});
it.each(['rejected', 'afterEnd', 'other', 'direct'])('F16 validates %s inputs before replay', async (target) => {
  const archive = await featureArchive(['test-a', 'test-b']);
  const index = target === 'direct' ? 2 : target === 'other' ? 3 : 1;
  const input = { ...archive.inputs[index]!, payload: { value: '#' }, status: 'REJECTED' as const };
  if (target === 'afterEnd') {
    archive.end = {
      sequence: archive.months.at(-1)!.sequence + 1,
      tick: 120001,
      reason: 'UNIFIED',
      winnerNationId: 1,
      year: 192,
      month: 1,
      finalStateHash: 'unused',
    };
    archive.afterEnd = [{ ...input, sequence: archive.end.sequence + 1 }];
  } else archive.inputs[index] = input;
  expect(() => readArchive(archive, featureRegistry)).toThrow();
});
it.each([0, 2, 4, 5])('F1-F3 rejects archive/origin version %s', async (version) => {
  const archive = await featureArchive([]);
  expect(() => readArchive({ ...archive, version }, featureRegistry)).toThrow();
  expect(() => readArchive({ ...archive, origin: { ...archive.origin, version } }, featureRegistry)).toThrow();
});
it.each(['extra', 'version', 'initial', 'initialStateHash', 'resourceHash', 'featureData'])(
  'F5 validates origin field %s',
  async (key) => {
    const archive = await featureArchive([]);
    const origin = archive.origin as unknown as Record<string, unknown>;
    if (key === 'extra') origin.extra = true;
    else delete origin[key];
    expect(() => readArchive(archive, featureRegistry)).toThrow();
  },
);
it.each(['initialStateHash', 'resourceHash'] as const)('F10 rejects modified %s', async (key) => {
  const archive = await featureArchive([]);
  archive.origin[key] = 'bad';
  expect(() => readArchive(archive, featureRegistry)).toThrow();
});
it.each(['config', 'end', 'afterEnd'])('F11 rejects missing %s', async (key) => {
  const archive = await featureArchive([]);
  delete (archive as unknown as Record<string, unknown>)[key];
  expect(() => readArchive(archive, featureRegistry)).toThrow();
});
it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null])('F12-F14 rejects queued tick %s', async (tick) => {
  const archive = await featureArchive(['test-a']);
  archive.inputs[1]!.tick = tick as number;
  expect(() => readArchive(archive, featureRegistry)).toThrow();
});
it.each([false, true])('F15 validates the month window for rejected=%s', async (rejected) => {
  const archive = await featureArchive(['test-a']);
  archive.inputs[1]!.tick = 10000;
  if (rejected) archive.inputs[1]!.status = 'REJECTED';
  expect(() => replayArchive(archive, 1, featureRegistry)).toThrow();
});
it('F12-F13 checks afterEnd kind and tick', async () => {
  const archive = await endYearArchive();
  archive.afterEnd = [rejectedInput(archive.end!.sequence + 1)];
  expect(() => readArchive(archive)).not.toThrow();
  archive.afterEnd[0]!.tick = null;
  expect(() => readArchive(archive)).toThrow();
  archive.afterEnd[0]!.tick = 120000;
  archive.afterEnd[0]!.kind = 'unknown';
  expect(() => readArchive(archive)).toThrow();
});
