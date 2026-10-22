import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { initialReplayState, runReplayAction, buildYearbook, monthlyDate } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { replayArchive, resourceHash, type ReplayArchive } from '../src/replay';
import { monthlyFixture } from './monthlyFixture';

// 기준 코드에서 실행한다: pnpm exec tsx apps/engine/test/generateReplayV1.ts
const baseline = 'b8f50740ae0d383013b4323d10c64c1f743b26af';
for (const path of [
  'apps/engine/src/replay.ts',
  'packages/rules/src/replay.ts',
  'apps/engine/test/monthlyFixture.ts',
]) {
  const original = execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' });
  if ((await readFile(path, 'utf8')) !== original) throw new Error(`기준 커밋과 다릅니다: ${path}`);
}
const initial = await monthlyFixture();
if (initial.generals.some((general) => general.userId !== null)) throw new Error('사용자 식별자가 있습니다.');
const archive: ReplayArchive = {
  version: 1,
  origin: { version: 1, initial, initialStateHash: hashState(initial), resourceHash: resourceHash(initial) },
  inputs: [],
  months: [],
};
let replay = initialReplayState(initial);
let sequence = 0;
while (archive.months.length < 12) {
  replay = runReplayAction(replay, initial.seed, initial.unitSet);
  sequence++;
  if (replay.monthlyTick > (archive.months.at(-1)?.tick ?? 0)) {
    const date = monthlyDate(initial.startYear, replay.monthlyTick);
    archive.months.push({
      tick: replay.monthlyTick,
      ...date,
      sequence,
      stateHash: hashState(replay),
      data: buildYearbook(replay.state, date.year),
    });
  }
}
replayArchive(archive, 12);
await writeFile(new URL('./fixtures/replay-v1-b8f5074.json', import.meta.url), `${JSON.stringify(archive, null, 2)}\n`);
console.log(`${baseline}: ${archive.months.length}개월 검증, ${archive.months.at(-1)!.stateHash}`);
