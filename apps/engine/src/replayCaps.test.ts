import { expect, it, vi } from 'vitest';
import { hashState } from '@opensamguk/shared/node';
import { exportReplay, readArchive, replayArchive, replayToEnd, resourceHashV3 } from './replay';
import { monthlyFixture } from '../test/monthlyFixture';
import { exportDatabase } from '../test/replayFeaturesFixture';
import { treatyArchive, rejectedInput, recordedArchive } from '../test/replayFixture';

// AC-INT-28 / D-104: archive6 assertions now exercise format3, with all rules provided.
it('replays twelve treaty months and terminal state deterministically', async () => {
  const archive = await treatyArchive();
  expect(archive.version).toBe(3);
  expect(replayArchive(archive, 12)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  expect(replayToEnd(JSON.parse(JSON.stringify(archive)))).toEqual(archive.end);
  expect(replayArchive(archive, 12)).toEqual(replayArchive(archive, 12));
});
it.each(['initialStateHash', 'resourceHash'] as const)('rejects changed origin hash %s', async (key) => {
  const archive = await treatyArchive();
  archive.origin[key] = 'bad';
  expect(() => readArchive(archive)).toThrow();
});
it.each(['end', 'afterEnd', 'config', 'origin', 'months', 'inputs'])('rejects missing %s', async (key) => {
  const archive = await treatyArchive();
  delete (archive as unknown as Record<string, unknown>)[key];
  expect(() => readArchive(archive)).toThrow();
});
it.each([1, 2, 5, 6])('rejects current origin mixed with archive %s', async (version) => {
  const archive = await treatyArchive();
  expect(() => readArchive({ ...archive, version })).toThrow();
});
it.each(['tick', 'year', 'month', 'sequence', 'stateHash', 'data'])('rejects corrupt monthly %s', async (key) => {
  const archive = await treatyArchive();
  const row = archive.months[0] as unknown as Record<string, unknown>;
  row[key] = key === 'data' ? {} : key === 'stateHash' ? hashState(null) : -1;
  expect(() => replayArchive(archive, 1)).toThrow();
});
it.each(['tick', 'year', 'month', 'sequence', 'finalStateHash', 'winnerNationId', 'reason'])(
  'rejects corrupt terminal %s',
  async (key) => {
    const archive = await treatyArchive();
    (archive.end as unknown as Record<string, unknown>)[key] =
      key === 'finalStateHash' ? hashState(null) : key === 'reason' ? 'UNIFIED' : -1;
    expect(() => replayToEnd(archive)).toThrow();
  },
);
it('recalculates applied treaty results and validates global sequence and tick order', async () => {
  const archive = await treatyArchive();
  for (const mutate of [
    (a: typeof archive) => {
      a.inputs[1]!.result = {};
    },
    (a: typeof archive) => {
      a.inputs.reverse();
    },
    (a: typeof archive) => {
      a.inputs[1]!.tick = 10000;
    },
    (a: typeof archive) => {
      a.inputs[1]!.kind = 'unknown';
    },
  ]) {
    const broken = structuredClone(archive);
    mutate(broken);
    expect(() => replayToEnd(broken)).toThrow();
  }
});
it('checks rejected afterEnd inputs without applying them', async () => {
  const archive = await treatyArchive();
  archive.afterEnd = [rejectedInput(archive.end!.sequence + 1)];
  expect(replayToEnd(archive)).toEqual(archive.end);
  archive.afterEnd[0]!.status = 'APPLIED';
  expect(() => readArchive(archive)).toThrow();
});
it('checks only requested month hashes and binds feature data into the resource hash', async () => {
  const archive = await treatyArchive();
  archive.months[11]!.stateHash = 'bad';
  expect(replayArchive(archive, 1)).toHaveLength(1);
  expect(() => replayArchive(archive, 12)).toThrow();
  archive.origin.featureData!.policy = { version: 1, turnTermMinutes: 30 };
  expect(resourceHashV3(archive.origin)).not.toBe(archive.origin.resourceHash);
  expect(() => readArchive(archive)).toThrow();
});

it('E1-E2 exports current archives and rejects corrupt closed treaty rows', async () => {
  const archive = await treatyArchive();
  const fixture = exportDatabase(archive);
  expect(await exportReplay(fixture.db, 'baseline')).toEqual(archive);
  vi.spyOn(fixture.tx.treaty, 'findMany').mockResolvedValueOnce([
    { id: 1, status: 'ENDED', closedSequence: null },
  ] as never);
  await expect(exportReplay(fixture.db, 'baseline')).rejects.toThrow();
});
it('E3 exports exactly the monthly coverage of an ongoing archive', async () => {
  const archive = await treatyArchive();
  archive.end = null;
  archive.config.endYear = null;
  archive.months = archive.months.slice(0, 6);
  const exported = await exportReplay(exportDatabase(archive).db, 'baseline');
  expect(exported).toEqual(archive);
  expect(replayArchive(exported, 6)).toHaveLength(6);
});
it('E4 does not export inputs before the first monthly coverage', async () => {
  const archive = recordedArchive(await monthlyFixture(), 0);
  expect(await exportReplay(exportDatabase(archive).db, 'baseline')).toEqual(archive);
});
it.each(['version', 'hash', 'descriptor', 'data'])(
  'E5-E8 rejects corrupt origin %s before exporting it',
  async (change) => {
    const archive = await treatyArchive();
    if (change === 'version') (archive.origin as { version: number }).version = 6;
    if (change === 'hash') archive.origin.initialStateHash = 'bad';
    if (change === 'descriptor') Object.assign(archive.origin, { capabilities: { version: 1 } });
    if (change === 'data') archive.origin.featureData = {};
    await expect(exportReplay(exportDatabase(archive).db, 'baseline')).rejects.toThrow();
  },
);
it('E6 rejects applied afterEnd events and invalid processing ticks', async () => {
  const archive = await treatyArchive();
  archive.afterEnd = [{ ...rejectedInput(archive.end!.sequence + 1), status: 'APPLIED' }];
  await expect(exportReplay(exportDatabase(archive).db, 'baseline')).rejects.toThrow();
  archive.afterEnd[0]!.status = 'REJECTED';
  archive.afterEnd[0]!.tick = -1;
  await expect(exportReplay(exportDatabase(archive).db, 'baseline')).rejects.toThrow();
});
