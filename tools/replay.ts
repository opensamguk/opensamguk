import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createDb } from '../packages/db/src/index';
import { exportReplay, replayArchive } from '../apps/engine/src/replay';

try {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      months: { type: 'string', default: '12' },
      world: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.from && !values.world && !values.output) {
    const hashes = replayArchive(JSON.parse(await readFile(values.from, 'utf8')), Number(values.months));
    for (const { tick, stateHash } of hashes) console.log(`${tick} ${stateHash} 일치`);
  } else if (values.world && values.output && !values.from) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
    const db = createDb(process.env.DATABASE_URL);
    try {
      const archive = await exportReplay(db, values.world);
      await writeFile(values.output, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      console.log(`재생 기록 ${archive.months.length}개월을 저장했습니다.`);
    } finally {
      await db.$disconnect();
    }
  } else {
    throw new Error('--from <기록 파일> --months 12 또는 --world <월드 ID> --output <새 파일>을 쓰세요.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '재생에 실패했습니다.');
  process.exitCode = 1;
}
