import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readArchive, replayArchive, type ReplayArchiveV3 } from './replay';

const fixture = async (): Promise<ReplayArchiveV3> =>
  JSON.parse(await readFile(new URL('../test/fixtures/replay-v3.json', import.meta.url), 'utf8'));
it('AC-INT-28 policy is available from creation and twelve months replay identically', async () => {
  const archive = await fixture();
  expect(archive.origin.featureData!.policy).toEqual({ version: 1, turnTermMinutes: 60 });
  expect(archive.inputs.map(({ kind }) => kind)).not.toContain('system.policy.enable');
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
});
it('policy rejects unknown kinds and invalid configuration before replay', async () => {
  const archive = await fixture();
  archive.inputs[2]!.kind = 'unknown';
  archive.inputs[2]!.status = 'REJECTED';
  expect(() => readArchive(archive)).toThrow();
  const valid = await fixture();
  expect(() => readArchive({ ...valid, config: { ...valid.config, outcomeFromSequence: -1 } })).toThrow();
});
it('human policy activity must agree with the recorded processing tick', async () => {
  const archive = await fixture();
  for (const activeTick of [null, -1, 60001]) {
    const broken = structuredClone(archive);
    broken.inputs[2]!.result = { policy: 'farm', activeTick };
    expect(() => replayArchive(broken, 1)).toThrow();
  }
});
it('changing policy results cannot preserve the recorded monthly hashes', async () => {
  const archive = await fixture();
  archive.inputs[2]!.payload = { policy: 'none' };
  archive.inputs[2]!.result = { policy: 'none', activeTick: 0 };
  expect(() => replayArchive(archive, 12)).toThrow();
});
