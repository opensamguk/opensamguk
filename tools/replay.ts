import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { exportReplay, replayArchive, replayToEnd } from '../apps/engine/src/replay';

try {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      months: { type: 'string' },
      'to-end': { type: 'boolean', default: false },
      world: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values['to-end'] && (!values.from || values.months !== undefined)) {
    throw new Error('--to-end는 --from과 함께 쓰고 --months와 함께 쓰지 마세요.');
  }
  if (values.from && !values.world && !values.output) {
    const archive: unknown = JSON.parse(await readFile(values.from, 'utf8'));
    if (values['to-end']) {
      const end = replayToEnd(archive);
      console.log(`${end.sequence} ${end.tick} ${end.reason} ${end.year}년 ${end.month}월 ${end.finalStateHash} 일치`);
    } else {
      const hashes = replayArchive(archive, Number(values.months ?? '12'));
      for (const { tick, stateHash } of hashes) console.log(`${tick} ${stateHash} 일치`);
    }
  } else if (values.world && values.output && !values.from) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
    const { createDb } = await import('../packages/db/src/index');
    const db = createDb(process.env.DATABASE_URL);
    try {
      const archive = await exportReplay(db, values.world);
      await writeFile(values.output, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      console.log(`재생 기록 ${archive.months.length}개월을 저장했습니다.`);
    } finally {
      await db.$disconnect();
    }
  } else {
    throw new Error('--from <기록 파일> [--months 12 | --to-end] 또는 --world <월드 ID> --output <새 파일>을 쓰세요.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '재생에 실패했습니다.');
  process.exitCode = 1;
}
