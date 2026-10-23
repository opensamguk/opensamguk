import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { loadReplayState } from '../src/monthly';
import { TurnLoop } from '../src/turnLoop';
import { acquireLease, releaseLease } from '../src/lease';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const worldId = process.argv[2];
if (!worldId) throw new Error('월드 ID가 필요합니다.');
const db = createDb(url);
try {
  const beforeHash = hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)));
  if (process.argv[3] !== undefined) {
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('시험 월드 실행권이 없습니다.');
    try {
      await new TurnLoop(db, lease).advanceTo(Number(process.argv[3]));
    } finally {
      await releaseLease(db, lease);
    }
  }
  const replay = await db.$transaction((tx) => loadReplayState(tx, worldId));
  console.log(JSON.stringify({ beforeHash, afterHash: hashState(replay), presetRules: replay.state.presetRules }));
} finally {
  await db.$disconnect();
}
