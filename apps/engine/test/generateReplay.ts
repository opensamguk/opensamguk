import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { initialReplayState, runReplayAction } from '@opensamguk/rules';
import { replayArchive, replayToEnd, type ReplayArchiveV3 } from '../src/replay';
import { monthlyFixture } from './monthlyFixture';
import { endYearArchive, recordedArchive } from './replayFixture';

// AC-INT-28 / D-104: pnpm exec tsx apps/engine/test/generateReplay.ts
const initial = await monthlyFixture();
const formatting = await resolveConfig(fileURLToPath(import.meta.url));
const previous = JSON.parse(
  await readFile(new URL('./fixtures/replay-v3.json', import.meta.url), 'utf8'),
) as ReplayArchiveV3;
const inputs = previous.inputs;
let replay = initialReplayState(initial);
let actions = 0;
while (replay.monthlyTick < 120000) {
  replay = runReplayAction(replay, initial.seed, initial.unitSet);
  actions++;
}
const plain = recordedArchive(initial, actions);
const ended = await endYearArchive();
// 입력 적용 뒤에는 방침에 따라 턴 순서가 달라지므로 실제 월간 경계까지 생성한다.
let count = actions + inputs.length;
let current = recordedArchive(initial, count, inputs, 'END_YEAR');
while (current.months.length < 12) current = recordedArchive(initial, ++count, inputs, 'END_YEAR');
while (current.end!.tick > 120000) current = recordedArchive(initial, --count, inputs, 'END_YEAR');
for (const [name, archive] of [
  ['replay-v1-b8f5074.json', plain],
  ['replay-v2-53dd348.json', ended],
  ['replay-v2-engine-53dd348.json', ended],
  ['replay-v3.json', current],
] as const) {
  replayArchive(archive, 12);
  if (archive.end) replayToEnd(archive);
  await writeFile(
    new URL(`./fixtures/${name}`, import.meta.url),
    await format(JSON.stringify(archive), { ...formatting, parser: 'json' }),
  );
}
